"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, FileText, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/states";
import { enumLabel } from "@/lib/ui/enum-labels";
import { formatDa } from "@/lib/quotes/totals";
import type { QuoteStatus } from "@/types";

/**
 * Les devis du portail client, et la décision qui va avec.
 *
 * POURQUOI UN COMPOSANT PARTAGÉ
 * Les deux portails — sous contrat et hors contrat — reçoivent des offres : le
 * second est facturé à l'acte, c'est même là que le devis compte le plus. Un
 * seul composant évite que les deux écrans divergent sur la seule chose qui
 * compte ici : quels états sont décidables, et par quel appel.
 *
 * CE QUE LA ROUTE GARANTIT DÉJÀ
 * `GET /api/quotes` ne rend que les devis du titulaire de la session, et
 * `POST /api/quotes/[id]/decision` refuse toute offre qui n'est pas `SENT` ou
 * qui appartient à quelqu'un d'autre. L'écran n'a donc qu'à cacher les boutons
 * hors `SENT` ; il ne décide pas du droit.
 */

interface QuoteRow {
  id: string;
  number: string;
  status: QuoteStatus;
  need: string;
  sentAt: string | null;
  lineCount: number;
  totals: { totalHt: number; vatAmount: number; totalTtc: number };
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

function formatDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

export function ClientQuotesCard({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean }) {
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      // `no-store` côté navigateur : une offre créée au bureau il y a dix
      // secondes doit apparaître au premier retour sur l'onglet, pas à la
      // prochaine purge du cache HTTP.
      const res = await fetch("/api/quotes?limit=20", { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`Impossible de charger vos devis (${res.status})`);
      }
      const json = await res.json();
      setQuotes(Array.isArray(json?.data) ? json.data : []);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Impossible de charger vos devis."
      );
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Relit la liste quand l'onglet redevient actif.
   *
   * Le portail est souvent laissé ouvert pendant que le bureau chiffre : sans
   * cette relecture, la nouvelle offre n'apparaît qu'au rechargement manuel —
   * exactement ce qui donne l'impression qu'elle n'a pas été créée.
   */
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  async function decide(row: QuoteRow, action: "ACCEPT" | "REFUSE") {
    setDecidingId(row.id);
    setNotice("");
    setActionError("");

    try {
      const res = await fetch(`/api/quotes/${row.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: action }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          payload?.error ?? `La décision a été refusée (${res.status}).`
        );
      }

      const nextStatus: QuoteStatus =
        action === "ACCEPT" ? "ACCEPTED" : "REFUSED";
      setQuotes((current) =>
        current.map((quote) =>
          quote.id === row.id ? { ...quote, status: nextStatus } : quote
        )
      );
      setNotice(
        action === "ACCEPT"
          ? `Devis ${row.number} accepté.`
          : `Devis ${row.number} refusé.`
      );
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "La décision a échoué.");
    } finally {
      setDecidingId(null);
    }
  }

  if (hideWhenEmpty && loaded && quotes.length === 0 && !error) return null;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-white">
          <FileText className="h-5 w-5 text-gray-400" aria-hidden="true" />
          Mes devis
        </h2>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Actualiser
        </button>
      </div>

      {notice && (
        <p className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950/40 dark:text-green-300">
          {notice}
        </p>
      )}
      {actionError && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300">
          {actionError}
        </p>
      )}

      {error ? (
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">{error}</p>
      ) : !loaded ? (
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
          Chargement des devis…
        </p>
      ) : quotes.length === 0 ? (
        <EmptyState
          className="mt-4"
          icon={FileText}
          title="Aucun devis"
          description="Les offres que nous vous adressons apparaîtront ici, avec la possibilité de les accepter ou de les refuser."
        />
      ) : (
        <ul className="mt-4 divide-y divide-gray-100 dark:divide-gray-800">
          {quotes.map((quote) => (
            <li key={quote.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-mono text-sm font-medium text-gray-900 dark:text-white">
                  {quote.number}
                </p>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    STATUS_BADGE[quote.status] ?? STATUS_BADGE.REFUSED
                  }`}
                >
                  {enumLabel(quote.status)}
                </span>
                {quote.lineCount > 0 && (
                  <span className="ml-auto text-sm font-semibold tabular-nums text-gray-900 dark:text-white">
                    {formatDa(quote.totals.totalTtc)} TTC
                  </span>
                )}
              </div>

              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                {quote.need}
              </p>

              {quote.lineCount > 0 && (
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  TVA incluse
                  {quote.sentAt ? ` · remis le ${formatDay(quote.sentAt)}` : ""}
                </p>
              )}

              {/* Les actions vivent sous l'offre, pas à côté : c'est là qu'un
                  client les cherche après avoir lu le montant, et c'est aussi
                  la seule zone qui change quand l'état change. */}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {quote.lineCount > 0 && (
                  <a
                    href={`/api/quotes/${quote.id}/pdf`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    Télécharger le PDF
                  </a>
                )}

                {quote.status === "SENT" && (
                  <>
                    <button
                      type="button"
                      onClick={() => void decide(quote, "ACCEPT")}
                      disabled={decidingId === quote.id}
                      className="rounded-lg bg-green-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {decidingId === quote.id
                        ? "Envoi…"
                        : "Accepter le devis"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void decide(quote, "REFUSE")}
                      disabled={decidingId === quote.id}
                      className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Refuser
                    </button>
                  </>
                )}

                {quote.status === "REQUESTED" && (
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    En attente de chiffrage par nos services — les boutons
                    Accepter et Refuser apparaîtront dès que l&apos;offre vous
                    sera remise.
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
