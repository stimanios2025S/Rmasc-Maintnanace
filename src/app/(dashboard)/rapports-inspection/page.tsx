"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { Printer, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import {
  ExportButton,
  FilterRow,
  FilterSelect,
  PeriodFilter,
  ResetFiltersButton,
} from "@/components/registers/controls";
import { INSPECTION_CHECK_RESULTS, REPORT_KINDS } from "@/types";
import type { InspectionCheckResult } from "@/types";
import type { InspectionReportRegisterRow } from "@/lib/registers/shapes";
import { enumLabel } from "@/lib/ui/enum-labels";

/**
 * Le registre des rapports d'inspection.
 *
 * CE QU'IL AJOUTE
 * Un rapport se lisait en ouvrant un bon de travail, ou en connaissant son
 * adresse. Retrouver « les rapports non conformes de cet immeuble ce
 * trimestre » — la seule question qu'un bureau de maintenance pose vraiment à
 * un historique d'inspection — n'était possible par aucun chemin.
 *
 * `GET /api/inspection-reports` rendait bien une liste paginée, et **aucun écran
 * ne l'appelait**.
 *
 * LE LIEN D'IMPRESSION MÈNE AILLEURS, ET C'EST VOULU
 * `/rapports-inspection/[id]` est la seule page de l'application qui ne rend pas
 * la coque : un rapport d'inspection se signe, s'imprime et se classe, et un
 * menu latéral n'a rien à faire sur le papier. Le registre est un écran, la
 * fiche est un document — les deux ont la même adresse et deux vies différentes.
 *
 * LE VERDICT EST LE SEUL JUGEMENT DE CET ÉCRAN
 * `overallResult` est calculé à l'ingestion, « le pire l'emporte » : un seul
 * point non conforme ne peut pas être noyé par des points conformes. Le registre
 * l'affiche tel qu'il est stocké et ne le recalcule jamais — deux calculs du
 * même verdict finiraient par diverger, et c'est celui de la base qui est signé.
 */

/**
 * Les tons du verdict.
 *
 * Les mêmes choix que la fiche imprimée — vert, rouge, ambre, gris — parce que
 * les deux écrans montrent la même donnée et qu'une ligne rouge dans un registre
 * doit être le même rouge que la pastille du document qu'elle ouvre.
 */
const RESULT_BADGE: Record<InspectionCheckResult, string> = {
  PASS: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  FAIL: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  NEEDS_ATTENTION:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  NOT_APPLICABLE:
    "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

const RESULT_OPTIONS = INSPECTION_CHECK_RESULTS.map((result) => ({
  value: result,
  label: enumLabel(result),
}));

/**
 * Les deux feuilles, nommées comme le bureau les nomme.
 *
 * « Entretien mensuel » et non « Entretien » : c'est le nom du formulaire
 * For: APP/DA/04/13, et le mot seul se confond avec l'entretien en général —
 * celui qu'on fait tous les jours sur un appareil.
 */
const KIND_OPTIONS = REPORT_KINDS.map((kind) => ({
  value: kind,
  label: kind === "ENTRETIEN" ? "Entretien mensuel" : "Inspection",
}));

const PAGE_SIZE = 100;

export default function RapportsInspectionPage() {
  const [kind, setKind] = useState("");
  const [result, setResult] = useState("");
  const [technicianId, setTechnicianId] = useState("");
  const [buildingId, setBuildingId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [rows, setRows] = useState<InspectionReportRegisterRow[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [technicians, setTechnicians] = useState<{ id: string; name: string }[]>(
    []
  );
  const [buildings, setBuildings] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  /**
   * Les immeubles, chargés à part et sans conséquence.
   *
   * Ils alimentent un sélecteur, pas le registre : si cette requête échoue — un
   * immeuble n'est pas indispensable pour lire un historique —, la liste reste
   * vide et le filtre n'offre plus que « Tous les immeubles ». Faire échouer
   * l'écran entier parce qu'une liste de choix manque serait disproportionné.
   */
  useEffect(() => {
    let cancelled = false;

    async function loadBuildings() {
      try {
        const res = await fetch("/api/buildings");
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled || !Array.isArray(json.data)) return;
        setBuildings(
          json.data
            .filter(
              (row: { id?: unknown; name?: unknown }) =>
                typeof row.id === "string" && typeof row.name === "string"
            )
            .map((row: { id: string; name: string }) => ({
              id: row.id,
              name: row.name,
            }))
        );
      } catch {
        // Un sélecteur incomplet, pas un écran cassé.
      }
    }

    void loadBuildings();
    return () => {
      cancelled = true;
    };
  }, []);

  const params = useMemo(() => {
    const search = new URLSearchParams();
    if (kind) search.set("kind", kind);
    if (result) search.set("result", result);
    if (technicianId) search.set("technicianId", technicianId);
    if (buildingId) search.set("buildingId", buildingId);
    if (from) search.set("from", from);
    if (to) search.set("to", to);
    return search;
  }, [kind, result, technicianId, buildingId, from, to]);

  const hasFilters = [...params.keys()].length > 0;

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!silent) setLoading(true);
      setError("");

      const query = new URLSearchParams(params);
      query.set("limit", String(PAGE_SIZE));

      try {
        const res = await fetch(`/api/inspection-reports?${query.toString()}`);
        if (!res.ok) {
          throw new Error(
            `L'API des rapports a répondu ${res.status}`
          );
        }
        const json = await res.json();

        setRows(Array.isArray(json.data) ? json.data : []);
        setTotal(typeof json.total === "number" ? json.total : 0);
        setCounts(json.counts && typeof json.counts === "object" ? json.counts : {});
        /**
         * La liste des techniciens vient du serveur, et non d'un appel séparé.
         *
         * Elle est construite sur les rapports que le demandeur peut lire —
         * donc, pour un technicien de terrain, sur les siens : un sélecteur qui
         * proposerait ses collègues lui offrirait un filtre qui ne rendrait
         * jamais rien. Et elle exclut par construction quiconque n'a jamais
         * signé de rapport, ce qu'aucune liste d'utilisateurs ne fait.
         */
        setTechnicians(Array.isArray(json.technicians) ? json.technicians : []);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Échec du chargement des rapports"
        );
      } finally {
        setLoading(false);
      }
    },
    [params]
  );

  useEffect(() => {
    void load();
  }, [load]);

  function resetFilters() {
    setKind("");
    setResult("");
    setTechnicianId("");
    setBuildingId("");
    setFrom("");
    setTo("");
  }

  if (loading && rows.length === 0) {
    return (
      <div className="space-y-6">
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  if (error && rows.length === 0) {
    return <ErrorState message={error} onRetry={load} />;
  }

  const failures = counts.FAIL ?? 0;
  const attention = counts.NEEDS_ATTENTION ?? 0;

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="space-y-4">
          <FilterRow label="Période">
            <PeriodFilter
              from={from}
              to={to}
              onFromChange={setFrom}
              onToChange={setTo}
            />
          </FilterRow>

          <FilterRow label="Immeuble">
            <FilterSelect
              id="filtre-immeuble"
              value={buildingId}
              onChange={setBuildingId}
              allLabel="Tous les immeubles"
              options={buildings.map((building) => ({
                value: building.id,
                label: building.name,
              }))}
            />
          </FilterRow>

          <FilterRow label="Technicien">
            <FilterSelect
              id="filtre-technicien"
              value={technicianId}
              onChange={setTechnicianId}
              allLabel="Tous les techniciens"
              options={technicians.map((technician) => ({
                value: technician.id,
                label: technician.name ?? technician.id,
              }))}
            />
          </FilterRow>

          <FilterRow label="Conformité">
            <FilterSelect
              id="filtre-conformite"
              value={result}
              onChange={setResult}
              allLabel="Tous les verdicts"
              options={RESULT_OPTIONS}
            />
          </FilterRow>

          <FilterRow label="Feuille">
            <FilterSelect
              id="filtre-feuille"
              value={kind}
              onChange={setKind}
              allLabel="Les deux feuilles"
              options={KIND_OPTIONS}
            />
          </FilterRow>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-gray-200 pt-4 dark:border-gray-800">
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {total} rapport{total > 1 ? "s" : ""}
            {hasFilters ? " dans ce filtre" : ""}
            {failures > 0 && (
              <>
                {" · "}
                <span className="font-semibold text-red-700 dark:text-red-400">
                  {failures} non conforme{failures > 1 ? "s" : ""}
                </span>
              </>
            )}
            {attention > 0 && (
              <>
                {" · "}
                <span className="font-semibold text-amber-700 dark:text-amber-400">
                  {attention} à surveiller
                </span>
              </>
            )}
          </span>

          <button
            type="button"
            onClick={() => void load({ silent: true })}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Actualiser
          </button>

          {hasFilters && <ResetFiltersButton onClick={resetFilters} />}

          <ExportButton href={`/api/inspection-reports?${params.toString()}&format=csv`} />
        </div>

        {total > rows.length && (
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            {total - rows.length} rapport{total - rows.length > 1 ? "s" : ""} de
            plus dans ce filtre. Resserrez la période, ou exportez pour les
            obtenir tous.
          </p>
        )}
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          title="Aucun rapport dans ce filtre"
          hint={
            hasFilters
              ? "Élargissez la période ou effacez les filtres."
              : "Un rapport se dépose depuis le portail technicien, à la fin d'une intervention."
          }
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.id}>
              <Card className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                      RESULT_BADGE[row.overallResult] ?? RESULT_BADGE.NOT_APPLICABLE
                    }`}
                  >
                    {enumLabel(row.overallResult)}
                  </span>

                  <span className="font-mono text-sm font-semibold text-gray-900 dark:text-white">
                    {row.reportNumber}
                  </span>

                  {/*
                    La feuille, sur chaque ligne. Sans elle, un registre qui
                    contient les deux séries ne dit pas laquelle on lit, et
                    « Entretien – Remplacement du contacteur » ressemble à une
                    inspection comme une autre.
                  */}
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                    {row.kind === "ENTRETIEN" ? "Entretien mensuel" : "Inspection"}
                  </span>

                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {format(new Date(row.submittedAt), "d MMMM yyyy 'à' HH:mm", {
                      locale: fr,
                    })}
                  </span>

                  <Link
                    href={`/rapports-inspection/${row.id}`}
                    className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    <Printer className="h-3.5 w-3.5" aria-hidden="true" />
                    Ouvrir / imprimer
                  </Link>
                </div>

                <p className="mt-2 text-sm font-medium text-gray-900 dark:text-white">
                  {row.title}
                </p>

                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  <Link
                    href={`/ascenseurs/${row.elevator.id}`}
                    className="font-mono text-blue-700 underline decoration-dotted underline-offset-2 dark:text-blue-400"
                  >
                    {row.elevator.elevatorCode}
                  </Link>{" "}
                  · {row.elevator.building.name}
                  {row.elevator.building.city
                    ? `, ${row.elevator.building.city}`
                    : ""}{" "}
                  · {row.technician.name ?? "auteur inconnu"} · bon{" "}
                  <Link
                    href={`/bons-de-travail/${row.workOrder.id}`}
                    className="font-mono text-blue-700 underline decoration-dotted underline-offset-2 dark:text-blue-400"
                  >
                    {row.workOrder.orderNumber}
                  </Link>
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
