"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import {
  CircleCheck,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  Undo2,
  XCircle,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import {
  ActionError,
  ExportButton,
  FilterRow,
  FilterSelect,
  Notice,
  PeriodFilter,
  ResetFiltersButton,
} from "@/components/registers/controls";
import { INVOICE_STATUSES } from "@/types";
import type { InvoiceStatus } from "@/types";
import type { InvoiceRegisterRow } from "@/lib/registers/shapes";
import { invoiceStatusLabel } from "@/lib/ui/enum-labels";
import { formatDzd } from "@/lib/ui/money";

/**
 * Le registre des factures.
 *
 * CE QU'IL AJOUTE
 * `GET /api/invoices` rendait une liste paginée, filtrable par bon et par
 * client, et **aucun écran ne l'appelait** : les factures n'étaient visibles
 * qu'une par une, depuis la fiche du bon qui les avait produites. Retrouver
 * « les factures de ce trimestre » ou « celles qui ne sont pas réglées »
 * demandait donc d'ouvrir les bons un par un — c'est-à-dire de ne pas le faire.
 *
 * Un registre répond à deux questions que la fiche d'un bon ne peut pas porter :
 * *qu'est-ce qui est encore dû ?* et *qu'a-t-on facturé sur cette période ?* La
 * première décide des relances, la seconde se recoupe avec la comptabilité.
 *
 * LE STATUT N'EXISTAIT PAS, IL A ÉTÉ AJOUTÉ AVEC L'ACTION
 * `Invoice` ne portait aucune notion de règlement. Une colonne de statut que
 * personne ne peut poser serait morte — le même piège que la ligne
 * `cabin_load_kg` du peuplement, que son propre commentaire décrit comme un
 * réglage « qui ne faisait rien, en silence ». L'écran qui affiche l'état est
 * donc aussi celui qui le pose.
 *
 * CE QU'IL NE FAIT PAS
 * Il n'émet pas de facture — cela se décide sur la fiche d'un bon, une fois le
 * travail validé — et il ne modifie aucun montant. Un registre constate.
 */

interface Payload {
  data: InvoiceRegisterRow[];
  pagination: { total: number; page: number; limit: number; totalPages: number };
  clients: { id: string; name: string }[];
  totalAmount: string | null;
}

/**
 * Assez large pour qu'un registre se lise d'un écran, assez court pour qu'une
 * page reste une page. Volontairement plus grand que la pagination par défaut de
 * l'API, qui vaut cinquante pour les listes d'exploitation.
 */
const PAGE_SIZE = 100;

/**
 * Le délai avant qu'une frappe ne déclenche la requête.
 *
 * Une recherche se tape, elle ne se colle pas : sans ce délai, « Karim » envoie
 * cinq requêtes et cinq rendus, dont quatre sont affichés puis remplacés. Assez
 * court pour ne pas se sentir, assez long pour qu'une frappe normale n'en
 * produise qu'une.
 */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Les teintes d'état.
 *
 * `ISSUED` est en ambre, et ce n'est pas un jugement sur la facture : c'est ce
 * qu'un registre fait regarder. La question qui ouvre cet écran est « qu'est-ce
 * qui est encore dû ? », et une ligne non réglée est exactement ce qu'on y
 * cherche. Une facture émise n'est pas un problème — elle est une attente.
 */
const STATUS_BADGE: Record<InvoiceStatus, string> = {
  ISSUED:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  PAID: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  CANCELLED: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
};

/**
 * Les états proposés au filtre, dans l'ordre du cycle de vie.
 *
 * Écrits en clair plutôt que dérivés de `enumLabel` : la table des libellés
 * rendrait « Annulé » pour `CANCELLED`, qui est la forme d'un bon de travail.
 * Une facture est un nom féminin — voir `INVOICE_STATUS_LABELS`.
 */
const STATUS_OPTIONS = INVOICE_STATUSES.map((status) => ({
  value: status,
  label: invoiceStatusLabel(status),
}));

export default function FacturesPage() {
  const { data: session } = useSession();
  const role = session?.user?.role;

  /**
   * La même règle que `PATCH /api/invoices`, qui demande `MANAGEMENT_ROLES`.
   * Un bouton et son refus ne doivent jamais se contredire : le registre est
   * ouvert aux rôles de gestion, et c'est aussi ceux qui peuvent y écrire.
   */
  const canEdit = role === "ADMIN" || role === "MAINTENANCE_MANAGER";

  const [status, setStatus] = useState("");
  const [clientId, setClientId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");

  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refusal, setRefusal] = useState<{ message: string; hint?: string } | null>(
    null
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // La frappe est retardée ; le champ reste, lui, instantané.
  useEffect(() => {
    const id = setTimeout(() => setTerm(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search]);

  /**
   * Les paramètres de la requête, construits une fois.
   *
   * Ils servent deux fois — à la liste et au lien d'export — et c'est
   * délibéré : un export qui recalculerait les siens finirait par ne plus
   * décrire le même sous-ensemble que l'écran, au premier filtre ajouté d'un
   * seul côté.
   */
  const params = useMemo(() => {
    const search = new URLSearchParams();
    if (status) search.set("status", status);
    if (clientId) search.set("clientId", clientId);
    if (from) search.set("from", from);
    if (to) search.set("to", to);
    if (term) search.set("q", term);
    return search;
  }, [status, clientId, from, to, term]);

  const hasFilters = [...params.keys()].length > 0;

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!silent) setLoading(true);
      setError("");

      const query = new URLSearchParams(params);
      query.set("limit", String(PAGE_SIZE));

      try {
        const res = await fetch(`/api/invoices?${query.toString()}`);
        const body = await res.json().catch(() => null);

        if (!res.ok) {
          // Le corps d'une erreur porte souvent de quoi agir : une base
          // injoignable dit comment la démarrer. Ces factures n'ont aucun jeu de
          // démonstration, donc c'est le seul message que l'écran aura — autant
          // qu'il soit utile plutôt que « 503 ».
          setRefusal({
            message: body?.error ?? `L'API des factures a répondu ${res.status}`,
            hint: body?.details?.hint,
          });
          setPayload(null);
          return;
        }

        setRefusal(null);
        setPayload(body?.data !== undefined ? body : null);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Échec du chargement des factures"
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
    setStatus("");
    setClientId("");
    setFrom("");
    setTo("");
    setSearch("");
    setTerm("");
  }

  /**
   * Pose un état, et le dit.
   *
   * Le serveur rend la ligne écrite, et c'est elle qui alimente la
   * confirmation : afficher l'état demandé plutôt que l'état obtenu ferait
   * afficher « marquée réglée » sur une écriture que la route a refusée.
   */
  async function setInvoiceStatus(
    row: InvoiceRegisterRow,
    next: InvoiceStatus,
    verb: string
  ) {
    setBusyId(row.id);
    setActionError(null);
    setNotice(null);

    try {
      const res = await fetch("/api/invoices", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, status: next }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(
          body?.error ?? body?.message ?? "Le changement d'état a été refusé."
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

  const rows = payload?.data ?? [];
  const total = payload?.pagination.total ?? 0;
  const totalAmount = payload?.totalAmount ? formatDzd(payload.totalAmount) : null;

  if (loading && !payload && !refusal) {
    return (
      <div className="space-y-6">
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  if (error && !payload) {
    return <ErrorState message={error} onRetry={load} />;
  }

  /**
   * L'état « base injoignable » a son propre rendu.
   *
   * Il ne ressemble pas à une erreur de chargement : il n'y a rien à réessayer
   * tant que la base est arrêtée, et le message du serveur dit quoi faire. Le
   * montrer sous la forme d'un « Réessayer » ferait cliquer pour rien.
   */
  if (refusal && !payload) {
    return (
      <Card className="p-6">
        <div className="flex items-start gap-3">
          <FileText
            className="mt-0.5 h-5 w-5 flex-none text-gray-400"
            aria-hidden="true"
          />
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Registre indisponible
            </h2>
            <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
              {refusal.message}
            </p>
            {refusal.hint && (
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {refusal.hint}
              </p>
            )}
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              Les factures n&apos;ont pas de jeu de démonstration : une facture
              est un document numéroté et figé, et un numéro de pièce comptable
              inventé n&apos;apprendrait rien sur le vrai circuit. Ce registre a
              besoin d&apos;une base réelle.
            </p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Réessayer
            </button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="space-y-4">
          <FilterRow label="Statut">
            <FilterSelect
              id="filtre-statut"
              value={status}
              onChange={setStatus}
              allLabel="Tous les états"
              options={STATUS_OPTIONS}
            />
          </FilterRow>

          <FilterRow label="Client">
            <FilterSelect
              id="filtre-client"
              value={clientId}
              onChange={setClientId}
              allLabel="Tous les clients"
              options={(payload?.clients ?? []).map((client) => ({
                value: client.id,
                label: client.name,
              }))}
            />
          </FilterRow>

          <FilterRow label="Période">
            <PeriodFilter
              from={from}
              to={to}
              onFromChange={setFrom}
              onToChange={setTo}
            />
          </FilterRow>

          <FilterRow label="Recherche">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
                aria-hidden="true"
              />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Numéro, client, immeuble, bon…"
                aria-label="Rechercher dans les factures"
                className="w-72 rounded-lg border border-gray-300 bg-white py-1.5 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
          </FilterRow>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-gray-200 pt-4 dark:border-gray-800">
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {total} facture{total > 1 ? "s" : ""}
            {hasFilters ? " dans ce filtre" : ""}
            {totalAmount ? ` · ${totalAmount}` : ""}
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

          {/*
            Le lien d'export porte les filtres affichés. `download` n'est pas
            posé : le nom du fichier est décidé par le serveur, qui le date, et
            un `download` sans valeur ferait perdre ce nom.
          */}
          <ExportButton href={`/api/invoices?${params.toString()}&format=csv`} />
        </div>

        {notice && <Notice>{notice}</Notice>}
        {actionError && <ActionError>{actionError}</ActionError>}

        {total > rows.length && (
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            {total - rows.length} facture{total - rows.length > 1 ? "s" : ""} de
            plus dans ce filtre. Resserrez la période, ou exportez pour les
            obtenir toutes.
          </p>
        )}
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          title="Aucune facture dans ce filtre"
          hint={
            hasFilters
              ? "Élargissez la période ou effacez les filtres."
              : "Une facture s'émet depuis la fiche d'un bon de travail clôturé."
          }
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const isBusy = busyId === row.id;
            const amount = formatDzd(row.amount);

            return (
              <li key={row.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                        STATUS_BADGE[row.status] ?? STATUS_BADGE.ISSUED
                      }`}
                    >
                      {invoiceStatusLabel(row.status)}
                    </span>

                    <span className="font-mono text-sm font-semibold text-gray-900 dark:text-white">
                      {row.number}
                    </span>

                    <span className="text-sm text-gray-500 dark:text-gray-400">
                      {format(new Date(row.issuedAt), "d MMMM yyyy", { locale: fr })}
                    </span>

                    <span className="ml-auto text-sm font-semibold tabular-nums text-gray-900 dark:text-white">
                      {amount ?? "—"}
                    </span>
                  </div>

                  <p className="mt-2 text-sm text-gray-900 dark:text-white">
                    {row.clientName}
                  </p>
                  <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
                    {row.buildingName}
                  </p>

                  <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                    Bon{" "}
                    <Link
                      href={`/bons-de-travail/${row.workOrderId}`}
                      className="font-mono text-blue-700 underline decoration-dotted underline-offset-2 dark:text-blue-400"
                    >
                      {row.orderNumber}
                    </Link>{" "}
                    · {row.orderTitle}
                  </p>

                  {/*
                    La date du dernier changement d'état, et elle n'est pas
                    décorative : « Réglée » sans date ne permet pas de rapprocher
                    la facture d'un relevé bancaire.
                  */}
                  {row.statusChangedAt && row.status !== "ISSUED" && (
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {invoiceStatusLabel(row.status)} le{" "}
                      {format(
                        new Date(row.statusChangedAt),
                        "d MMMM yyyy 'à' HH:mm",
                        { locale: fr }
                      )}
                    </p>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    {/* Le document, tel qu'il a été émis. Un lien plutôt qu'un
                        `fetch` : le PDF est téléchargé, pas affiché. */}
                    <a
                      href={`/api/invoices/${row.id}/pdf`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                      Télécharger le PDF
                    </a>

                    {canEdit && row.status === "ISSUED" && (
                      <>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            void setInvoiceStatus(row, "PAID", "marquée réglée")
                          }
                          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                        >
                          {isBusy ? (
                            <Loader2
                              className="h-3.5 w-3.5 animate-spin"
                              aria-hidden="true"
                            />
                          ) : (
                            <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          Marquer réglée
                        </button>

                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            void setInvoiceStatus(row, "CANCELLED", "annulée")
                          }
                          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800"
                        >
                          <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                          Annuler
                        </button>
                      </>
                    )}

                    {canEdit && row.status !== "ISSUED" && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          void setInvoiceStatus(
                            row,
                            "ISSUED",
                            row.status === "PAID"
                              ? "règlement retiré"
                              : "facture rouverte"
                          )
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800"
                      >
                        {isBusy ? (
                          <Loader2
                            className="h-3.5 w-3.5 animate-spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        {row.status === "PAID" ? "Retirer le règlement" : "Rouvrir"}
                      </button>
                    )}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {!canEdit && rows.length > 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Marquer une facture réglée ou l&apos;annuler engage la comptabilité de
          l&apos;entreprise : ces actions sont réservées à l&apos;administrateur
          et au responsable maintenance.
        </p>
      )}
    </div>
  );
}
