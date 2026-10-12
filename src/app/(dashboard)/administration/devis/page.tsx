"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { FileText, Loader2, RefreshCw, Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { enumLabel } from "@/lib/ui/enum-labels";
import { formatDa } from "@/lib/quotes/totals";
import { QUOTE_STATUSES } from "@/types";
import type { QuoteStatus } from "@/types";

/**
 * Le registre des devis.
 *
 * CE QU'IL AJOUTE
 * Le module devis savait ouvrir une demande, la chiffrer et imprimer l'offre,
 * et **aucun écran ne l'appelait** : `/api/quotes` n'avait pas un seul
 * consommateur. Un devis ne se lisait donc qu'en connaissant son adresse.
 *
 * CE QU'IL MONTRE EN PREMIER
 * Ce qui n'est pas fait. Le tableau s'ouvre sur toutes les offres, triées par
 * date — mais l'état est la première colonne, et les deux états qui attendent
 * une action sont les seuls à porter une couleur franche : « à chiffrer »
 * attend le bureau, « envoyé » attend le client. Les trois autres sont des
 * issues, et une issue n'appelle rien.
 *
 * LE REGISTRE N'EST PAS UNE FILE DE TRAVAIL
 * Il n'acquitte rien, ne relance personne et ne décide rien. Les décisions se
 * prennent sur la fiche d'un devis, où l'on voit ce qui a été demandé — décider
 * d'un prix depuis une ligne de tableau, sans les lignes sous les yeux, est
 * exactement ce qu'un chiffrage ne doit pas permettre.
 */

interface QuoteRow {
  id: string;
  number: string;
  status: QuoteStatus;
  createdAt: string;
  sentAt: string | null;
  decidedAt: string | null;
  need: string;
  client: { id: string; name: string } | null;
  building: { id: string; name: string; city: string };
  elevator: { id: string; elevatorCode: string } | null;
  totals: { totalHt: number; vatAmount: number; totalTtc: number };
  lineCount: number;
}

/**
 * Les onglets de filtrage, dans l'ordre du travail.
 *
 * « Tous » d'abord parce qu'un registre s'ouvre sur l'ensemble ; puis les deux
 * états qui attendent quelqu'un, dans l'ordre où ils se produisent ; puis les
 * issues. Le même ordre que le poids de tri du module d'état, pour qu'un devis
 * ne change pas de place selon l'écran.
 */
const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: "", label: "Tous" },
  { key: "REQUESTED", label: "À chiffrer" },
  { key: "SENT", label: "Chez le client" },
  { key: "ACCEPTED", label: "Acceptés" },
  { key: "REFUSED", label: "Refusés" },
  { key: "CANCELLED", label: "Annulés" },
];

/**
 * Les teintes d'état.
 *
 * L'ambre et le bleu disent qu'il manque une action ; le vert, le gris et le
 * rouge pâle sont des issues. C'est la seule couleur du tableau qui porte une
 * information — voir l'en-tête.
 */
const STATUS_BADGE: Record<QuoteStatus, string> = {
  REQUESTED:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  SENT: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  ACCEPTED:
    "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  REFUSED: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
  CANCELLED: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
};

/** Le délai avant qu'une frappe ne déclenche la requête. Même valeur qu'ailleurs. */
const SEARCH_DEBOUNCE_MS = 300;

export default function DevisRegisterPage() {
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");

  const [rows, setRows] = useState<QuoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setTerm(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search]);

  const params = useMemo(() => {
    const search = new URLSearchParams();
    if (status) search.set("status", status);
    if (term) search.set("q", term);
    return search;
  }, [status, term]);

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!silent) setLoading(true);
      setError("");
      try {
        const res = await fetch(`/api/quotes?${params.toString()}`);
        if (!res.ok) {
          throw new Error(`L'API des devis a répondu ${res.status}`);
        }
        const json = await res.json();
        setRows(Array.isArray(json.data) ? json.data : []);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Échec du chargement des devis"
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

  const hasFilters = [...params.keys()].length > 0;

  /** La somme des offres encore vivantes — ni refusées, ni annulées. */
  const openTtc = rows
    .filter((row) => row.status === "REQUESTED" || row.status === "SENT")
    .reduce((sum, row) => sum + row.totals.totalTtc, 0);

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
        <div className="space-y-4">
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
                  key={option.key || "tous"}
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

          <div className="flex flex-wrap items-center gap-3">
            <span className="w-20 flex-none text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Recherche
            </span>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
                aria-hidden="true"
              />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Numéro, client, immeuble, besoin…"
                aria-label="Rechercher dans les devis"
                className="w-80 rounded-lg border border-gray-300 bg-white py-1.5 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-gray-200 pt-4 dark:border-gray-800">
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {rows.length} devis{rows.length > 1 ? "" : ""}
            {hasFilters ? " dans ce filtre" : ""}
            {openTtc > 0 ? ` · ${formatDa(openTtc)} en attente` : ""}
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
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          title="Aucun devis dans ce filtre"
          hint={
            hasFilters
              ? "Élargissez l'état ou effacez la recherche."
              : "Une demande de devis arrive depuis le portail client."
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
                      STATUS_BADGE[row.status] ?? STATUS_BADGE.REFUSED
                    }`}
                  >
                    {enumLabel(row.status)}
                  </span>

                  <Link
                    href={`/administration/devis/${row.id}`}
                    className="font-mono text-sm font-semibold text-blue-700 underline decoration-dotted underline-offset-2 dark:text-blue-400"
                  >
                    {row.number}
                  </Link>

                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {format(new Date(row.createdAt), "d MMMM yyyy", {
                      locale: fr,
                    })}
                  </span>

                  <span className="ml-auto text-sm font-semibold tabular-nums text-gray-900 dark:text-white">
                    {row.lineCount === 0
                      ? "à chiffrer"
                      : formatDa(row.totals.totalTtc)}
                  </span>
                </div>

                <p className="mt-2 text-sm text-gray-900 dark:text-white">
                  {row.client?.name ?? "Sans compte client"} ·{" "}
                  {row.building.name}
                  {row.elevator ? (
                    <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                      {" "}
                      ({row.elevator.elevatorCode})
                    </span>
                  ) : null}
                </p>

                <p className="mt-1 line-clamp-2 text-sm text-gray-600 dark:text-gray-400">
                  {row.need}
                </p>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Link
                    href={`/administration/devis/${row.id}`}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
                  >
                    {row.status === "REQUESTED" ? "Chiffrer" : "Ouvrir"}
                  </Link>

                  {row.lineCount > 0 && (
                    <a
                      href={`/api/quotes/${row.id}/pdf`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                      Télécharger le PDF
                    </a>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
