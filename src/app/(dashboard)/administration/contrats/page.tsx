"use client";

/**
 * Le registre des contrats de maintenance.
 *
 * CE QU'IL MONTRE, ET POURQUOI CES COLONNES
 * Une référence, un client, un palier, un état, une échéance. C'est la liste des
 * engagements opposables de l'entreprise, et la question qu'on lui pose en
 * l'ouvrant est toujours la même : « qu'est-ce qui arrive à terme, et qu'est-ce
 * que je dois décider ? ». D'où l'alerte d'échéance à côté de la date, et non
 * dans une fiche qu'il faudrait ouvrir une par une.
 *
 * L'ÉTAT AFFICHÉ EST L'ÉTAT CALCULÉ
 * `effectiveStatus` vient de la route et vaut `EXPIRED` sur un contrat `ACTIVE`
 * dont la date est passée sans reconduction. Filtrer sur l'état *stocké*
 * afficherait donc « en vigueur » dans la colonne et sortirait la ligne du
 * filtre « Échu » — deux réponses contradictoires au même clic. Les filtres
 * portent sur ce que la colonne affiche.
 *
 * L'ALERTE VIENT AUSSI DE LA ROUTE
 * `expiry` est calculé par `expiryAlert`, avec ses deux seuils — préavis et
 * urgence — et la mention de reconduction tacite. Recalculer ici produirait un
 * deuxième avis sur la même échéance ; l'écran ne fait que le rendre.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CalendarClock,
  ChevronRight,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { ContractCreateForm } from "@/components/admin/contract-create-form";
import { enumLabel } from "@/lib/ui/enum-labels";
import { CONTRACT_RENEWAL_MODES, CONTRACT_STATUSES, SLA_TIERS } from "@/types";

// ─── Types de la réponse ────────────────────────────────────

type ContractStatus = (typeof CONTRACT_STATUSES)[number];
type SLATier = (typeof SLA_TIERS)[number];
type RenewalMode = (typeof CONTRACT_RENEWAL_MODES)[number];
type ExpiryLevel = "none" | "notice" | "urgent" | "expired";

interface ContractRow {
  id: string;
  reference: string;
  status: ContractStatus;
  effectiveStatus: ContractStatus;
  slaTier: SLATier;
  startsAt: string;
  endsAt: string;
  effectiveEndsAt: string;
  renewalMode: RenewalMode;
  noticeDays: number;
  billingCycle: string;
  amount: string;
  currency: string;
  responseHours: number;
  interventionHours: number;
  createdAt: string;
  client: { id: string; name: string; email: string };
  buildings: { id: string; name: string; city: string }[];
  expiry: { level: ExpiryLevel; days: number; message: string | null };
}

interface ClientOption {
  id: string;
  name: string;
}

// ─── Présentation ───────────────────────────────────────────

const STATUS_STYLES: Record<ContractStatus, string> = {
  DRAFT:
    "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  ACTIVE:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  SUSPENDED:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  EXPIRED: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  TERMINATED:
    "bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

const EXPIRY_STYLES: Record<ExpiryLevel, string> = {
  none: "",
  notice:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  urgent: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  expired: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

const EXPIRY_LABELS: Record<ExpiryLevel, string> = {
  none: "",
  notice: "Préavis",
  urgent: "Urgent",
  expired: "Échu",
};

function formatDay(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatMoney(amount: string, currency: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  try {
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    // Une devise inconnue de l'ICU ne doit pas casser la ligne : on affiche le
    // nombre et le code tels qu'ils sont stockés.
    return `${value.toLocaleString("fr-FR")} ${currency}`;
  }
}

/** La pastille d'échéance, avec la mention de reconduction tacite. */
function ExpiryBadge({ row }: { row: ContractRow }) {
  const { expiry } = row;
  if (expiry.level === "none") {
    return <span className="text-xs text-gray-400">—</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" title={expiry.message ?? undefined}>
      <span
        className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
          EXPIRY_STYLES[expiry.level]
        }`}
      >
        {EXPIRY_LABELS[expiry.level]}
        {expiry.days > 0 && ` · J-${expiry.days}`}
      </span>
      {row.renewalMode === "AUTO" && (
        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
          Tacite
        </span>
      )}
    </div>
  );
}

// ─── Écran ──────────────────────────────────────────────────

export default function ContractsPage() {
  const [rows, setRows] = useState<ContractRow[]>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [clientListRefusal, setClientListRefusal] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formOpen, setFormOpen] = useState(false);

  const [statusFilter, setStatusFilter] = useState("");
  const [tierFilter, setTierFilter] = useState("");
  const [clientFilter, setClientFilter] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [contractsResponse, clientsResponse] = await Promise.all([
        fetch("/api/contracts"),
        fetch("/api/clients"),
      ]);

      if (!contractsResponse.ok) {
        throw new Error(`Le registre a répondu ${contractsResponse.status}.`);
      }
      const contracts = await contractsResponse.json();
      setRows(Array.isArray(contracts?.data) ? contracts.data : []);

      /**
       * La liste des comptes clients est réservée à l'administrateur — la route
       * le dit. Le registre, lui, reste lisible par un responsable : on le
       * laisse s'ouvrir et l'on explique seulement pourquoi le formulaire de
       * création n'est pas disponible, au lieu de casser l'écran entier.
       */
      if (clientsResponse.ok) {
        const payload = await clientsResponse.json();
        setClients(
          Array.isArray(payload?.data?.clients) ? payload.data.clients : []
        );
        setClientListRefusal(null);
      } else if (clientsResponse.status === 403) {
        setClients([]);
        setClientListRefusal(
          "La liste des comptes clients est réservée à l'administrateur : la création " +
            "d'un contrat depuis cet écran l'est aussi."
        );
      } else {
        setClients([]);
        setClientListRefusal(
          `Les comptes clients n'ont pas pu être chargés (${clientsResponse.status}).`
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Impossible de charger les contrats."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Les clients du sélecteur : ceux qui ont des contrats, et ceux du registre. */
  const clientOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const client of clients) map.set(client.id, client.name);
    for (const row of rows) {
      if (!map.has(row.client.id)) map.set(row.client.id, row.client.name);
    }
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  }, [clients, rows]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();

    return rows.filter((row) => {
      if (statusFilter && row.effectiveStatus !== statusFilter) return false;
      if (tierFilter && row.slaTier !== tierFilter) return false;
      if (clientFilter && row.client.id !== clientFilter) return false;
      if (!term) return true;
      return (
        row.reference.toLowerCase().includes(term) ||
        row.client.name.toLowerCase().includes(term)
      );
    });
  }, [rows, statusFilter, tierFilter, clientFilter, search]);

  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.effectiveStatus] = (result[row.effectiveStatus] ?? 0) + 1;
    }
    return result;
  }, [rows]);

  const filtersActive =
    statusFilter !== "" || tierFilter !== "" || clientFilter !== "" || search !== "";

  function clearFilters() {
    setStatusFilter("");
    setTierFilter("");
    setClientFilter("");
    setSearch("");
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Contrats &amp; SLA
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Les engagements de maintenance : qui est couvert, sur quels
            immeubles, jusqu&apos;à quand, et à quel palier.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            )}
            Actualiser
          </button>
          <button
            type="button"
            onClick={() => setFormOpen((open) => !open)}
            disabled={Boolean(clientListRefusal)}
            title={clientListRefusal ?? undefined}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {formOpen ? (
              <X className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Plus className="h-4 w-4" aria-hidden="true" />
            )}
            {formOpen ? "Fermer" : "Nouveau contrat"}
          </button>
        </div>
      </div>

      {clientListRefusal && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          {clientListRefusal}
        </p>
      )}

      {formOpen && (
        <ContractCreateForm
          clients={clients}
          onCancel={() => setFormOpen(false)}
          onCreated={() => {
            setFormOpen(false);
            void load();
          }}
        />
      )}

      {/* ─── Filtres ───────────────────────────────────────── */}
      <Card className="p-4">
        <div className="flex flex-col gap-3">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
              aria-hidden="true"
            />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Rechercher par référence (CT-2026-0001) ou par client…"
              className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-10 pr-4 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Statut
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-normal normal-case text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              >
                <option value="">Tous</option>
                {CONTRACT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {enumLabel(status)} ({counts[status] ?? 0})
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Palier SLA
              <select
                value={tierFilter}
                onChange={(event) => setTierFilter(event.target.value)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-normal normal-case text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              >
                <option value="">Tous</option>
                {SLA_TIERS.map((tier) => (
                  <option key={tier} value={tier}>
                    {enumLabel(tier)}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Client
              <select
                value={clientFilter}
                onChange={(event) => setClientFilter(event.target.value)}
                className="max-w-[14rem] rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-normal normal-case text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              >
                <option value="">Tous</option>
                {clientOptions.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            </label>

            {filtersActive && (
              <button
                type="button"
                onClick={clearFilters}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                Effacer les filtres
              </button>
            )}
          </div>
        </div>
      </Card>

      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {loading && <LoadingSkeleton rows={5} />}

      {!loading && !error && visible.length === 0 && (
        <EmptyState
          title={
            rows.length === 0
              ? "Aucun contrat enregistré"
              : "Aucun contrat ne correspond aux filtres"
          }
          hint={
            rows.length === 0
              ? "Créez le premier contrat avec le bouton « Nouveau contrat »."
              : "Effacez la recherche ou changez de filtre."
          }
        />
      )}

      {!loading && !error && visible.length > 0 && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
                  <th className="px-4 py-3 font-semibold">Référence</th>
                  <th className="px-4 py-3 font-semibold">Client</th>
                  <th className="px-4 py-3 font-semibold">Palier</th>
                  <th className="px-4 py-3 font-semibold">Statut</th>
                  <th className="px-4 py-3 font-semibold">Échéance</th>
                  <th className="px-4 py-3 font-semibold">Alerte</th>
                  <th className="px-4 py-3 font-semibold">Immeubles</th>
                  <th className="px-4 py-3 text-right font-semibold">Montant</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-gray-100 last:border-0 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/50"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/administration/contrats/${row.id}`}
                        className="font-mono text-sm font-semibold text-blue-700 hover:underline dark:text-blue-400"
                      >
                        {row.reference}
                      </Link>
                      <p className="mt-0.5 text-[11px] text-gray-400">
                        créé le {formatDay(row.createdAt)}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900 dark:text-white">
                        {row.client.name}
                      </p>
                      <p className="text-[11px] text-gray-400">{row.client.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300">
                        {enumLabel(row.slaTier)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                          STATUS_STYLES[row.effectiveStatus]
                        }`}
                      >
                        {enumLabel(row.effectiveStatus)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-gray-900 dark:text-white">
                        {formatDay(row.effectiveEndsAt)}
                      </p>
                      <p className="text-[11px] text-gray-400">
                        du {formatDay(row.startsAt)} au {formatDay(row.endsAt)}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <ExpiryBadge row={row} />
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-gray-700 dark:text-gray-300">
                        {row.buildings.length} immeuble
                        {row.buildings.length > 1 ? "s" : ""}
                      </p>
                      <p className="max-w-[14rem] truncate text-[11px] text-gray-400">
                        {row.buildings.map((b) => b.name).join(", ") || "—"}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <p className="font-medium text-gray-900 dark:text-white">
                        {formatMoney(row.amount, row.currency)}
                      </p>
                      <p className="text-[11px] text-gray-400">
                        {enumLabel(row.billingCycle)}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/administration/contrats/${row.id}`}
                        className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                      >
                        Ouvrir
                        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {!loading && !error && rows.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-gray-400">
          <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
          {visible.length} contrat{visible.length > 1 ? "s" : ""} affiché
          {visible.length > 1 ? "s" : ""} sur {rows.length}.
        </p>
      )}
    </div>
  );
}
