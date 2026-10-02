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
  BUCKET_CARD_STYLES,
  bucketOf,
  type ScheduleBucket,
} from "@/components/maintenance/due-badge";
import type { RosterTechnician } from "@/components/admin/dispatch-modal";
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
    building: { id: string; name: string; address: string; city: string };
  };
  activeWorkOrder: {
    id: string;
    orderNumber: string;
    status: string;
    scheduledDate: string | null;
    assignedTo: { id: string; name: string } | null;
  } | null;
}

const FILTERS: { key: ScheduleBucket | "action" | "all"; label: string }[] = [
  { key: "action", label: "À traiter" },
  { key: "late", label: "En retard" },
  { key: "soon", label: "À échéance" },
  { key: "planned", label: "Déjà planifiées" },
  { key: "upcoming", label: "À venir" },
  { key: "by-usage", label: "À l'usage" },
  { key: "inactive", label: "Suspendus" },
  { key: "all", label: "Tous" },
];

export default function EntretienPage() {
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [roster, setRoster] = useState<RosterTechnician[]>([]);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("action");
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
    return rows.map((row) => ({
      row,
      ...bucketOf(row, Boolean(row.activeWorkOrder), now),
    }));
  }, [rows]);

  const counts = useMemo(() => {
    const by = (bucket: ScheduleBucket) =>
      evaluated.filter((entry) => entry.bucket === bucket).length;
    return {
      late: by("late"),
      soon: by("soon"),
      planned: by("planned"),
      byUsage: by("by-usage"),
      toHandle: by("late") + by("soon"),
    };
  }, [evaluated]);

  const visible = useMemo(() => {
    if (filter === "all") return evaluated;
    if (filter === "action")
      return evaluated.filter(
        (entry) => entry.bucket === "late" || entry.bucket === "soon"
      );
    return evaluated.filter((entry) => entry.bucket === filter);
  }, [evaluated, filter]);

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
        `Bon ${payload.data.orderNumber} créé pour ${payload.data.elevatorCode}.`
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

  const tiles = [
    {
      label: "En retard",
      value: counts.late,
      hint: "échéance dépassée",
      urgent: counts.late > 0,
    },
    {
      label: "À échéance",
      value: counts.soon,
      hint: "sous 30 jours",
      urgent: false,
    },
    {
      label: "Déjà planifiées",
      value: counts.planned,
      hint: "bon ouvert",
      urgent: false,
    },
    {
      label: "À l'usage",
      value: counts.byUsage,
      hint: "sans échéance calculable",
      urgent: false,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {tiles.map((tile) => (
          <Card
            key={tile.label}
            className={`p-4 ${tile.urgent ? "border-red-300 dark:border-red-900" : ""}`}
          >
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {tile.label}
            </p>
            <p
              className={`mt-1 text-3xl font-bold tabular-nums ${
                tile.urgent
                  ? "text-red-600 dark:text-red-400"
                  : "text-gray-900 dark:text-white"
              }`}
            >
              {tile.value}
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {tile.hint}
            </p>
          </Card>
        ))}
      </div>

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            role="tablist"
            aria-label="Filtrer le programme d'entretien"
            className="flex flex-wrap gap-1.5"
          >
            {FILTERS.map((option) => (
              <button
                key={option.key}
                type="button"
                role="tab"
                aria-selected={filter === option.key}
                onClick={() => setFilter(option.key)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  filter === option.key
                    ? "bg-blue-600 text-white"
                    : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                }`}
              >
                {option.label}
                {option.key === "action" && counts.toHandle > 0 && (
                  <span className="ml-1.5 rounded-full bg-white/20 px-1.5 text-xs tabular-nums">
                    {counts.toHandle}
                  </span>
                )}
              </button>
            ))}
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

        {notice && (
          <p
            role="status"
            className="mt-4 rounded-lg bg-green-50 dark:bg-green-950/40 px-3 py-2 text-sm font-medium text-green-800 dark:text-green-300"
          >
            {notice}
          </p>
        )}

        {actionError && (
          <p
            role="alert"
            className="mt-4 rounded-lg bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm font-medium text-red-800 dark:text-red-300"
          >
            {actionError}
          </p>
        )}

        {visible.length === 0 ? (
          <p className="mt-6 text-sm text-gray-500 dark:text-gray-400">
            Rien à afficher. Les programmes s&apos;ajoutent depuis la fiche de
            l&apos;ascenseur concerné.
          </p>
        ) : (
          <ul className="mt-5 space-y-4">
            {visible.map(({ row, bucket, due }) => {
              const isBusy = busyId === row.id;
              const canPlan = row.isActive && !row.activeWorkOrder;

              return (
                <li
                  key={row.id}
                  className={`rounded-xl border p-4 ${BUCKET_CARD_STYLES[bucket]}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-gray-900 dark:text-white">
                      {row.title}
                    </span>
                    {/*
                      The code leads to the machine's sheet, which is where the
                      programme is created and edited. A dashboard that says
                      "this is late" without offering the way to fix the terms
                      of the contract sends the reader hunting through the menu.
                    */}
                    <Link
                      href={`/ascenseurs/${row.elevator.id}`}
                      className="font-mono text-xs text-blue-700 underline decoration-dotted underline-offset-2 dark:text-blue-400"
                    >
                      {row.elevator.elevatorCode}
                    </Link>
                    <span className="text-sm text-gray-500 dark:text-gray-400">
                      {row.elevator.building.name} · {row.elevator.building.city}
                    </span>

                    <span className="inline-flex items-center gap-1 rounded-full border border-gray-300 dark:border-gray-700 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-600 dark:text-gray-300">
                      {enumLabel(row.frequency)}
                    </span>

                    <DueBadge
                      bucket={bucket}
                      due={due}
                      isActive={row.isActive}
                      cycleThreshold={row.cycleThreshold}
                    />

                    <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">
                      {row.lastCompleted
                        ? `Dernière visite ${formatDistanceToNow(
                            new Date(row.lastCompleted),
                            { locale: fr, addSuffix: true }
                          )}`
                        : "Aucune visite enregistrée"}
                    </span>
                  </div>

                  <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                    Échéance au{" "}
                    <span className="font-medium">
                      {new Date(row.nextDueDate).toLocaleDateString("fr-FR")}
                    </span>
                    {row.description ? ` — ${row.description}` : ""}
                  </p>

                  <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                    {row.checklist.length === 0 ? (
                      <>
                        Aucun point de contrôle — le technicien utilisera la
                        liste standard.
                      </>
                    ) : (
                      <>
                        {row.checklist.length}{" "}
                        {row.checklist.length > 1
                          ? "points de contrôle"
                          : "point de contrôle"}
                        {" · "}
                        {row.checklist
                          .slice(0, 3)
                          .map((item) => item.name)
                          .join(" · ")}
                        {row.checklist.length > 3 ? " · …" : ""}
                      </>
                    )}
                  </p>

                  {row.activeWorkOrder && (
                    <p className="mt-2 text-sm text-blue-800 dark:text-blue-300">
                      Visite planifiée —{" "}
                      <Link
                        href={`/bons-de-travail/${row.activeWorkOrder.id}`}
                        className="font-semibold underline decoration-dotted underline-offset-2"
                      >
                        bon {row.activeWorkOrder.orderNumber}
                      </Link>
                      {row.activeWorkOrder.scheduledDate
                        ? ` pour le ${new Date(
                            row.activeWorkOrder.scheduledDate
                          ).toLocaleDateString("fr-FR")}`
                        : " (date non fixée)"}
                      {row.activeWorkOrder.assignedTo
                        ? ` · ${row.activeWorkOrder.assignedTo.name}`
                        : " · personne affectée"}
                    </p>
                  )}

                  {canPlan && planningId !== row.id && (
                    <div className="mt-4">
                      <button
                        type="button"
                        onClick={() => openPlanner(row)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
                      >
                        <CalendarPlus className="h-4 w-4" aria-hidden="true" />
                        Planifier la visite
                      </button>
                    </div>
                  )}

                  {canPlan && planningId === row.id && (
                    <div className="mt-4 rounded-lg border border-blue-200 bg-white/70 p-3 dark:border-blue-900 dark:bg-gray-900/60">
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
                            <option value="">Non affecté — le bureau placera</option>
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
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
