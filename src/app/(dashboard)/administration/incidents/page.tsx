"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import {
  AlertOctagon,
  Loader2,
  RefreshCw,
  PlayCircle,
  CheckCircle2,
  RotateCcw,
  UserPlus,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { ProgressTrack } from "@/components/ui/progress-track";
import { ValidationBadge } from "@/components/ui/validation-badge";
import { DispatchModal } from "@/components/admin/dispatch-modal";
import { allowedTransitions } from "@/lib/incidents/progress";
import { enumLabel } from "@/lib/ui/enum-labels";
import type { IncidentStatus } from "@/types";

/**
 * The incident board — where a client's unanswered fault lands.
 *
 * SERVER ORDER, NOT CLIENT ORDER
 * A fault someone pressed the red button over has no description, no error
 * code and no triage; it is the least actionable row on the page and the most
 * urgent. Sorting by status (Postgres orders the enum by declaration order,
 * which is pipeline order) then by age puts escalated, oldest-first at the
 * top, so the top of the board is always the next thing to pick up.
 *
 * DIRECT TRANSFERS ARE MARKED, NOT SEPARATED
 * They get a red badge and a sort boost, but they stay in the same list. A
 * separate emergency queue becomes a place nobody looks.
 */

interface IncidentRow {
  id: string;
  incidentNumber: string;
  status: IncidentStatus;
  isDirectTransfer: boolean;
  notes: string | null;
  createdAt: string;
  resolvedAt: string | null;
  elevator: {
    id: string;
    elevatorCode: string;
    building: { id: string; name: string; address: string };
  };
  errorCode: { id: string; code: string; title: string } | null;
  client: { id: string; name: string | null; email: string; phone: string | null };
  technician: { id: string; name: string | null; email: string } | null;
  workOrder: {
    id: string;
    orderNumber: string;
    status: string;
    priority: string;
  } | null;
}

/** Labels for the status an action moves an incident *to*. */
const TRANSITION_LABELS: Record<IncidentStatus, string> = {
  ESCALATED: "Renvoyer en file",
  TECHNICIAN_ASSIGNED: "Affecter",
  IN_PROGRESS: "Démarrer l'intervention",
  CLOSED: "Clôturer",
  RESOLVED_BY_CLIENT: "Résolu par le client",
};

const TRANSITION_ICONS: Record<IncidentStatus, typeof PlayCircle> = {
  ESCALATED: RotateCcw,
  TECHNICIAN_ASSIGNED: UserPlus,
  IN_PROGRESS: PlayCircle,
  CLOSED: CheckCircle2,
  RESOLVED_BY_CLIENT: CheckCircle2,
};

const FILTERS: { key: "open" | IncidentStatus | "all"; label: string }[] = [
  { key: "open", label: "À traiter" },
  { key: "ESCALATED", label: "En attente d'affectation" },
  { key: "TECHNICIAN_ASSIGNED", label: "Affecté" },
  { key: "IN_PROGRESS", label: "En cours" },
  { key: "CLOSED", label: "Clôturé" },
  { key: "RESOLVED_BY_CLIENT", label: "Résolu par le client" },
  { key: "all", label: "Tous" },
];

const OPEN_STATUSES: readonly IncidentStatus[] = [
  "ESCALATED",
  "TECHNICIAN_ASSIGNED",
  "IN_PROGRESS",
];

export default function AdminIncidentsPage() {
  const { data: session } = useSession();
  const role = session?.user?.role;
  // Mirrors the server rule in `/api/incidents/[id]` — a field technician sees
  // the board but cannot move work to a colleague.
  const canDispatch = role === "ADMIN" || role === "MAINTENANCE_MANAGER";

  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("open");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dispatchTarget, setDispatchTarget] = useState<IncidentRow | null>(null);

  const load = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/incidents?limit=100");
      if (!res.ok)
        throw new Error(`L'API des incidents a répondu ${res.status}`);
      const json = await res.json();
      setIncidents(json.data ?? []);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Échec du chargement des incidents"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Polling keeps an operator's board live while a technician closes a job in
  // another tab. The interval is slower than the dashboard's because nothing
  // here is a streaming sensor reading.
  useEffect(() => {
    const id = setInterval(() => void load({ silent: true }), 45_000);
    return () => clearInterval(id);
  }, [load]);

  const visible = useMemo(() => {
    if (filter === "all") return incidents;
    if (filter === "open") {
      return incidents.filter((i) => OPEN_STATUSES.includes(i.status));
    }
    return incidents.filter((i) => i.status === filter);
  }, [incidents, filter]);

  const counts = useMemo(
    () => ({
      awaiting: incidents.filter((i) => i.status === "ESCALATED").length,
      emergencies: incidents.filter(
        (i) => i.status === "ESCALATED" && i.isDirectTransfer
      ).length,
      active: incidents.filter((i) => i.status === "IN_PROGRESS").length,
      selfResolved: incidents.filter((i) => i.status === "RESOLVED_BY_CLIENT")
        .length,
    }),
    [incidents]
  );

  async function advance(incident: IncidentRow, next: IncidentStatus) {
    setBusyId(incident.id);
    setActionError(null);

    try {
      const res = await fetch(`/api/incidents/${incident.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "status", status: next }),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(
          payload?.error ?? payload?.message ?? "La mise à jour a été refusée."
        );
      }

      await load({ silent: true });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "La mise à jour a échoué.");
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

  if (error && incidents.length === 0) {
    return <ErrorState message={error} onRetry={load} />;
  }

  const tiles = [
    {
      label: "En attente d'affectation",
      value: counts.awaiting,
      hint:
        counts.emergencies > 0
          ? `${counts.emergencies} ${
              counts.emergencies > 1 ? "urgences" : "urgence"
            }`
          : "aucune urgence",
      urgent: counts.emergencies > 0,
    },
    {
      label: "En cours",
      value: counts.active,
      hint: "technicien sur site",
      urgent: false,
    },
    {
      label: "Résolus par le client",
      value: counts.selfResolved,
      hint: "sans intervention",
      urgent: false,
    },
    {
      label: "Total enregistré",
      value: incidents.length,
      hint: "depuis l'origine",
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
            aria-label="Filtrer les incidents"
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
            Rien à afficher. Les incidents signalés depuis l&apos;espace client
            apparaissent dans cette liste.
          </p>
        ) : (
          <ul className="mt-5 space-y-4">
            {visible.map((incident) => {
              const nextStatuses = allowedTransitions(incident.status).filter(
                // A client-only action and the modal's own target; both are
                // excluded from the inline buttons rather than shown disabled.
                (s) => s !== "RESOLVED_BY_CLIENT" && s !== "TECHNICIAN_ASSIGNED"
              );
              const canAssign =
                canDispatch && incident.status === "ESCALATED";
              const isBusy = busyId === incident.id;

              return (
                <li
                  key={incident.id}
                  className={`rounded-xl border p-4 ${
                    incident.isDirectTransfer && incident.status === "ESCALATED"
                      ? "border-red-300 bg-red-50/50 dark:border-red-900 dark:bg-red-950/20"
                      : "border-gray-200 dark:border-gray-800"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                      {incident.incidentNumber}
                    </span>
                    <span className="font-semibold text-gray-900 dark:text-white">
                      {incident.elevator.elevatorCode}
                    </span>
                    <span className="text-sm text-gray-500 dark:text-gray-400">
                      {incident.elevator.building.name}
                    </span>

                    {incident.isDirectTransfer && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                        <AlertOctagon className="h-3 w-3" aria-hidden="true" />
                        Urgence
                      </span>
                    )}

                    <ValidationBadge status={incident.status} />

                    <span className="ml-auto text-xs text-gray-400">
                      {formatDistanceToNow(new Date(incident.createdAt), {
                        addSuffix: true,
                        locale: fr,
                      })}
                    </span>
                  </div>

                  <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                    {incident.errorCode && (
                      <>
                        <span className="font-mono font-semibold text-blue-700 dark:text-blue-400">
                          {incident.errorCode.code}
                        </span>{" "}
                        — {incident.errorCode.title}.{" "}
                      </>
                    )}
                    {incident.notes ??
                      (incident.isDirectTransfer
                        ? "Assistance d'urgence demandée — aucune description de la panne fournie."
                        : "Aucune description fournie.")}
                  </p>

                  <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                    Signalé par{" "}
                    {incident.client.name ?? incident.client.email}
                    {incident.client.phone ? ` · ${incident.client.phone}` : ""}
                    {incident.technician
                      ? ` · Sur place : ${
                          incident.technician.name ?? incident.technician.email
                        }`
                      : ""}
                    {incident.workOrder
                      ? ` · BT ${incident.workOrder.orderNumber} (${enumLabel(
                          incident.workOrder.priority
                        )})`
                      : ""}
                  </p>

                  <ProgressTrack status={incident.status} className="mt-3" />

                  {(canAssign || nextStatuses.length > 0) && (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {canAssign && (
                        <button
                          type="button"
                          onClick={() => setDispatchTarget(incident)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
                        >
                          <UserPlus className="h-4 w-4" aria-hidden="true" />
                          Affecter un technicien
                        </button>
                      )}

                      {nextStatuses.map((next) => {
                        const Icon = TRANSITION_ICONS[next];
                        return (
                          <button
                            key={next}
                            type="button"
                            disabled={isBusy}
                            onClick={() => void advance(incident, next)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-800"
                          >
                            {isBusy ? (
                              <Loader2
                                className="h-4 w-4 animate-spin"
                                aria-hidden="true"
                              />
                            ) : (
                              <Icon className="h-4 w-4" aria-hidden="true" />
                            )}
                            {TRANSITION_LABELS[next]}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <DispatchModal
        incident={
          dispatchTarget
            ? {
                id: dispatchTarget.id,
                incidentNumber: dispatchTarget.incidentNumber,
                elevatorCode: dispatchTarget.elevator.elevatorCode,
              }
            : null
        }
        onClose={() => setDispatchTarget(null)}
        onDispatched={() => {
          setDispatchTarget(null);
          void load({ silent: true });
        }}
      />
    </div>
  );
}
