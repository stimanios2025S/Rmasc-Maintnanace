"use client";

/**
 * La fiche d'un contrat.
 *
 * CE QUE L'ÉCRAN DOIT DIRE AVANT LES BOUTONS
 * L'état *calculé* (une ligne `ACTIVE` dont la date est passée est échue), la
 * date de fin réellement en vigueur (reconduction tacite comprise), le palier
 * engagé et ses deux délais, et ce qui va se passer à l'échéance. Un
 * administrateur qui clique « Renouveler » doit savoir quelle période il
 * prolonge — pas seulement quel bouton est disponible.
 *
 * LES ACTIONS SONT DÉCIDÉES PAR LA RÈGLE, PAS PAR L'ÉCRAN
 * Chaque bouton est conditionné à `transitionRefusal`, la même fonction que la
 * route applique. Un bouton qui n'apparaît pas est donc un geste que le serveur
 * refuserait ; un bouton qui apparaît ne peut pas échouer sur la règle. Les
 * deux écrans ne peuvent pas diverger parce qu'ils lisent la même phrase.
 *
 * LE RENOUVELLEMENT DEMANDE UNE DATE, LA RÉSILIATION UN MOTIF
 * Ce ne sont pas des confirmations décoratives : la route exige l'une et
 * l'autre, et un renouvellement vers le passé ou une résiliation sans motif
 * produiraient une ligne inutilisable six mois plus tard.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Ban,
  Building2,
  CalendarClock,
  History,
  Loader2,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { enumLabel } from "@/lib/ui/enum-labels";
import {
  addMonthsUtc,
  renewalRefusal,
  terminationRefusal,
  transitionRefusal,
} from "@/lib/contracts/status";
import type {
  ContractStatus,
  ContractRevisionKind,
} from "@/types";

// ─── Types de la réponse ────────────────────────────────────

type ExpiryLevel = "none" | "notice" | "urgent" | "expired";

interface ContractDetail {
  id: string;
  reference: string;
  year: number;
  sequence: number;
  status: ContractStatus;
  effectiveStatus: ContractStatus;
  slaTier: string;
  startsAt: string;
  endsAt: string;
  effectiveEndsAt: string;
  signedAt: string | null;
  renewalMode: string;
  noticeDays: number;
  billingCycle: string;
  amount: string;
  currency: string;
  responseHours: number;
  interventionHours: number;
  terminatedAt: string | null;
  terminationReason: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  client: { id: string; name: string; email: string; phone: string | null };
  terminatedBy: { id: string; name: string } | null;
  buildings: { id: string; name: string; city: string }[];
  revisions: {
    id: string;
    kind: ContractRevisionKind;
    summary: string;
    before: unknown;
    after: unknown;
    createdAt: string;
    changedBy: { id: string; name: string } | null;
  }[];
  expiry: { level: ExpiryLevel; days: number; message: string | null };
}

// ─── Présentation ───────────────────────────────────────────

const STATUS_STYLES: Record<ContractStatus, string> = {
  DRAFT: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  ACTIVE:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  SUSPENDED:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  EXPIRED: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  TERMINATED: "bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

const EXPIRY_STYLES: Record<ExpiryLevel, string> = {
  none: "border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300",
  notice:
    "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
  urgent:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
  expired:
    "border-gray-300 bg-gray-100 text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

/** Les libellés du journal. Le code stocké reste la clé. */
const REVISION_LABELS: Record<ContractRevisionKind, string> = {
  CREATED: "Création",
  TIER_CHANGED: "Palier",
  DATES_CHANGED: "Dates",
  RENEWAL_CHANGED: "Renouvellement",
  STATUS_CHANGED: "État",
  BUILDINGS_CHANGED: "Immeubles",
  COMMITMENT_CHANGED: "Délais promis",
};

function formatDay(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatMoney(amount: string, currency: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toLocaleString("fr-FR")} ${currency}`;
  }
}

// ─── Écran ──────────────────────────────────────────────────

export default function ContractDetailPage() {
  const params = useParams<{ id: string }>();

  const [contract, setContract] = useState<ContractDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  /** Le panneau ouvert : aucun, la reconduction, ou la résiliation. */
  const [panel, setPanel] = useState<"renew" | "terminate" | null>(null);
  const [renewEndsAt, setRenewEndsAt] = useState("");
  const [terminationReason, setTerminationReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/contracts/${params.id}`);
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : payload?.error?.message;
        throw new Error(
          message ?? `Le contrat n'a pas pu être chargé (${response.status}).`
        );
      }
      setContract(payload.data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Impossible de charger le contrat."
      );
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(
    body: Record<string, unknown>,
    successMessage: string
  ): Promise<boolean> {
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      const response = await fetch(`/api/contracts/${params.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : payload?.error?.message;
        throw new Error(message ?? `L'action a échoué (${response.status}).`);
      }
      setContract(payload.data);
      setNotice(successMessage);
      setPanel(null);
      return true;
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "L'action a échoué."
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openRenew() {
    const base = new Date(contract?.effectiveEndsAt ?? "");
    // Un contrat échu depuis longtemps repart de la date du jour : proposer
    // « terme actuel + 12 mois » donnerait une échéance déjà passée, que la
    // règle refuserait aussitôt.
    const from =
      Number.isNaN(base.getTime()) || base.getTime() <= Date.now()
        ? new Date()
        : base;
    setRenewEndsAt(isoDay(addMonthsUtc(from, 12)));
    setTerminationReason("");
    setActionError("");
    setPanel("renew");
  }

  function openTerminate() {
    setRenewEndsAt("");
    setTerminationReason("");
    setActionError("");
    setPanel("terminate");
  }

  /**
   * Les deux refus que l'écran peut calculer d'avance.
   *
   * `renewalRefusal` et `terminationRefusal` sont les fonctions que la route
   * applique ; les interroger ici n'est pas un doublon de contrôle, c'est la
   * même règle lue au même endroit.
   */
  const renewRefusal = useMemo(() => {
    if (!contract || panel !== "renew" || !renewEndsAt) return null;
    return renewalRefusal({
      currentEndsAt: new Date(contract.endsAt),
      newEndsAt: new Date(renewEndsAt),
    });
  }, [contract, panel, renewEndsAt]);

  const terminateRefusal = useMemo(() => {
    if (!contract || panel !== "terminate") return null;
    return terminationRefusal({
      status: contract.status,
      reason: terminationReason,
    });
  }, [contract, panel, terminationReason]);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (error || !contract) {
    return (
      <div className="mx-auto max-w-2xl">
        <ErrorState
          message={error || "Contrat introuvable."}
          onRetry={() => void load()}
        />
      </div>
    );
  }

  const stored = contract.status;

  /**
   * Chaque geste est offert si — et seulement si — la règle pure l'autorise
   * depuis l'état *stocké*, qui est celui que la route vérifie.
   *
   * « Renouveler » se distingue d'« Activer » par l'état calculé : un contrat
   * `ACTIVE` dont la date est dépassée est échu, et le geste est une nouvelle
   * période, pas une première signature.
   */
  const canActivate =
    stored === "DRAFT" && transitionRefusal(stored, "ACTIVE") === null;
  const canResume =
    stored === "SUSPENDED" &&
    // Un contrat suspendu dont la date est dépassée ne « reprend » pas : la
    // route le traite comme un renouvellement et exige une nouvelle échéance.
    // L'écran n'offre donc que « Renouveler » dans ce cas.
    contract.effectiveStatus !== "EXPIRED" &&
    transitionRefusal(stored, "ACTIVE") === null;
  const canRenew =
    contract.effectiveStatus === "EXPIRED" &&
    transitionRefusal(stored, "ACTIVE") === null;
  const canSuspend =
    stored === "ACTIVE" &&
    contract.effectiveStatus !== "EXPIRED" &&
    transitionRefusal(stored, "SUSPENDED") === null;
  const canTerminate = transitionRefusal(stored, "TERMINATED") === null;

  const hasActions =
    canActivate || canResume || canRenew || canSuspend || canTerminate;

  const renewalHint =
    contract.renewalMode === "AUTO"
      ? `Date de fin repoussée automatiquement · préavis ${contract.noticeDays} jours`
      : `Le contrat s'arrête à l'échéance · préavis ${contract.noticeDays} jours`;

  return (
    <div className="space-y-6">
      {/* ─── En-tête ───────────────────────────────────────── */}
      <div>
        <Link
          href="/administration/contrats"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Registre des contrats
        </Link>

        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-mono text-2xl font-bold text-gray-900 dark:text-white">
                {contract.reference}
              </h1>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                  STATUS_STYLES[contract.effectiveStatus]
                }`}
              >
                {enumLabel(contract.effectiveStatus)}
              </span>
              {contract.status !== contract.effectiveStatus && (
                <span className="text-xs text-gray-400">
                  (statut enregistré : {enumLabel(contract.status)})
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {contract.client.name} · {contract.client.email}
              {contract.client.phone ? ` · ${contract.client.phone}` : ""}
            </p>
          </div>

          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Actualiser
          </button>
        </div>
      </div>

      {/* ─── L'alerte d'échéance ───────────────────────────── */}
      {contract.expiry.level !== "none" && contract.expiry.message && (
        <div
          className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
            EXPIRY_STYLES[contract.expiry.level]
          }`}
        >
          <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div>
            <p>{contract.expiry.message}</p>
            {contract.renewalMode === "AUTO" && (
              <p className="mt-0.5 text-xs opacity-80">
                Reconduction tacite : la date de fin est repoussée d&apos;une
                période tant qu&apos;elle est en vigueur.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ─── Vue synthétique ───────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            Statut calculé
          </p>
          <p className="mt-1 text-lg font-semibold text-gray-900 dark:text-white">
            {enumLabel(contract.effectiveStatus)}
          </p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {contract.status !== contract.effectiveStatus
              ? `Enregistré « ${enumLabel(contract.status)} », échu par la date.`
              : contract.effectiveStatus === "DRAFT"
                ? "Brouillon : ne couvre aucun immeuble."
                : contract.effectiveStatus === "SUSPENDED"
                  ? "Couvert administrativement, service suspendu."
                  : contract.effectiveStatus === "TERMINATED"
                    ? "Terminal pour cette période."
                    : "En vigueur."}
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            Période
          </p>
          <p className="mt-1 text-lg font-semibold text-gray-900 dark:text-white">
            {formatDay(contract.effectiveEndsAt)}
          </p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Effet le {formatDay(contract.startsAt)}
            {contract.effectiveEndsAt.slice(0, 10) !==
              contract.endsAt.slice(0, 10) && (
              <>
                {" "}
                · terme initial au {formatDay(contract.endsAt)}
              </>
            )}
          </p>
          {contract.signedAt && (
            <p className="mt-1 text-[11px] text-gray-400">
              Signé le {formatDay(contract.signedAt)}
            </p>
          )}
        </Card>

        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            Palier SLA engagé
          </p>
          <p className="mt-1 text-lg font-semibold text-gray-900 dark:text-white">
            {enumLabel(contract.slaTier)}
          </p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Prise en charge {contract.responseHours} h · intervention{" "}
            {contract.interventionHours} h.
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            Renouvellement
          </p>
          <p className="mt-1 text-lg font-semibold text-gray-900 dark:text-white">
            {enumLabel(contract.renewalMode)}
          </p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {renewalHint}
          </p>
          <p className="mt-1 text-[11px] text-gray-400">
            {formatMoney(contract.amount, contract.currency)} ·{" "}
            {enumLabel(contract.billingCycle)}
          </p>
        </Card>
      </div>

      {/* ─── Actions conditionnelles ───────────────────────── */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
              Actions
            </h2>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              Les gestes offerts sont ceux que la règle de transition autorise
              depuis l&apos;état enregistré.
            </p>
          </div>

          {hasActions && (
            <div className="flex flex-wrap gap-2">
              {canActivate && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void patch({ status: "ACTIVE" }, "Contrat activé.")
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                >
                  <PlayCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  Activer
                </button>
              )}

              {canResume && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void patch({ status: "ACTIVE" }, "Contrat réactivé.")
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                >
                  <PlayCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  Reprendre
                </button>
              )}

              {canRenew && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={openRenew}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                  Renouveler
                </button>
              )}

              {canSuspend && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void patch({ status: "SUSPENDED" }, "Contrat suspendu.")
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-60 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
                >
                  <PauseCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  Suspendre
                </button>
              )}

              {canTerminate && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={openTerminate}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
                >
                  <Ban className="h-3.5 w-3.5" aria-hidden="true" />
                  {stored === "DRAFT" ? "Abandonner" : "Résilier"}
                </button>
              )}
            </div>
          )}
        </div>

        {!hasActions && (
          <p className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            Aucune transition n&apos;est possible depuis cet état. Un contrat
            résilié se remplace par un nouveau contrat : la résiliation doit
            rester lisible dans l&apos;historique.
          </p>
        )}

        {/* ─── Panneau de reconduction ─────────────────────── */}
        {panel === "renew" && (
          <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50/50 p-3 dark:border-blue-900 dark:bg-blue-950/20">
            <p className="text-xs font-semibold text-blue-900 dark:text-blue-300">
              Nouvelle période
            </p>
            <p className="mt-0.5 text-[11px] text-blue-800/80 dark:text-blue-400">
              La nouvelle date de fin doit être postérieure au terme actuel
              ({formatDay(contract.endsAt)}). La date de début reste inchangée.
            </p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="block">
                <span className="text-[11px] font-medium text-gray-600 dark:text-gray-400">
                  Nouvelle échéance
                </span>
                <input
                  type="date"
                  value={renewEndsAt}
                  onChange={(event) => setRenewEndsAt(event.target.value)}
                  className="mt-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                />
              </label>
              <button
                type="button"
                disabled={busy || Boolean(renewRefusal) || renewEndsAt === ""}
                onClick={() =>
                  void patch(
                    {
                      status: "ACTIVE",
                      endsAt: new Date(renewEndsAt).toISOString(),
                    },
                    "Contrat renouvelé."
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                Confirmer le renouvellement
              </button>
              <button
                type="button"
                onClick={() => setPanel(null)}
                className="rounded-lg px-2 py-2 text-xs font-medium text-gray-500 hover:bg-white dark:hover:bg-gray-800"
              >
                Annuler
              </button>
            </div>
            {renewRefusal && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                {renewRefusal}
              </p>
            )}
          </div>
        )}

        {/* ─── Panneau de résiliation ──────────────────────── */}
        {panel === "terminate" && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50/50 p-3 dark:border-red-900 dark:bg-red-950/20">
            <p className="text-xs font-semibold text-red-900 dark:text-red-300">
              {stored === "DRAFT"
                ? "Abandonner ce brouillon"
                : "Résilier ce contrat"}
            </p>
            <p className="mt-0.5 text-[11px] text-red-800/80 dark:text-red-400">
              Un motif est obligatoire : « résilié sans motif » est une ligne
              qui ne répond à aucune question posée six mois plus tard.
            </p>
            <textarea
              rows={2}
              maxLength={500}
              value={terminationReason}
              onChange={(event) => setTerminationReason(event.target.value)}
              placeholder={
                stored === "DRAFT"
                  ? "Ex. : proposition abandonnée avant signature."
                  : "Ex. : impayés depuis trois mois, résiliation notifiée au client."
              }
              className="mt-2 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy || Boolean(terminateRefusal)}
                onClick={() =>
                  void patch(
                    {
                      status: "TERMINATED",
                      terminationReason: terminationReason.trim(),
                    },
                    stored === "DRAFT"
                      ? "Brouillon abandonné."
                      : "Contrat résilié."
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Ban className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                Confirmer
              </button>
              <button
                type="button"
                onClick={() => setPanel(null)}
                className="rounded-lg px-2 py-2 text-xs font-medium text-gray-500 hover:bg-white dark:hover:bg-gray-800"
              >
                Annuler
              </button>
              {terminateRefusal && terminationReason.trim() === "" && (
                <span className="text-xs text-gray-400">Motif requis.</span>
              )}
            </div>
          </div>
        )}

        {actionError && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {actionError}
          </p>
        )}
        {notice && (
          <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
            {notice}
          </p>
        )}
      </Card>

      {/*
        ─── Résiliation enregistrée ───────────────────────────
        La trace est affichée sur la fiche, pas seulement dans le journal : un
        contrat résilié qui n'afficherait pas son motif obligerait à dérouler
        sept révisions pour comprendre pourquoi il ne couvre plus rien.
      */}
      {contract.status === "TERMINATED" && contract.terminationReason && (
        <Card className="border-red-200 p-4 dark:border-red-900">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-red-700 dark:text-red-400">
            <Ban className="h-3.5 w-3.5" aria-hidden="true" />
            Résiliation
          </p>
          <p className="mt-1 text-sm text-gray-800 dark:text-gray-200">
            {contract.terminationReason}
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Le {formatDateTime(contract.terminatedAt)}
            {contract.terminatedBy && ` par ${contract.terminatedBy.name}`}.
          </p>
        </Card>
      )}

      {/* ─── Immeubles couverts ────────────────────────────── */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-800">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-white">
            <Building2 className="h-4 w-4 text-gray-400" aria-hidden="true" />
            Immeubles rattachés
          </h2>
          <span className="text-xs text-gray-400">
            {contract.buildings.length} site
            {contract.buildings.length > 1 ? "s" : ""}
          </span>
        </div>

        {contract.buildings.length === 0 ? (
          <p className="px-4 py-4 text-sm text-gray-500 dark:text-gray-400">
            Aucun immeuble rattaché. Un contrat doit en couvrir au moins un.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {contract.buildings.map((building) => (
              <li
                key={building.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    {building.name}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {building.city}
                  </p>
                </div>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                  Couvert par ce contrat
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ─── Journal des révisions ─────────────────────────── */}
      <Card className="p-4">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-white">
          <History className="h-4 w-4 text-gray-400" aria-hidden="true" />
          Journal des révisions
        </h2>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          Chaque changement de date, de palier ou d&apos;état est écrit au moment
          où il se produit — un état courant ne se reconstitue pas.
        </p>

        {contract.revisions.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
            Aucune révision enregistrée.
          </p>
        ) : (
          <ol className="mt-3 space-y-3">
            {contract.revisions.map((revision) => (
              <li key={revision.id} className="flex gap-3">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-blue-500" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                      {REVISION_LABELS[revision.kind] ?? revision.kind}
                    </span>
                    <span className="text-xs text-gray-400">
                      {formatDateTime(revision.createdAt)}
                      {revision.changedBy && ` · ${revision.changedBy.name}`}
                    </span>
                  </div>
                  <p className="mt-0.5 text-sm text-gray-700 dark:text-gray-300">
                    {revision.summary}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {/* ─── Notes ─────────────────────────────────────────── */}
      {contract.notes?.trim() && (
        <Card className="p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-white">
            <ShieldCheck className="h-4 w-4 text-gray-400" aria-hidden="true" />
            Notes du bureau
          </h2>
          <p className="mt-2 whitespace-pre-line text-sm text-gray-700 dark:text-gray-300">
            {contract.notes}
          </p>
        </Card>
      )}
    </div>
  );
}
