"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Gauge,
  Loader2,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Undo2,
  X,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { parseDecimalInput } from "@/lib/ui/numbers";
import {
  OVERLOAD_POLICY,
  boundsViolation,
  type ThresholdBounds,
} from "@/lib/iot/metric-catalogue";

/**
 * Le réglage des seuils d'alerte.
 *
 * CE QUE CET ÉCRAN CORRIGE
 * `ThresholdRule` était lu à chaque ingestion télémetrique et rien dans
 * l'application ne permettait d'en écrire une. Toutes les alertes du parc se
 * déclenchaient donc sur les valeurs posées par le script de peuplement, et
 * elles y seraient restées : le seul mécanisme de surveillance de
 * l'application était figé à sa valeur d'installation.
 *
 * CE QU'IL MONTRE, ET POURQUOI IL LE MONTRE
 * Pour chaque grandeur, les bornes *en vigueur* et celles *par défaut*, côte à
 * côte. La distinction n'est pas décorative : sans elle, un exploitant ne peut
 * pas savoir si la valeur qu'il lit vient de son réglage ou du repli intégré, et
 * « rétablir le défaut » devient un bouton dont on ne peut pas prévoir l'effet.
 *
 * LA SURCHARGE DE CABINE N'EST PAS RÉGLABLE, ET C'EST DIT
 * Elle se recalcule par appareil à partir de sa charge maximale. Une borne
 * saisie pour elle serait ignorée — c'est écrit noir sur blanc dans le module
 * d'origine, qui raconte que quiconque éditait cette ligne « voyait le
 * changement ne rien faire, en silence ». L'écran l'affiche donc en lecture
 * seule, avec les bornes réellement appliquées pour chaque capacité du parc.
 */

interface MetricRow {
  metricName: string;
  title: string;
  unit: string;
  description: string;
  defaults: ThresholdBounds;
  custom: ThresholdBounds | null;
  effective: ThresholdBounds;
  isCustom: boolean;
}

interface Payload {
  metrics: MetricRow[];
  derived: {
    metricName: string;
    title: string;
    unit: string;
    description: string;
  };
  payloadCapacitiesKg: number[];
}

/** Les quatre bornes, telles que les champs les portent. */
type Draft = {
  warningMin: string;
  warningMax: string;
  criticalMin: string;
  criticalMax: string;
};

const BOUND_LABELS: { key: keyof ThresholdBounds; label: string }[] = [
  { key: "warningMin", label: "Avertissement — minimum" },
  { key: "warningMax", label: "Avertissement — maximum" },
  { key: "criticalMin", label: "Critique — minimum" },
  { key: "criticalMax", label: "Critique — maximum" },
];

function toDraft(bounds: ThresholdBounds): Draft {
  const text = (value: number | null) => (value === null ? "" : String(value));
  return {
    warningMin: text(bounds.warningMin),
    warningMax: text(bounds.warningMax),
    criticalMin: text(bounds.criticalMin),
    criticalMax: text(bounds.criticalMax),
  };
}

/**
 * Lit les quatre champs, ou dit lequel est illisible.
 *
 * `parseDecimalInput` rend `null` aussi bien pour un champ vide — qui veut dire
 * « pas de borne de ce côté », une intention légitime — que pour un texte qui
 * n'est pas un nombre. Les confondre ferait qu'une faute de frappe *effacerait*
 * une borne au lieu de la signaler, ce qui est la pire des deux issues : le
 * réglage serait accepté, et l'alerte ne se déclencherait plus.
 */
function readDraft(
  draft: Draft
): { bounds: ThresholdBounds } | { error: string } {
  const bounds: ThresholdBounds = {
    warningMin: null,
    warningMax: null,
    criticalMin: null,
    criticalMax: null,
  };

  for (const { key, label } of BOUND_LABELS) {
    const raw = draft[key];
    if (raw.trim() === "") continue;

    const value = parseDecimalInput(raw, { allowNegative: true });
    if (value === null) {
      return { error: `« ${raw} » n'est pas un nombre lisible (${label}).` };
    }
    bounds[key] = value;
  }

  return { bounds };
}

export default function SeuilsPage() {
  const { data: session } = useSession();
  const role = session?.user?.role;
  const canEdit = role === "ADMIN" || role === "MAINTENANCE_MANAGER";

  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(toDraft({
    warningMin: null,
    warningMax: null,
    criticalMin: null,
    criticalMax: null,
  }));
  const [saving, setSaving] = useState(false);
  const [busyMetric, setBusyMetric] = useState<string | null>(null);

  const load = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/thresholds");
      if (!res.ok) throw new Error(`L'API des seuils a répondu ${res.status}`);
      const json = await res.json();
      setPayload(json.data ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Échec du chargement des seuils");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(metric: MetricRow) {
    const read = readDraft(draft);
    if ("error" in read) {
      setActionError(read.error);
      return;
    }

    // La même règle que la route, appliquée ici pour que le refus arrive sans
    // aller-retour et nomme la borne fautive.
    const violation = boundsViolation(read.bounds);
    if (violation) {
      setActionError(violation);
      return;
    }

    setSaving(true);
    setActionError(null);
    setNotice(null);

    try {
      const res = await fetch("/api/thresholds", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metricName: metric.metricName, ...read.bounds }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error ?? body?.message ?? "Le réglage a été refusé.");
      }

      setEditing(null);
      setNotice(`Seuils de « ${metric.title} » enregistrés.`);
      await load({ silent: true });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "L'enregistrement a échoué.");
    } finally {
      setSaving(false);
    }
  }

  async function restoreDefault(metric: MetricRow) {
    setBusyMetric(metric.metricName);
    setActionError(null);
    setNotice(null);

    try {
      const res = await fetch(
        `/api/thresholds?metricName=${encodeURIComponent(metric.metricName)}`,
        { method: "DELETE" }
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error ?? body?.message ?? "La réinitialisation a échoué.");
      }
      setNotice(`« ${metric.title} » reprend ses valeurs d'origine.`);
      await load({ silent: true });
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "La réinitialisation a échoué."
      );
    } finally {
      setBusyMetric(null);
    }
  }

  if (loading && !payload) {
    return (
      <div className="space-y-6">
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  if (error && !payload) {
    return <ErrorState message={error} onRetry={load} />;
  }

  if (!payload) return null;

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <Gauge className="mt-0.5 h-5 w-5 flex-none text-blue-600 dark:text-blue-400" aria-hidden="true" />
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                Seuils d&apos;alerte
              </h2>
              <p className="mt-0.5 max-w-3xl text-sm text-gray-500 dark:text-gray-400">
                Les bornes à partir desquelles une mesure déclenche une alerte.
                Elles s&apos;appliquent à tout le parc et prennent effet
                immédiatement, sans redémarrage. Une grandeur sans réglage
                utilise sa valeur d&apos;origine, rappelée sous chacune.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load({ silent: true })}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Actualiser
          </button>
        </div>

        {!canEdit && (
          <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
            Modifier un seuil revient à décider à partir de quand une machine est
            signalée : ces réglages sont réservés à l&apos;administrateur et au
            responsable maintenance.
          </p>
        )}

        {notice && (
          <p
            role="status"
            className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm font-medium text-green-800 dark:bg-green-950/40 dark:text-green-300"
          >
            {notice}
          </p>
        )}

        {actionError && (
          <p
            role="alert"
            className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-800 dark:bg-red-950/40 dark:text-red-300"
          >
            {actionError}
          </p>
        )}
      </Card>

      <ul className="space-y-3">
        {payload.metrics.map((metric) => {
          const isEditing = editing === metric.metricName;
          const isBusy = busyMetric === metric.metricName;

          return (
            <li key={metric.metricName}>
              <Card
                className={`p-5 ${
                  metric.isCustom ? "border-blue-200 dark:border-blue-900" : ""
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold text-gray-900 dark:text-white">
                    {metric.title}
                  </h3>
                  <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                    {metric.unit}
                  </span>

                  {metric.isCustom ? (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-800 dark:bg-blue-950 dark:text-blue-300">
                      Réglé
                    </span>
                  ) : (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                      Valeur d&apos;origine
                    </span>
                  )}

                  {canEdit && !isEditing && (
                    <div className="ml-auto flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(metric.metricName);
                          setDraft(toDraft(metric.effective));
                          setActionError(null);
                          setNotice(null);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        Modifier
                      </button>

                      {metric.isCustom && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void restoreDefault(metric)}
                          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800"
                        >
                          {isBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          Rétablir l&apos;origine
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                  {metric.description}
                </p>

                {/* ── Bornes en vigueur ───────────────────────── */}
                <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {BOUND_LABELS.map(({ key, label }) => {
                    const value = metric.effective[key];
                    const fallback = metric.defaults[key];
                    const differs =
                      metric.isCustom && value !== fallback;

                    return (
                      <div key={key}>
                        <dt className="text-xs text-gray-500 dark:text-gray-400">
                          {label}
                        </dt>
                        <dd
                          className={`text-sm font-semibold tabular-nums ${
                            value === null
                              ? "text-gray-400"
                              : "text-gray-900 dark:text-white"
                          }`}
                        >
                          {value === null
                            ? "—"
                            : `${value}${metric.unit ? ` ${metric.unit}` : ""}`}
                          {differs && (
                            <span className="ml-1.5 text-xs font-normal text-gray-500 dark:text-gray-400">
                              (origine {fallback})
                            </span>
                          )}
                        </dd>
                      </div>
                    );
                  })}
                </dl>

                {/* ── Formulaire ─────────────────────────────── */}
                {isEditing && (
                  <div className="mt-4 rounded-lg border border-blue-200 bg-white/70 p-4 dark:border-blue-900 dark:bg-gray-900/60">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      {BOUND_LABELS.map(({ key, label }) => (
                        <label key={key} className="text-sm">
                          <span className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                            {label}
                          </span>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={draft[key]}
                            onChange={(e) =>
                              setDraft({ ...draft, [key]: e.target.value })
                            }
                            placeholder="—"
                            className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                          />
                        </label>
                      ))}
                    </div>

                    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                      Laissez un champ vide pour retirer cette borne. Le minimum
                      d&apos;avertissement doit rester sous le maximum, et les
                      bornes critiques en dehors des bornes d&apos;avertissement
                      — sans quoi la borne d&apos;avertissement serait
                      inatteignable.
                    </p>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void save(metric)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                      >
                        {saving && (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        )}
                        Enregistrer
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(null);
                          setActionError(null);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                        Annuler
                      </button>
                    </div>
                  </div>
                )}
              </Card>
            </li>
          );
        })}
      </ul>

      {/* ── La grandeur dérivée ────────────────────────────── */}
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <ShieldCheck
            className="mt-0.5 h-5 w-5 flex-none text-gray-400"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h3 className="font-semibold text-gray-900 dark:text-white">
              {payload.derived.title} — non réglable
            </h3>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {payload.derived.description}
            </p>

            {payload.payloadCapacitiesKg.length > 0 ? (
              <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                {payload.payloadCapacitiesKg.map((capacity) => (
                  <li key={capacity} className="text-gray-600 dark:text-gray-400">
                    <span className="font-mono text-xs text-gray-500">
                      {capacity} kg
                    </span>{" "}
                    → avertissement{" "}
                    <span className="font-semibold tabular-nums text-gray-900 dark:text-white">
                      {Math.round(capacity * OVERLOAD_POLICY.warningRatio)} kg
                    </span>
                    , critique{" "}
                    <span className="font-semibold tabular-nums text-gray-900 dark:text-white">
                      {Math.round(capacity * OVERLOAD_POLICY.criticalRatio)} kg
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                Aucun appareil actif : ces bornes n&apos;ont rien à quoi
                s&apos;appliquer.
              </p>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
