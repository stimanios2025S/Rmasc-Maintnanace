"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { Check, FileText, Loader2, Send, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { enumLabel } from "@/lib/ui/enum-labels";
import { formatDa } from "@/lib/quotes/totals";
import type { QuoteStatus } from "@/types";

/**
 * La demande de devis, côté client.
 *
 * CE QUE CE PORTAIL CHANGE
 * Un client qui voulait un devis pour un remplacement d'organe lourd le
 * demandait au téléphone. Le bureau le rédigeait à la main et le numérotait dans
 * un classeur — et rien, ensuite, ne permettait de savoir si l'offre avait été
 * acceptée. Ici, la demande part quand le client la fait, et l'offre revient au
 * même endroit.
 *
 * ELLE EST OUVERTE AUX CLIENTS SANS CONTRAT
 * Contrairement aux actions d'intervention, qui réservent la visite périodique
 * aux clients sous contrat, la demande de devis n'est pas filtrée : c'est
 * précisément hors contrat qu'on a besoin d'un prix — une rénovation, une mise
 * en conformité, un remplacement. `isNonContractedClient` existe et est importé
 * par les portails qui *doivent* filtrer ; il ne sert pas ici, et c'est
 * délibéré.
 *
 * CE QU'ELLE NE FAIT PAS
 * Elle n'affiche aucun prix tant que le bureau n'a pas chiffré. Un montant
 * provisoire, une fourchette ou un « à partir de » feraient naître une attente
 * que l'offre démentirait — et un devis est une offre, pas une estimation.
 */

interface QuoteRow {
  id: string;
  number: string;
  status: QuoteStatus;
  createdAt: string;
  decidedAt: string | null;
  need: string;
  building: { name: string };
  elevator: { elevatorCode: string } | null;
  totals: { totalTtc: number };
  lineCount: number;
}

interface BuildingOption {
  id: string;
  name: string;
  city: string;
}

interface ElevatorOption {
  id: string;
  elevatorCode: string;
  buildingId: string;
}

const STATUS_BADGE: Record<QuoteStatus, string> = {
  REQUESTED:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  SENT: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  ACCEPTED:
    "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  REFUSED: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
  CANCELLED: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
};

const INPUT =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 " +
  "placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 " +
  "focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";

/** La longueur minimale du besoin, la même que celle qu'impose la route. */
const NEED_MIN = 10;

export default function ClientDevisPage() {
  const { data: session } = useSession();

  const [rows, setRows] = useState<QuoteRow[]>([]);
  const [buildings, setBuildings] = useState<BuildingOption[]>([]);
  const [elevators, setElevators] = useState<ElevatorOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [formOpen, setFormOpen] = useState(false);
  const [buildingId, setBuildingId] = useState("");
  const [elevatorId, setElevatorId] = useState("");
  const [need, setNeed] = useState("");
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      /**
       * Les trois lectures partent ensemble.
       *
       * Les immeubles et les appareils alimentent le formulaire ; les devis,
       * la liste. Aucune ne dépend des autres — le sélecteur d'appareils est
       * filtré côté navigateur sur l'immeuble choisi, ce qui évite un
       * aller-retour à chaque changement de site.
       */
      const [quotesRes, buildingsRes, elevatorsRes] = await Promise.all([
        fetch("/api/quotes"),
        fetch("/api/buildings"),
        fetch("/api/elevators"),
      ]);

      if (!quotesRes.ok) {
        throw new Error(`L'API des devis a répondu ${quotesRes.status}`);
      }
      const quotes = await quotesRes.json();
      setRows(Array.isArray(quotes.data) ? quotes.data : []);

      if (buildingsRes.ok) {
        const json = await buildingsRes.json();
        setBuildings(
          Array.isArray(json.data)
            ? json.data.map((b: BuildingOption) => ({
                id: b.id,
                name: b.name,
                city: b.city,
              }))
            : []
        );
      }

      if (elevatorsRes.ok) {
        const json = await elevatorsRes.json();
        setElevators(
          Array.isArray(json.data)
            ? json.data.map(
                (e: { id: string; elevatorCode: string; buildingId: string }) => ({
                  id: e.id,
                  elevatorCode: e.elevatorCode,
                  buildingId: e.buildingId,
                })
              )
            : []
        );
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Échec du chargement de vos devis"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Les appareils du site choisi. Vide tant qu'aucun immeuble ne l'est. */
  const elevatorsOfBuilding = useMemo(
    () => elevators.filter((unit) => unit.buildingId === buildingId),
    [elevators, buildingId]
  );

  // Changer d'immeuble remet l'appareil à zéro : garder celui d'un autre site
  // ferait échouer la demande, et l'erreur ne se comprendrait pas.
  useEffect(() => {
    setElevatorId("");
  }, [buildingId]);

  async function submit() {
    if (!buildingId) {
      setFormError("Choisissez le site concerné.");
      return;
    }
    if (need.trim().length < NEED_MIN) {
      setFormError(
        "Décrivez le besoin en quelques mots : c'est ce qui permettra de le chiffrer."
      );
      return;
    }

    setSending(true);
    setFormError(null);
    setNotice(null);

    try {
      const res = await fetch("/api/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          buildingId,
          need: need.trim(),
          ...(elevatorId ? { elevatorId } : {}),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          json?.error ?? json?.message ?? "La demande a été refusée."
        );
      }

      setFormOpen(false);
      setNeed("");
      setElevatorId("");
      setNotice(
        `Demande ${json?.data?.number ?? ""} transmise. Le bureau la chiffrera et vous répondra.`.trim()
      );
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "L'envoi a échoué.");
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <LoadingSkeleton rows={3} />
      </div>
    );
  }

  if (error && rows.length === 0) {
    return <ErrorState message={error} onRetry={load} />;
  }

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Mes demandes de devis
            </h2>
            <p className="mt-0.5 max-w-2xl text-sm text-gray-500 dark:text-gray-400">
              Pour des travaux hors contrat : remplacement d&apos;un organe
              lourd, rénovation de cabine, mise en conformité. Décrivez le
              besoin, nous établissons une offre chiffrée.
            </p>
          </div>

          {!formOpen && (
            <button
              type="button"
              onClick={() => {
                setFormOpen(true);
                setFormError(null);
                setNotice(null);
              }}
              disabled={buildings.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              Demander un devis
            </button>
          )}
        </div>

        {notice && (
          <p
            role="status"
            className="mt-4 flex items-start gap-2 rounded-lg bg-green-50 px-3 py-2 text-sm font-medium text-green-800 dark:bg-green-950/40 dark:text-green-300"
          >
            <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {notice}
          </p>
        )}

        {formOpen && (
          <div className="mt-4 rounded-lg border border-blue-200 bg-white/70 p-4 dark:border-blue-900 dark:bg-gray-900/60">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                  Site concerné
                </span>
                <select
                  value={buildingId}
                  onChange={(event) => setBuildingId(event.target.value)}
                  className={INPUT}
                >
                  <option value="">Choisissez un immeuble…</option>
                  {buildings.map((building) => (
                    <option key={building.id} value={building.id}>
                      {building.name} — {building.city}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-sm">
                <span className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                  Appareil (facultatif)
                </span>
                <select
                  value={elevatorId}
                  onChange={(event) => setElevatorId(event.target.value)}
                  disabled={!buildingId || elevatorsOfBuilding.length === 0}
                  className={`${INPUT} disabled:opacity-50`}
                >
                  <option value="">
                    {buildingId
                      ? "Tout le site"
                      : "Choisissez d'abord un immeuble"}
                  </option>
                  {elevatorsOfBuilding.map((unit) => (
                    <option key={unit.id} value={unit.id}>
                      {unit.elevatorCode}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="mt-3 block text-sm">
              <span className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                Décrivez le besoin
              </span>
              <textarea
                value={need}
                onChange={(event) => setNeed(event.target.value)}
                rows={5}
                placeholder="Ce qui doit être fait, ce que vous avez constaté, ce que vous souhaitez obtenir. Une phrase précise vaut mieux qu'un long texte."
                className={INPUT}
              />
            </label>

            {formError && (
              <p
                role="alert"
                className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-800 dark:bg-red-950/40 dark:text-red-300"
              >
                <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                {formError}
              </p>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={sending}
                onClick={() => void submit()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Send className="h-4 w-4" aria-hidden="true" />
                )}
                Envoyer la demande
              </button>
              <button
                type="button"
                disabled={sending}
                onClick={() => {
                  setFormOpen(false);
                  setNeed("");
                  setFormError(null);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                Annuler
              </button>
            </div>
          </div>
        )}
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          title="Aucune demande de devis"
          hint="Vos demandes et les offres reçues apparaîtront ici."
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.id}>
              <Card className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                      STATUS_BADGE[row.status] ?? STATUS_BADGE.REFUSED
                    }`}
                  >
                    {enumLabel(row.status)}
                  </span>
                  <span className="font-mono text-sm font-semibold text-gray-900 dark:text-white">
                    {row.number}
                  </span>
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {format(new Date(row.createdAt), "d MMMM yyyy", {
                      locale: fr,
                    })}
                  </span>

                  {/* Aucun montant tant que le bureau n'a pas chiffré : un
                      total à zéro se lirait comme une offre à zéro dinar. */}
                  {row.lineCount > 0 && (
                    <span className="ml-auto text-sm font-semibold tabular-nums text-gray-900 dark:text-white">
                      {formatDa(row.totals.totalTtc)}
                    </span>
                  )}
                </div>

                <p className="mt-2 text-sm text-gray-900 dark:text-white">
                  {row.building.name}
                  {row.elevator ? ` · ${row.elevator.elevatorCode}` : ""}
                </p>
                <p className="mt-1 whitespace-pre-line text-sm text-gray-600 dark:text-gray-400">
                  {row.need}
                </p>

                <div className="mt-3 flex flex-wrap gap-2">
                  {row.lineCount > 0 && (
                    <a
                      href={`/api/quotes/${row.id}/pdf`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                      Télécharger le devis
                    </a>
                  )}
                </div>

                {row.status === "SENT" && (
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    Une offre vous a été remise. Pour l&apos;accepter, renvoyez
                    l&apos;exemplaire signé — la mention « Bon pour accord » se
                    trouve au bas du document.
                  </p>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
