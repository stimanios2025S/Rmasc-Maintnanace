"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
  Ruler,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { ValidationBadge } from "@/components/ui/validation-badge";
import { DispatchModal } from "@/components/admin/dispatch-modal";
import { ContractBadge } from "@/components/admin/contract-badge";
import { allowedTransitions } from "@/lib/incidents/progress";
import { formatDistance } from "@/lib/geo/geofence";
import { enumLabel } from "@/lib/ui/enum-labels";
import { TRAFFIC_LEVELS, priorityTrafficLevel } from "@/lib/ui/traffic";
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
    building: {
      id: string;
      name: string;
      address: string;
      /** La ville, affichée à côté de l'immeuble dans la colonne Accès. */
      city: string;
      /** Code d'accès immeuble / local technique, s'il est renseigné. */
      accessCode: string | null;
    };
  };
  errorCode: { id: string; code: string; title: string } | null;
  /**
   * L'auteur du signalement, quand il a un compte.
   *
   * Nul pour un visiteur qui a scanné le QR d'un appareil : la panne est réelle
   * et doit apparaître au tableau, mais il n'y a personne à rappeler. Le type
   * le dit, au lieu de laisser le rendu découvrir un `null` sous une promesse
   * d'objet et de le traiter par accident.
   */
  client: {
    id: string;
    name: string | null;
    email: string;
    phone: string | null;
    /** NULL reads as CONTRACTED — see `ContractBadge`. */
    clientType: "CONTRACTED" | "NON_CONTRACTED" | null;
  } | null;
  technician: {
    id: string;
    name: string | null;
    email: string;
    /** Le statut temps réel du technicien, pour la colonne Affectation. */
    status: string;
  } | null;
  /**
   * How far the assignee is from the site, as the server worked it out.
   *
   * Optional because a row can reach this screen from a route that does not
   * shape it — the per-incident endpoint returns the bare record — and a
   * missing readout is better than a type that lies about always having one.
   *
   * `ageMs` and `isFresh` are not decoration: a distance with no age on it
   * looks the same whether it was measured ten seconds or three hours ago, and
   * the whole value of this number to a dispatcher is that it is current.
   */
  technicianProximity?: {
    distanceM: number | null;
    radiusM: number;
    withinRadius: boolean;
    ageMs: number | null;
    isFresh: boolean;
  } | null;
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

type IncidentFilter =
  | "all"
  | "urgent_unassigned"
  | "IN_PROGRESS"
  | "resolved";

const FILTERS: { key: IncidentFilter; label: string }[] = [
  { key: "all", label: "Tous" },
  { key: "urgent_unassigned", label: "🔴 Urgences non attribuées" },
  { key: "IN_PROGRESS", label: "⚡ En cours" },
  { key: "resolved", label: "✅ Résolus" },
];

/**
 * Le statut du technicien, tel qu'il se lit dans la colonne Affectation.
 *
 * « En mission » est précisé du site quand la panne est en cours : c'est la
 * différence entre « il est occupé ailleurs » et « il est sur place ». Sans le
 * site, le dispatcheur ouvre la fiche pour savoir s'il peut le déplacer.
 */
function technicianStatusMeta(
  status: string,
  place: string,
  incidentStatus: string
): string {
  switch (status) {
    case "AVAILABLE":
      return "🟢 Disponible";
    case "ON_JOB":
      return incidentStatus === "IN_PROGRESS"
        ? `⚡ En mission sur ${place}`
        : "⚡ En mission";
    case "ON_BREAK":
      return "☕ En pause";
    case "ON_LEAVE":
      return "🔴 En congé";
    case "OFF_DUTY":
      return "🔴 Hors service";
    default:
      return "—";
  }
}

/**
 * Les quatre étapes d'une panne, en une ligne.
 *
 * Remplace la barre de progression épaisse : quatre points et leurs libellés
 * disent la même chose sans occuper une bande de hauteur dans chaque carte.
 */
const INCIDENT_STEPS = [
  { key: "ESCALATED", label: "Signalé" },
  { key: "TECHNICIAN_ASSIGNED", label: "Assigné" },
  { key: "IN_PROGRESS", label: "En cours" },
  { key: "CLOSED", label: "Résolu" },
] as const;

function incidentStepIndex(status: IncidentStatus): number {
  // 4 = toutes les étapes franchies : une panne close ou résolue par le
  // client affiche ses quatre coches, pas une quatrième étape encore active.
  if (status === "CLOSED" || status === "RESOLVED_BY_CLIENT") return 4;
  if (status === "IN_PROGRESS") return 2;
  if (status === "TECHNICIAN_ASSIGNED") return 1;
  return 0;
}

function IncidentStepper({ status }: { status: IncidentStatus }) {
  const current = incidentStepIndex(status);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-slate-100 pt-2 text-[10px] font-medium dark:border-slate-800">
      {INCIDENT_STEPS.map((step, index) => {
        const done = index < current;
        const active = index === current;

        return (
          <span key={step.key} className="inline-flex items-center gap-1.5">
            {index > 0 && (
              <span
                className="h-px w-3 bg-slate-300 dark:bg-slate-700"
                aria-hidden="true"
              />
            )}
            <span
              className={
                done
                  ? "text-emerald-600 dark:text-emerald-400"
                  : active
                    ? "font-bold text-blue-600 dark:text-blue-400"
                    : "text-slate-400 dark:text-slate-500"
              }
            >
              <span
                className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${
                  done
                    ? "bg-emerald-500"
                    : active
                      ? "animate-pulse bg-blue-500"
                      : "bg-slate-300 dark:bg-slate-600"
                }`}
                aria-hidden="true"
              />
              {index + 1}. {step.label}{" "}
              {done ? "✓" : active && step.key === "IN_PROGRESS" ? "⚡" : !active ? "⚪" : ""}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * The télémètre, as a dispatcher reads it.
 *
 * Shown only on a row that has an assignee. A distance to a job nobody has been
 * sent to is not a fact anyone can act on, and drawing it on every escalated
 * row would fill the board with « position inconnue » and teach the eye to skip
 * the line that matters.
 *
 * The three states are three different sentences on purpose. Inside the radius
 * is "he is there". Outside is a number plus the radius it missed. No position
 * at all is neither of those — the phone never answered, which says nothing
 * whatever about where the technician is, and reporting it as zero metres or as
 * "hors rayon" would both be inventions.
 *
 * A stale reading keeps its number and gains its age. Hiding it would lose the
 * last thing we knew; showing it in the same colour as a live one would present
 * a phone that went into a basement twenty minutes ago as a technician standing
 * at the door.
 */
function TechnicianDistance({
  name,
  proximity,
}: {
  name: string;
  proximity: NonNullable<IncidentRow["technicianProximity"]>;
}) {
  const { distanceM, radiusM, withinRadius, ageMs, isFresh } = proximity;

  const tone =
    distanceM !== null && isFresh && withinRadius
      ? "text-emerald-700 dark:text-emerald-400"
      : distanceM !== null && isFresh
        ? "text-amber-700 dark:text-amber-400"
        : "text-gray-500 dark:text-gray-400";

  return (
    <p className={`mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs ${tone}`}>
      {distanceM !== null && (
        <Ruler className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
      )}
      {distanceM === null ? (
        /*
         * Une localisation absente n'est pas une erreur du technicien : son
         * téléphone n'a simplement rien partagé. Le message précédent
         * (« position inconnue ») ressemblait à un échec et invitait à ouvrir
         * une fiche pour rien. Le badge dit l'état réel sans accuser personne.
         */
        <span
          title={`${name} — position non partagée`}
          className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900"
        >
          🟠 En mission · localisation non partagée
        </span>
      ) : (
        <span>
          Distance au chantier :{" "}
          <span className="font-semibold">{formatDistance(distanceM)}</span>
          {withinRadius
            ? ` — dans le rayon de ${formatDistance(radiusM)}`
            : ` — rayon ${formatDistance(radiusM)}`}
        </span>
      )}
      {ageMs !== null && !isFresh && (
        <span className="opacity-80">
          · relevé {formatDistanceToNow(new Date(Date.now() - ageMs), {
            locale: fr,
          })}
        </span>
      )}
    </p>
  );
}

export default function AdminIncidentsPage() {
  const { data: session } = useSession();
  const role = session?.user?.role;
  // Mirrors the server rule in `/api/incidents/[id]` — a field technician sees
  // the board but cannot move work to a colleague.
  const canDispatch = role === "ADMIN" || role === "MAINTENANCE_MANAGER";

  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [filter, setFilter] = useState<IncidentFilter>("all");
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
    if (filter === "urgent_unassigned") {
      // « Urgence non attribuée » = une panne escaladée que personne n'a
      // encore prise. Le filtre porte sur l'affectation, pas sur la gravité :
      // une urgence déjà confiée à quelqu'un n'attend plus un dispatcheur.
      return incidents.filter(
        (incident) => incident.status === "ESCALATED" && !incident.technician
      );
    }
    if (filter === "resolved") {
      return incidents.filter(
        (incident) =>
          incident.status === "CLOSED" ||
          incident.status === "RESOLVED_BY_CLIENT"
      );
    }
    return incidents.filter((incident) => incident.status === filter);
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

              const priority =
                incident.workOrder?.priority ??
                (incident.isDirectTransfer ? "CRITICAL" : "MEDIUM");
              const priorityLevel = priorityTrafficLevel(priority);
              const priorityStyle = TRAFFIC_LEVELS[priorityLevel];
              const priorityLabel =
                priorityLevel === "danger"
                  ? { emoji: "🔴", label: "CRITIQUE" }
                  : priorityLevel === "warning"
                    ? { emoji: "🟠", label: "MOYEN" }
                    : priorityLevel === "ok"
                      ? { emoji: "🟢", label: "ROUTINE" }
                      : { emoji: "⚪", label: "INCONNU" };

              const canClose = nextStatuses.includes("CLOSED");
              const otherTransitions = nextStatuses.filter(
                (next) => next !== "CLOSED"
              );

              return (
                <li
                  key={incident.id}
                  className={`rounded-xl border bg-white p-4 dark:bg-slate-900 ${
                    incident.isDirectTransfer && incident.status === "ESCALATED"
                      ? "border-red-300 dark:border-red-900"
                      : "border-slate-200 dark:border-slate-800"
                  }`}
                >
                  {/*
                    Trois colonnes, une question par colonne : l'appareil et
                    son urgence, ce qui est signalé, puis qui y va et ce qu'on
                    fait. Le stepper remplace la barre de progression : quatre
                    points suffisent à dire où en est la panne, sans occuper
                    une bande entière.
                  */}
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start">
                    {/* 1 — Appareil & urgence */}
                    <div className="min-w-0">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wide ${priorityStyle.bg} ${priorityStyle.text} ${priorityStyle.border}`}
                      >
                        {priorityLabel.emoji} {priorityLabel.label}
                      </span>
                      <p className="mt-1.5 font-mono text-sm font-bold text-slate-900 dark:text-white">
                        {incident.elevator.elevatorCode}
                      </p>
                      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                        {incident.elevator.building.name}
                        {incident.elevator.building.city &&
                          ` · ${incident.elevator.building.city}`}
                      </p>
                      <p className="mt-1.5 inline-flex items-center rounded-lg bg-slate-900 px-2.5 py-1 font-mono text-[11px] font-bold text-white dark:bg-black">
                        🔑{" "}
                        {incident.elevator.building.accessCode ??
                          "non renseigné"}
                      </p>
                      <p className="mt-1.5 text-[10px] uppercase tracking-wide text-slate-400">
                        {formatDistanceToNow(new Date(incident.createdAt), {
                          addSuffix: true,
                          locale: fr,
                        })}
                      </p>
                      {incident.isDirectTransfer &&
                        incident.status === "ESCALATED" && (
                          <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                            <AlertOctagon
                              className="h-3 w-3"
                              aria-hidden="true"
                            />
                            Urgence
                          </span>
                        )}
                    </div>

                    {/* 2 — Incident & signalement */}
                    <div className="min-w-0 lg:border-l lg:border-slate-200 lg:pl-4 dark:lg:border-slate-800">
                      <p className="text-sm font-bold text-slate-900 dark:text-white">
                        {incident.errorCode
                          ? `${incident.errorCode.code} — ${incident.errorCode.title}`
                          : incident.isDirectTransfer
                            ? "Assistance d'urgence demandée"
                            : "Panne signalée"}
                      </p>
                      <p className="mt-1 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
                        {incident.notes ??
                          "Aucune description fournie par le déclarant."}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                        Signalé par{" "}
                        {incident.client
                          ? (incident.client.name ?? incident.client.email)
                          : "un visiteur via le QR public"}
                        {incident.client?.phone
                          ? ` (${incident.client.phone})`
                          : ""}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {incident.client ? (
                          <ContractBadge
                            clientId={incident.client.id}
                            clientType={incident.client.clientType}
                            clientName={
                              incident.client.name ?? incident.client.email
                            }
                          />
                        ) : (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                            Signalement public
                          </span>
                        )}
                        <ValidationBadge status={incident.status} />
                      </div>
                    </div>

                    {/* 3 — Technicien & actions */}
                    <div className="min-w-0 lg:border-l lg:border-slate-200 lg:pl-4 dark:lg:border-slate-800">
                      {incident.technician ? (
                        <>
                          <p className="text-sm font-semibold text-slate-900 dark:text-white">
                            👤{" "}
                            {incident.technician.name ??
                              incident.technician.email}
                          </p>
                          <p className="mt-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-400">
                            {technicianStatusMeta(
                              incident.technician.status,
                              incident.elevator.building.name,
                              incident.status
                            )}
                          </p>
                          {incident.technicianProximity && (
                            <TechnicianDistance
                              name={
                                incident.technician.name ??
                                incident.technician.email
                              }
                              proximity={incident.technicianProximity}
                            />
                          )}
                        </>
                      ) : (
                        <p className="text-xs italic text-slate-400">
                          Non affecté
                        </p>
                      )}

                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Link
                          href={`/ascenseurs/${incident.elevator.id}`}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          📄 Fiche tech
                        </Link>
                        <Link
                          href={
                            incident.workOrder
                              ? `/bons-de-travail/${incident.workOrder.id}`
                              : `/ascenseurs/${incident.elevator.id}`
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          👁️ Consulter
                        </Link>
                        {canClose && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void advance(incident, "CLOSED")}
                            className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1.5 text-[11px] font-bold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
                          >
                            ✅ Clôturer
                          </button>
                        )}
                        {canAssign && (
                          <button
                            type="button"
                            onClick={() => setDispatchTarget(incident)}
                            className="inline-flex items-center gap-1 rounded-lg bg-red-600 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-red-700"
                          >
                            ⚡ Dispatcher
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  <IncidentStepper status={incident.status} />

                  {otherTransitions.length > 0 && (
                    <div className="mt-2 flex flex-wrap justify-end gap-1.5 border-t border-slate-100 pt-2 dark:border-slate-800">
                      {otherTransitions.map((next) => {
                        const Icon = TRANSITION_ICONS[next];
                        return (
                          <button
                            key={next}
                            type="button"
                            disabled={isBusy}
                            onClick={() => void advance(incident, next)}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800"
                          >
                            {isBusy ? (
                              <Loader2
                                className="h-3 w-3 animate-spin"
                                aria-hidden="true"
                              />
                            ) : (
                              <Icon className="h-3 w-3" aria-hidden="true" />
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
