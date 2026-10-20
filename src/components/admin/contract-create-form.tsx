"use client";

/**
 * Le formulaire de création d'un contrat.
 *
 * POURQUOI LA SÉLECTION D'IMMEUBLES DÉPEND DU CLIENT
 * Un contrat couvre une sélection du parc *du titulaire* : la route refuse un
 * immeuble qui appartient à quelqu'un d'autre, et c'est une bonne règle. Le
 * formulaire la devance en ne proposant que les immeubles du client choisi —
 * offrir la liste entière puis refuser à l'envoi ferait chercher à l'utilisateur
 * une erreur qu'il n'a pas commise.
 *
 * LA LISTE VIENT DE LA FICHE DU CLIENT, PAS D'UNE SECONDE ROUTE
 * `GET /api/clients/:id` rend déjà ses immeubles. Il n'y a pas de route
 * « immeubles d'un client » séparée, et en inventer une pour ce formulaire
 * produirait une troisième façon de répondre à la même question.
 *
 * LES DATES SONT VÉRIFIÉES ICI AUSSI
 * `datesRefusal` est la règle pure que la route applique. La lire avant l'envoi
 * ne remplace pas le contrôle serveur : elle évite seulement d'envoyer une
 * demande dont on sait déjà qu'elle sera refusée, et explique pourquoi.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarPlus, Loader2, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { enumLabel } from "@/lib/ui/enum-labels";
import {
  addMonthsUtc,
  datesRefusal,
  SLA_COMMITMENTS,
} from "@/lib/contracts/status";
import {
  BILLING_CYCLES,
  CONTRACT_RENEWAL_MODES,
  SLA_TIERS,
} from "@/types";

interface ClientOption {
  id: string;
  name: string;
}

interface BuildingOption {
  id: string;
  name: string;
  city: string;
}

/** `2026-10-20` à partir d'une date UTC — le format que `<input type="date">` lit. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function ContractCreateForm({
  clients,
  onCreated,
  onCancel,
}: {
  clients: readonly ClientOption[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  const now = useMemo(() => new Date(), []);

  const [clientId, setClientId] = useState("");
  const [buildings, setBuildings] = useState<BuildingOption[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [buildingsLoading, setBuildingsLoading] = useState(false);
  const [buildingsError, setBuildingsError] = useState("");

  const [startsAt, setStartsAt] = useState(isoDay(now));
  const [endsAt, setEndsAt] = useState(isoDay(addMonthsUtc(now, 12)));
  const [slaTier, setSlaTier] = useState<string>("STANDARD");
  const [renewalMode, setRenewalMode] = useState<string>("AUTO");
  const [noticeDays, setNoticeDays] = useState("60");
  const [billingCycle, setBillingCycle] = useState<string>("ANNUALLY");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("DZD");
  const [notes, setNotes] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  /**
   * Les immeubles du client choisi.
   *
   * La requête précédente est annulée quand le client change : sans cela, une
   * réponse lente pour le premier client pourrait écraser la liste du second,
   * et l'on cocherait des immeubles qui ne sont pas dans le contrat.
   */
  useEffect(() => {
    if (!clientId) {
      setBuildings([]);
      setSelected(new Set());
      setBuildingsError("");
      return;
    }

    let cancelled = false;
    setBuildingsLoading(true);
    setBuildingsError("");
    setBuildings([]);
    setSelected(new Set());

    (async () => {
      try {
        const response = await fetch(`/api/clients/${clientId}`);
        if (!response.ok) {
          throw new Error(
            response.status === 403
              ? "La fiche du client est réservée à l'administrateur."
              : `La fiche du client a répondu ${response.status}.`
          );
        }
        const payload = await response.json();
        if (cancelled) return;
        const owned = Array.isArray(payload?.data?.ownedBuildings)
          ? payload.data.ownedBuildings
          : [];
        setBuildings(
          owned.map((building: { id: string; name: string; city: string }) => ({
            id: building.id,
            name: building.name,
            city: building.city,
          }))
        );
      } catch (err) {
        if (!cancelled) {
          setBuildingsError(
            err instanceof Error
              ? err.message
              : "Impossible de charger les immeubles du client."
          );
        }
      } finally {
        if (!cancelled) setBuildingsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const noticeValue = Number(noticeDays);

  const dateRefusal = useMemo(() => {
    if (!startsAt || !endsAt) return null;
    return datesRefusal({
      startsAt: new Date(startsAt),
      endsAt: new Date(endsAt),
      noticeDays: Number.isFinite(noticeValue) ? noticeValue : 0,
    });
  }, [startsAt, endsAt, noticeValue]);

  const commitment = SLA_COMMITMENTS[slaTier as keyof typeof SLA_COMMITMENTS];

  const canSubmit =
    clientId !== "" &&
    selected.size > 0 &&
    amount.trim() !== "" &&
    currency.trim().length === 3 &&
    !dateRefusal &&
    !saving;

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  function toggleAll() {
    setSelected((current) =>
      current.size === buildings.length
        ? new Set()
        : new Set(buildings.map((building) => building.id))
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");

    try {
      const response = await fetch("/api/contracts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          slaTier,
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          renewalMode,
          noticeDays: noticeValue,
          billingCycle,
          amount: Number(amount),
          currency: currency.trim().toUpperCase(),
          buildingIds: [...selected],
          notes: notes.trim() === "" ? null : notes.trim(),
        }),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : payload?.error?.message;
        const issue = payload?.details?.issues?.[0]?.message;
        throw new Error(
          issue ?? message ?? `La création a échoué (${response.status}).`
        );
      }

      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "La création a échoué.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">
            Nouveau contrat
          </h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Le contrat est créé en brouillon : il ne couvre ses immeubles
            qu&apos;une fois activé depuis sa fiche.
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Fermer le formulaire"
          className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <form onSubmit={submit} className="mt-4 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Client titulaire
            </span>
            <select
              required
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            >
              <option value="">Choisir un compte client…</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>

          {/* ─── Les immeubles couverts ─────────────────────── */}
          <fieldset className="sm:col-span-2">
            <div className="flex items-center justify-between">
              <legend className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Immeubles couverts
                {selected.size > 0 && (
                  <span className="ml-2 text-gray-400">
                    {selected.size} sélectionné{selected.size > 1 ? "s" : ""}
                  </span>
                )}
              </legend>
              {buildings.length > 0 && (
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  {selected.size === buildings.length
                    ? "Tout désélectionner"
                    : "Tout sélectionner"}
                </button>
              )}
            </div>

            <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-gray-200 p-2 dark:border-gray-800">
              {!clientId && (
                <p className="px-1 py-2 text-xs text-gray-400">
                  Choisissez d&apos;abord un client : ses immeubles
                  apparaîtront ici.
                </p>
              )}
              {clientId && buildingsLoading && (
                <p className="flex items-center gap-2 px-1 py-2 text-xs text-gray-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  Chargement des immeubles…
                </p>
              )}
              {clientId && buildingsError && (
                <p className="px-1 py-2 text-xs text-red-600 dark:text-red-400">
                  {buildingsError}
                </p>
              )}
              {clientId &&
                !buildingsLoading &&
                !buildingsError &&
                buildings.length === 0 && (
                  <p className="px-1 py-2 text-xs text-amber-700 dark:text-amber-400">
                    Ce client n&apos;a aucun immeuble rattaché. Un contrat
                    couvre au moins un immeuble : rattachez-lui un site depuis
                    sa fiche client.
                  </p>
                )}
              {buildings.map((building) => (
                <label
                  key={building.id}
                  className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(building.id)}
                    onChange={() => toggle(building.id)}
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-800 dark:text-gray-200">
                    {building.name}
                    <span className="ml-1 text-xs text-gray-400">
                      {building.city}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {/* ─── Dates ──────────────────────────────────────── */}
          <label className="block">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Date d&apos;effet
            </span>
            <input
              required
              type="date"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Date d&apos;échéance
            </span>
            <input
              required
              type="date"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
          </label>

          {/* ─── Palier et renouvellement ───────────────────── */}
          <label className="block">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Palier SLA engagé
            </span>
            <select
              value={slaTier}
              onChange={(event) => setSlaTier(event.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            >
              {SLA_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {enumLabel(tier)}
                </option>
              ))}
            </select>
            {commitment && (
              <span className="mt-1 block text-[11px] text-gray-400">
                Barème : prise en charge {commitment.responseHours} h ·
                intervention {commitment.interventionHours} h.
              </span>
            )}
          </label>

          <label className="block">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Type de reconduction
            </span>
            <select
              value={renewalMode}
              onChange={(event) => setRenewalMode(event.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            >
              {CONTRACT_RENEWAL_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {enumLabel(mode)}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Préavis (jours)
            </span>
            <input
              required
              type="number"
              min={0}
              max={3650}
              value={noticeDays}
              onChange={(event) => setNoticeDays(event.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
          </label>

          {/* ─── Facturation ────────────────────────────────── */}
          <label className="block">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Cycle de facturation
            </span>
            <select
              value={billingCycle}
              onChange={(event) => setBillingCycle(event.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            >
              {BILLING_CYCLES.map((cycle) => (
                <option key={cycle} value={cycle}>
                  {enumLabel(cycle)}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Montant de l&apos;abonnement
            </span>
            <div className="mt-1 flex gap-2">
              <input
                required
                type="number"
                min={0}
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              />
              <input
                required
                aria-label="Devise"
                maxLength={3}
                value={currency}
                onChange={(event) =>
                  setCurrency(event.target.value.toUpperCase())
                }
                className="w-20 rounded-lg border border-gray-300 bg-white px-3 py-2 text-center font-mono text-sm uppercase text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              />
            </div>
          </label>

          <label className="block sm:col-span-2">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Notes (facultatif)
            </span>
            <textarea
              rows={2}
              maxLength={2000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
          </label>
        </div>

        {dateRefusal && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            {dateRefusal}
          </p>
        )}
        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <CalendarPlus className="h-4 w-4" aria-hidden="true" />
            )}
            Créer le brouillon
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Annuler
          </button>
          {selected.size === 0 && clientId !== "" && (
            <span className="text-xs text-gray-400">
              Sélectionnez au moins un immeuble.
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}
