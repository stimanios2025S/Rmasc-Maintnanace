"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import { CalendarPlus, Loader2, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { enumLabel } from "@/lib/ui/enum-labels";
import { toDateInput, fromDateInput } from "@/lib/maintenance/schedule";
import {
  DueBadge,
  bucketOf,
  type ScheduleBucket,
} from "@/components/maintenance/due-badge";
import type { RosterTechnician } from "@/components/admin/dispatch-modal";
import {
  SectionTabs,
  INTERVENTION_TABS,
} from "@/components/layout/section-tabs";
import type { MaintenanceFrequency } from "@prisma/client";

/**
 * Le programme d'entretien — le tableau du préventif.
 *
 * CE QUE CET ÉCRAN CORRIGE
 * Tout ce que l'application savait faire jusqu'ici était curatif : une panne
 * arrive, on envoie quelqu'un, il travaille, le bureau valide, la facture part.
 * Le métier d'un mainteneur d'ascenseurs est pourtant le *contrat* — N visites
 * par an, à une périodicité fixée, avec une liste de points à vérifier. Ces
 * programmes existaient en base depuis le début et n'étaient lus par aucun
 * écran : la seule façon pour une visite préventive d'entrer dans le système
 * était qu'un client la réclame.
 *
 * CE QU'IL FAIT, ET CE QU'IL NE FAIT PAS
 * Il lit et il planifie. Il ne crée ni ne modifie un programme : ces deux
 * gestes se font sur la fiche de l'appareil, à côté du reste de sa
 * configuration. La distinction est nette et volontaire — un tableau sert à
 * décider de ce qu'on fait cette semaine, pas à réécrire un contrat.
 *
 * L'ORDRE DE LA LISTE EST UN ORDRE DE TRAVAIL
 * Trié par échéance croissante, donc la ligne la plus en retard est en haut.
 * C'est le serveur qui trie, pas ce composant.
 */

interface ScheduleRow {
  id: string;
  title: string;
  description: string | null;
  frequency: MaintenanceFrequency;
  cycleThreshold: number | null;
  checklist: { name: string; required: boolean }[];
  nextDueDate: string;
  lastCompleted: string | null;
  isActive: boolean;
  elevator: {
    id: string;
    elevatorCode: string;
    building: {
      id: string;
      name: string;
      address: string;
      city: string;
      accessCode: string | null;
    };
  };
  activeWorkOrder: {
    id: string;
    orderNumber: string;
    status: string;
    scheduledDate: string | null;
    assignedTo: { id: string; name: string } | null;
  } | null;
}

/**
 * Les cinq étapes du pipeline d'une visite.
 *
 * Le programme d'entretien ne porte pas de statut de visite à proprement
 * parler : il porte une échéance et, quand elle est planifiée, un bon de
 * travail. L'étape se déduit donc du bon quand il existe, de l'échéance
 * sinon — et une échéance dépassée passe avant tout le reste, parce que
 * c'est la ligne qu'on doit voir en premier.
 */
type VisitStage = "planned" | "doing" | "validate" | "done" | "late";

const PIPELINE: {
  key: VisitStage;
  label: string;
  emoji: string;
  dot: string;
  border: string;
}[] = [
  {
    key: "planned",
    label: "Planifiées",
    emoji: "📅",
    dot: "bg-blue-500",
    border: "border-t-blue-500",
  },
  {
    key: "doing",
    label: "En cours",
    emoji: "⚡",
    dot: "bg-amber-500",
    border: "border-t-amber-500",
  },
  {
    key: "validate",
    label: "À valider",
    emoji: "📝",
    dot: "bg-purple-500",
    border: "border-t-purple-500",
  },
  {
    key: "done",
    label: "Terminées",
    emoji: "🟢",
    dot: "bg-emerald-500",
    border: "border-t-emerald-500",
  },
  {
    key: "late",
    label: "En retard",
    emoji: "🔴",
    dot: "bg-red-500",
    border: "border-t-red-500",
  },
];

function stageOf(row: ScheduleRow, bucket: ScheduleBucket): VisitStage {
  const status = row.activeWorkOrder?.status;
  if (bucket === "late") return "late";
  if (status === "IN_PROGRESS" || status === "ON_HOLD") return "doing";
  if (status === "PENDING_APPROVAL") return "validate";
  if (status === "OPEN" || status === "ASSIGNED") return "planned";
  if (row.lastCompleted) return "done";
  return "planned";
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export default function EntretienPage() {
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [roster, setRoster] = useState<RosterTechnician[]>([]);
  const [filter, setFilter] = useState<VisitStage>("planned");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** Le programme dont le formulaire de planification est ouvert. */
  const [planningId, setPlanningId] = useState<string | null>(null);
  const [planDate, setPlanDate] = useState("");
  const [planTechnician, setPlanTechnician] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/maintenance-schedules");
      if (!res.ok) throw new Error(`L'API des programmes a répondu ${res.status}`);
      const json = await res.json();
      setRows(json.data ?? []);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Échec du chargement du programme"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The roster is only needed to fill the "assign to" select, so a failure here
  // must not stop the board from rendering: planning without an assignee is a
  // normal case, and losing the whole screen to a secondary lookup would be a
  // worse trade than an empty select.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/technicians")
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((payload) => {
        if (!cancelled) setRoster(payload?.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setRoster([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * One `now` for the whole pass, taken inside the memo rather than kept in
   * state.
   *
   * Every row has to agree with every other about what day it is, and two rows
   * evaluated a millisecond apart could otherwise straddle midnight and
   * disagree. It is recomputed when the rows change — which is exactly when a
   * reload has happened — and not on a timer, because the date it feeds changes
   * at most once a day.
   */
  const evaluated = useMemo(() => {
    const now = new Date();
    return rows.map((row) => {
      const bucketInfo = bucketOf(row, Boolean(row.activeWorkOrder), now);
      return {
        row,
        ...bucketInfo,
        stage: stageOf(row, bucketInfo.bucket),
      };
    });
  }, [rows]);

  const stageCounts = useMemo(() => {
    const count = (stage: VisitStage) =>
      evaluated.filter((entry) => entry.stage === stage).length;
    return {
      planned: count("planned"),
      doing: count("doing"),
      validate: count("validate"),
      done: count("done"),
      late: count("late"),
    } satisfies Record<VisitStage, number>;
  }, [evaluated]);

  const visible = useMemo(
    () => evaluated.filter((entry) => entry.stage === filter),
    [evaluated, filter]
  );

  function openPlanner(row: ScheduleRow) {
    setPlanningId(row.id);
    setActionError(null);
    setNotice(null);
    setPlanTechnician("");
    /**
     * The date starts at the due date when it is still ahead, and at today
     * otherwise: a programme that is three weeks late must not open on a date
     * three weeks in the past, which is what a plain default of `nextDueDate`
     * would produce — and a visit booked in the past is a data error the office
     * would then have to correct.
     */
    const due = new Date(row.nextDueDate);
    const today = new Date();
    setPlanDate(toDateInput(due.getTime() > today.getTime() ? due : today));
  }

  async function plan(row: ScheduleRow) {
    const date = fromDateInput(planDate);
    if (!date) {
      setActionError("Choisissez une date de passage.");
      return;
    }

    setBusyId(row.id);
    setActionError(null);
    setNotice(null);

    try {
      const res = await fetch(`/api/maintenance-schedules/${row.id}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scheduledDate: date.toISOString(),
          ...(planTechnician ? { assignedToId: planTechnician } : {}),
        }),
      });

      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          payload?.error ?? payload?.message ?? "La planification a été refusée."
        );
      }

      setPlanningId(null);
      setNotice(
        `Intervention ${payload.data.orderNumber} créée pour ${payload.data.elevatorCode}.`
      );
      await load({ silent: true });
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "La planification a échoué."
      );
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 rounded-xl bg-gray-100 dark:bg-gray-800 animate-pulse"
            />
          ))}
        </div>
        <div className="h-64 rounded-xl bg-gray-100 dark:bg-gray-800 animate-pulse" />
      </div>
    );
  }

  if (error && rows.length === 0) {
    return <ErrorState message={error} onRetry={load} />;
  }

  return (
    <div className="space-y-6">
      <SectionTabs
        tabs={INTERVENTION_TABS}
        ariaLabel="Interventions et maintenance"
      />

      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
          Visites d&apos;entretien
        </h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Le programme préventif : échéances, visites planifiées et points de
          contrôle.
        </p>
      </div>

      {/* Pipeline horizontal — un clic filtre la liste en dessous. */}
      <div
        className="flex flex-wrap items-stretch gap-1.5"
        role="tablist"
        aria-label="Étapes des visites d'entretien"
      >
        {PIPELINE.map((step, index) => {
          const active = filter === step.key;
          return (
            <div key={step.key} className="flex items-center">
              {index > 0 && (
                <span
                  className="mx-1 hidden h-px w-4 bg-slate-300 sm:block dark:bg-slate-700"
                  aria-hidden="true"
                />
              )}
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(step.key)}
                className={`flex items-center gap-2 rounded-lg border border-t-2 border-slate-200 bg-white px-3 py-2 text-left shadow-sm transition-colors dark:border-slate-800 dark:bg-slate-900 ${step.border} ${
                  active
                    ? "ring-2 ring-blue-500/40"
                    : "hover:bg-slate-50 dark:hover:bg-slate-800/60"
                }`}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full shadow-sm ${step.dot}`}
                  aria-hidden="true"
                />
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-800 dark:text-slate-200">
                  {step.emoji} {step.label}
                </span>
                <span className="rounded-full bg-slate-200 px-2 text-xs font-bold text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                  {stageCounts[step.key]}
                </span>
              </button>
            </div>
          );
        })}

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
          className="rounded-lg bg-green-50 px-3 py-2 text-sm font-medium text-green-800 dark:bg-green-950/40 dark:text-green-300"
        >
          {notice}
        </p>
      )}
      {actionError && (
        <p
          role="alert"
          className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {actionError}
        </p>
      )}

      {visible.length === 0 ? (
        <Card className="p-8 text-center text-sm text-gray-500 dark:text-gray-400">
          Aucune visite à cette étape. Les programmes s&apos;ajoutent depuis la
          fiche de l&apos;ascenseur concerné.
        </Card>
      ) : (
        <div className="space-y-2">
          {visible.map(({ row, bucket, due }) => {
            const isBusy = busyId === row.id;
            const canPlan = row.isActive && !row.activeWorkOrder;
            const technician = row.activeWorkOrder?.assignedTo ?? null;
            const inProgress =
              row.activeWorkOrder?.status === "IN_PROGRESS" ||
              row.activeWorkOrder?.status === "ON_HOLD";

            return (
              <div
                key={row.id}
                className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-center">
                  {/* Appareil & bâtiment */}
                  <div className="min-w-0">
                    <Link
                      href={`/ascenseurs/${row.elevator.id}`}
                      className="font-mono text-sm font-bold text-slate-900 hover:text-blue-600 hover:underline dark:text-white dark:hover:text-blue-400"
                    >
                      {row.elevator.elevatorCode}
                    </Link>
                    <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {row.elevator.building.name} ·{" "}
                      {row.elevator.building.city}
                    </p>
                    <p className="mt-1 inline-flex rounded bg-slate-900 px-2 py-0.5 font-mono text-[10px] font-bold text-white dark:bg-black">
                      🔑{" "}
                      {row.elevator.building.accessCode ?? "non renseigné"}
                    </p>
                  </div>

                  {/* Contrat & fréquence */}
                  <div className="min-w-0">
                    <span className="inline-flex rounded border border-green-200 bg-green-50 px-1.5 py-0.5 text-[10px] font-semibold text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300">
                      Préventif {enumLabel(row.frequency)}
                    </span>
                    <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                      Date :{" "}
                      <span className="font-medium">
                        {new Date(row.nextDueDate).toLocaleDateString("fr-FR")}
                      </span>
                    </p>
                    <div className="mt-1">
                      <DueBadge
                        bucket={bucket}
                        due={due}
                        isActive={row.isActive}
                        cycleThreshold={row.cycleThreshold}
                      />
                    </div>
                  </div>

                  {/* Technicien & avancement */}
                  <div className="min-w-0">
                    {technician ? (
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-slate-900 text-[10px] font-bold text-white dark:bg-slate-700">
                          {initials(technician.name)}
                        </span>
                        <span className="truncate text-xs font-medium text-slate-700 dark:text-slate-300">
                          {technician.name}
                        </span>
                      </div>
                    ) : (
                      <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                        Non affecté
                      </span>
                    )}
                    <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                      Checklist : {row.checklist.length}{" "}
                      {row.checklist.length > 1 ? "points" : "point"}
                      {row.lastCompleted
                        ? ` · dernière visite ${formatDistanceToNow(
                            new Date(row.lastCompleted),
                            { locale: fr, addSuffix: true }
                          )}`
                        : ""}
                    </p>
                  </div>

                  {/* Actions */}
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    {row.activeWorkOrder ? (
                      <Link
                        href={`/bons-de-travail/${row.activeWorkOrder.id}`}
                        className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-bold text-white ${
                          inProgress
                            ? "bg-amber-500 hover:bg-amber-600"
                            : "bg-blue-600 hover:bg-blue-700"
                        }`}
                      >
                        {inProgress ? "📝 Remplir rapport" : "▶️ Démarrer la visite"}
                      </Link>
                    ) : canPlan ? (
                      <button
                        type="button"
                        onClick={() => openPlanner(row)}
                        className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-blue-700"
                      >
                        <CalendarPlus className="h-3 w-3" aria-hidden="true" />
                        Planifier la visite
                      </button>
                    ) : (
                      <span className="text-[11px] text-slate-400">
                        Programme suspendu
                      </span>
                    )}
                  </div>
                </div>

                {canPlan && planningId === row.id && (
                  <div className="mt-3 rounded-lg border border-blue-200 bg-slate-50 p-3 dark:border-blue-900 dark:bg-gray-900/60">
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="text-sm">
                        <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
                          Date de passage
                        </span>
                        <input
                          type="date"
                          value={planDate}
                          onChange={(e) => setPlanDate(e.target.value)}
                          aria-label="Date de passage"
                          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                        />
                      </label>

                      <label className="text-sm">
                        <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
                          Technicien (facultatif)
                        </span>
                        <select
                          value={planTechnician}
                          onChange={(e) => setPlanTechnician(e.target.value)}
                          aria-label="Technicien affecté"
                          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                        >
                          <option value="">
                            Non affecté — le bureau placera
                          </option>
                          {roster.map((tech) => (
                            <option key={tech.id} value={tech.id}>
                              {tech.name} ({tech.openWorkOrders} en cours)
                            </option>
                          ))}
                        </select>
                      </label>

                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void plan(row)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                      >
                        {isBusy ? (
                          <Loader2
                            className="h-4 w-4 animate-spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <CalendarPlus
                            className="h-4 w-4"
                            aria-hidden="true"
                          />
                        )}
                        Créer le bon
                      </button>

                      <button
                        type="button"
                        onClick={() => setPlanningId(null)}
                        className="rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                      >
                        Annuler
                      </button>
                    </div>

                    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                      Le bon reprend la liste de points du programme. Le
                      technicien la cochera point par point dans son portail.
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
