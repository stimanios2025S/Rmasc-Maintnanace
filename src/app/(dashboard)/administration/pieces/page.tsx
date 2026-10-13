"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { Check, Loader2, PackageSearch, Printer, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { enumLabel } from "@/lib/ui/enum-labels";
import { awaitsDecision, transitionRefusal } from "@/lib/parts/status";
import type { PartRequirementStatus } from "@/types";

/**
 * Le tableau des pièces à commander, pour le bureau.
 *
 * CE QU'IL AJOUTE
 * Le panneau des demandes de pièces existait, mais **seulement à l'intérieur
 * d'un bon de travail**. Le bureau n'avait donc aucune vue d'ensemble : pour
 * savoir ce qui attendait une décision, il fallait ouvrir les bons un par un —
 * c'est-à-dire ne pas le faire. Une pièce demandée depuis un toit attendait une
 * décision que personne ne voyait.
 *
 * `/api/parts-replacement?status=PENDING` savait déjà répondre. Rien ne
 * l'appelait.
 *
 * LES ACTIONS SUIVENT LA MÊME RÈGLE QUE LA ROUTE
 * `transitionRefusal` décide quels boutons s'affichent, et la route applique la
 * même fonction. Un écran qui proposerait une action que la route refuse est un
 * défaut que ce dépôt corrige à chaque fois qu'il le rencontre.
 *
 * CE QU'IL NE FAIT PAS
 * Il ne modifie ni la quantité ni la désignation d'une demande : ce que le
 * technicien a constaté sur l'appareil ne se réécrit pas depuis un bureau. Seule
 * la décision se prend ici.
 */

interface PartRow {
  id: string;
  number: string;
  status: PartRequirementStatus;
  urgency: string;
  quantity: number;
  faultyPartName: string;
  faultyPartReference: string | null;
  replacementPartName: string;
  replacementPartReference: string | null;
  notes: string | null;
  createdAt: string;
  statusChangedAt: string | null;
  fulfilledAt: string | null;
  workOrderId: string;
  requestedBy: { id: string; name: string } | null;
  workOrder: {
    orderNumber: string;
    title: string;
    elevator: {
      id: string;
      elevatorCode: string;
      building: { id: string; name: string; city: string };
    };
  };
}

/**
 * Les onglets, dans l'ordre du travail.
 *
 * « En attente » et « validées » d'abord : ce sont les deux états qui appellent
 * une action — décider, puis commander. Les suivants n'appellent plus rien,
 * c'est du suivi.
 */
const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: "", label: "Toutes" },
  { key: "PENDING", label: "À décider" },
  { key: "APPROVED", label: "À commander" },
  { key: "ORDERED", label: "Commandées" },
  { key: "FULFILLED", label: "Posées" },
  { key: "REJECTED", label: "Refusées" },
];

const STATUS_BADGE: Record<PartRequirementStatus, string> = {
  PENDING:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  APPROVED: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  ORDERED:
    "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  FULFILLED:
    "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  REJECTED: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
};

/** Le style commun des petits boutons d'action. */
const ACTION =
  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50";
const PRIMARY = `${ACTION} bg-blue-600 font-semibold text-white hover:bg-blue-700`;
const SECONDARY = `${ACTION} border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800`;
const QUIET = `${ACTION} text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800`;

export default function PiecesAFournirPage() {
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<PartRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!silent) setLoading(true);
      setError("");
      try {
        const query = status ? `?status=${encodeURIComponent(status)}` : "";
        const res = await fetch(`/api/parts-replacement${query}`);
        if (!res.ok) {
          throw new Error(`L'API des pièces a répondu ${res.status}`);
        }
        const json = await res.json();
        setRows(Array.isArray(json.data) ? json.data : []);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Échec du chargement des demandes"
        );
      } finally {
        setLoading(false);
      }
    },
    [status]
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(
    row: PartRow,
    next: PartRequirementStatus,
    verb: string
  ) {
    /**
     * Le refus est calculé ici d'abord, pour qu'il arrive sans aller-retour et
     * nomme ce qui manque. La route applique exactement la même règle — c'est
     * la même fonction.
     */
    const refusal = transitionRefusal(row.status, next);
    if (refusal) {
      setActionError(refusal);
      setNotice(null);
      return;
    }

    setBusyId(row.id);
    setActionError(null);
    setNotice(null);

    try {
      const res = await fetch("/api/parts-replacement", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, status: next }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          body?.error ?? body?.message ?? "La décision a été refusée."
        );
      }
      setNotice(`${row.number} — ${verb}.`);
      await load({ silent: true });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "L'action a échoué.");
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Le nombre de demandes qui attendent une décision, dans la vue courante.
   *
   * Le test passe par `awaitsDecision` et non par `status === "PENDING"` : c'est
   * la fonction qui porte cette règle, et la recopier ici est exactement ce que
   * le module existe pour éviter. La recopie serait restée juste aujourd'hui,
   * puis serait devenue fausse le jour où un état s'ajoute avant la décision —
   * sans que rien ne le signale, puisque le compte aurait continué de s'afficher.
   */
  const awaiting = useMemo(
    () => rows.filter((row) => awaitsDecision(row.status)).length,
    [rows]
  );

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

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-20 flex-none text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            État
          </span>
          <div
            role="tablist"
            aria-label="Filtrer par état"
            className="flex flex-wrap gap-1.5"
          >
            {STATUS_FILTERS.map((option) => (
              <button
                key={option.key || "toutes"}
                type="button"
                role="tab"
                aria-selected={status === option.key}
                onClick={() => setStatus(option.key)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  status === option.key
                    ? "bg-blue-600 text-white"
                    : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-gray-200 pt-4 dark:border-gray-800">
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {rows.length} demande{rows.length > 1 ? "s" : ""}
            {status === "PENDING"
              ? " à décider"
              : awaiting > 0
                ? ` · ${awaiting} en attente de décision`
                : ""}
          </span>

          <button
            type="button"
            onClick={() => void load({ silent: true })}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Actualiser
          </button>
        </div>

        {notice && (
          <p
            role="status"
            className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm font-medium text-green-800 dark:bg-green-950/40 dark:text-green-300"
          >
            {notice}
          </p>
        )}
        {actionError && (
          <p
            role="alert"
            className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-800 dark:bg-red-950/40 dark:text-red-300"
          >
            {actionError}
          </p>
        )}
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          title="Aucune demande dans ce filtre"
          hint="Une demande de pièce s'ouvre depuis un bon de travail, sur le terrain."
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const isBusy = busyId === row.id;
            const immediate = row.urgency === "IMMEDIATE";

            return (
              <li key={row.id}>
                <Card
                  className={`p-4 ${
                    immediate
                      ? "border-red-300 dark:border-red-900"
                      : ""
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {immediate && (
                      <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                        Arrêt immédiat
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                        STATUS_BADGE[row.status] ?? STATUS_BADGE.REJECTED
                      }`}
                    >
                      {enumLabel(row.status)}
                    </span>
                    <span className="font-mono text-xs font-semibold text-gray-900 dark:text-white">
                      {row.number}
                    </span>
                    {row.quantity > 1 && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        ×{row.quantity}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">
                      Demandée le{" "}
                      {format(new Date(row.createdAt), "d MMMM yyyy", {
                        locale: fr,
                      })}
                    </span>
                  </div>

                  {/* La pièce défectueuse et sa remplaçante côte à côte : c'est
                      la comparaison qui porte l'information pour qui commande. */}
                  <p className="mt-2 text-sm text-gray-900 dark:text-white">
                    {row.faultyPartName}
                    {row.faultyPartReference ? (
                      <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                        {" "}
                        ({row.faultyPartReference})
                      </span>
                    ) : null}
                    <span className="text-gray-400"> → </span>
                    <span className="font-medium">
                      {row.replacementPartName}
                    </span>
                    {row.replacementPartReference ? (
                      <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                        {" "}
                        ({row.replacementPartReference})
                      </span>
                    ) : null}
                  </p>

                  <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                    <span className="font-mono text-blue-700 dark:text-blue-400">
                      {row.workOrder.elevator.elevatorCode}
                    </span>{" "}
                    · {row.workOrder.elevator.building.name} · bon{" "}
                    <Link
                      href={`/bons-de-travail/${row.workOrderId}`}
                      className="font-mono text-blue-700 underline decoration-dotted underline-offset-2 dark:text-blue-400"
                    >
                      {row.workOrder.orderNumber}
                    </Link>{" "}
                    · demandée par{" "}
                    {row.requestedBy?.name ?? "un compte supprimé"}
                  </p>

                  {row.notes && (
                    <p className="mt-1.5 whitespace-pre-line text-xs text-gray-600 dark:text-gray-400">
                      {row.notes}
                    </p>
                  )}

                  <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                    {row.statusChangedAt && row.status !== "PENDING"
                      ? `${enumLabel(row.status).toLowerCase()} le ${format(
                          new Date(row.statusChangedAt),
                          "d MMMM yyyy",
                          { locale: fr }
                        )}`
                      : "Aucune décision prise."}
                    {row.fulfilledAt
                      ? ` · posée le ${format(
                          new Date(row.fulfilledAt),
                          "d MMMM yyyy",
                          { locale: fr }
                        )}`
                      : ""}
                  </p>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {/*
                      Le bouton qui fait avancer la demande, selon l'état. Les
                      autres n'apparaissent que pour corriger une décision —
                      et `transitionRefusal` refuse ce qui n'aurait pas de sens,
                      ici comme sur la route.
                    */}
                    {row.status === "PENDING" && (
                      <>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void decide(row, "APPROVED", "demande validée")}
                          className={PRIMARY}
                        >
                          {isBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          Valider
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void decide(row, "REJECTED", "demande refusée")}
                          className={QUIET}
                        >
                          Refuser
                        </button>
                      </>
                    )}

                    {row.status === "APPROVED" && (
                      <>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void decide(row, "ORDERED", "commande passée")}
                          className={PRIMARY}
                        >
                          {isBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <PackageSearch className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          Commander
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void decide(row, "FULFILLED", "pièce posée")}
                          className={SECONDARY}
                        >
                          Posée sans commande
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void decide(row, "REJECTED", "demande refusée")}
                          className={QUIET}
                        >
                          Refuser
                        </button>
                      </>
                    )}

                    {row.status === "ORDERED" && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void decide(row, "FULFILLED", "pièce posée")}
                        className={PRIMARY}
                      >
                        {isBusy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        Valider la livraison
                      </button>
                    )}

                    {row.status === "REJECTED" && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void decide(row, "PENDING", "demande rouverte")}
                        className={SECONDARY}
                      >
                        Rouvrir la demande
                      </button>
                    )}

                    {row.status !== "PENDING" && row.status !== "REJECTED" && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void decide(row, "PENDING", "décision retirée")}
                        className={QUIET}
                      >
                        Revenir en attente
                      </button>
                    )}

                    <a
                      href={`/api/parts-replacement/${row.id}/pdf`}
                      className={`${SECONDARY} ml-auto`}
                    >
                      <Printer className="h-3.5 w-3.5" aria-hidden="true" />
                      Imprimer la fiche
                    </a>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
