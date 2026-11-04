"use client";

/**
 * Le suivi RH et terrain de l'équipe technique.
 *
 * POURQUOI CET ÉCRAN EXISTE
 * Le cockpit `/technicien` dit à un technicien ce qu'il a à faire. Le bureau,
 * lui, n'avait aucun endroit qui réponde à la question inverse : « qui est
 * disponible, qui est sur quel site, et depuis quand ? ». La seule façon de le
 * savoir était d'appeler. Cette page rend l'équipe lisible d'un coup d'œil.
 *
 * CE QUE CHAQUE CARTE PORTE, ET POURQUOI
 * - Le statut réel, y compris « hors service » : la route reçoit `all=1` pour
 *   cela, alors que le sélecteur de dispatch garde la liste restreinte aux
 *   joignables.
 * - La mission en cours avec l'immeuble, l'adresse et l'heure de début : c'est
 *   ce qu'on demande au téléphone avant de décider si l'on peut déplacer
 *   quelqu'un.
 * - La charge du jour, terminées / restantes.
 * - Le dernier code d'accès du site où il a travaillé. Ce n'est pas un journal
 *   d'usage — la base n'en tient pas —, c'est le code du dernier appareil
 *   effectivement touché ; le libellé le dit ainsi.
 *
 * « ATTRIBUER UNE MISSION » OUVRE UN VRAI SÉLECTEUR
 * Le bouton n'est pas un lien vers un autre écran : il liste les bons ouverts
 * non affectés et écrit `assignedToId` par la route des bons. Un lien aurait
 * laissé le geste à faire ailleurs, alors que c'est ici qu'on décide.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import {
  CheckCircle2,
  Clock,
  Loader2,
  MessageCircle,
  Phone,
  RefreshCw,
  UserPlus,
  X,
  Zap,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";

interface Mission {
  orderId: string;
  status: string;
  elevatorCode: string;
  buildingName: string;
  address: string;
  accessCode: string | null;
  startedAt: string | null;
}

interface TechnicianRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  openWorkOrders: number;
  openIncidents: number;
  currentBuilding: string | null;
  currentMission: Mission | null;
  completedToday: number;
  remainingToday: number;
  lastAccessCode: string | null;
}

interface OpenOrder {
  id: string;
  orderNumber: string;
  title: string;
  priority: string;
  status: string;
  elevator: { elevatorCode: string; building: { name: string } };
  assignedTo: { id: string; name: string } | null;
}

/**
 * Les quatre états, avec le vocabulaire du cahier des charges.
 *
 * `OFF_DUTY` et `ON_LEAVE` partagent « Hors service » : du point de vue du
 * bureau, les deux veulent dire « ne pas compter sur lui aujourd'hui ».
 */
const STATUS_META: Record<
  string,
  { emoji: string; label: string; badge: string; dot: string }
> = {
  AVAILABLE: {
    emoji: "🟢",
    label: "Disponible",
    badge:
      "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
    dot: "bg-emerald-500",
  },
  ON_JOB: {
    emoji: "⚡",
    label: "En mission",
    badge:
      "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900",
    dot: "bg-blue-500",
  },
  ON_BREAK: {
    emoji: "☕",
    label: "En repos / Pause",
    badge:
      "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
    dot: "bg-amber-500",
  },
  OFF_DUTY: {
    emoji: "🔴",
    label: "Hors service",
    badge:
      "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900",
    dot: "bg-red-500",
  },
  ON_LEAVE: {
    emoji: "🔴",
    label: "Hors service",
    badge:
      "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900",
    dot: "bg-red-500",
  },
};

/** Les initiales, pour l'avatar quand aucune photo n'est disponible. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function whatsappHref(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, "");
  return digits.length >= 8 ? `https://wa.me/${digits}` : null;
}

export default function TechnicianFleetPage() {
  const [rows, setRows] = useState<TechnicianRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [assignTarget, setAssignTarget] = useState<TechnicianRow | null>(null);

  const load = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/technicians?all=1");
      if (!res.ok) throw new Error(`La flotte a répondu ${res.status}.`);
      const json = await res.json();
      setRows(Array.isArray(json.data) ? json.data : []);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Impossible de charger la flotte."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Le suivi se rafraîchit seul : un statut de terrain change sans que
    // personne ne pense à recharger la page.
    const id = window.setInterval(() => void load({ silent: true }), 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  const counts = useMemo(() => {
    const byStatus = new Map<string, number>();
    for (const row of rows) {
      byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
    }
    return {
      available: byStatus.get("AVAILABLE") ?? 0,
      onJob: byStatus.get("ON_JOB") ?? 0,
      break: byStatus.get("ON_BREAK") ?? 0,
      off: (byStatus.get("OFF_DUTY") ?? 0) + (byStatus.get("ON_LEAVE") ?? 0),
    };
  }, [rows]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            Suivi de la Flotte Techniciens
          </h2>
          <p className="mt-1 text-gray-500">
            Disponibilité, mission en cours et charge du jour, technicien par
            technicien.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 self-start rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Actualiser
        </button>
      </div>

      {notice && (
        <p
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
        >
          {notice}
        </p>
      )}

      {!loading && !error && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Disponibles", value: counts.available, tone: "text-emerald-600" },
            { label: "En mission", value: counts.onJob, tone: "text-blue-600" },
            { label: "En pause", value: counts.break, tone: "text-amber-600" },
            { label: "Hors service", value: counts.off, tone: "text-red-600" },
          ].map((item) => (
            <Card key={item.label} className="p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {item.label}
              </p>
              <p className={`mt-1 text-2xl font-extrabold ${item.tone}`}>
                {item.value}
              </p>
            </Card>
          ))}
        </div>
      )}

      {loading ? (
        <LoadingSkeleton rows={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={UserPlus}
          title="Aucun technicien enregistré"
          description="Créez un compte technicien depuis Personnel pour qu'il apparaisse ici."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => {
            const meta = STATUS_META[row.status] ?? STATUS_META.OFF_DUTY;
            const wa = whatsappHref(row.phone);
            const mission = row.currentMission;

            return (
              <Card key={row.id} className="flex flex-col p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-gray-900 text-sm font-bold text-white dark:bg-gray-700">
                    {initials(row.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-base font-bold text-gray-900 dark:text-white">
                      {row.name}
                    </p>
                    <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                      {row.email}
                    </p>
                  </div>
                  <span
                    className={`inline-flex flex-none items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-bold ${meta.badge}`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${meta.dot}`}
                      aria-hidden="true"
                    />
                    {meta.label}
                  </span>
                </div>

                {/* La mission en cours, quand il y en a une. */}
                {row.status === "ON_JOB" && mission ? (
                  <div className="mt-3 rounded-xl border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-900 dark:bg-blue-950/20">
                    <p className="text-sm font-semibold text-blue-900 dark:text-blue-200">
                      {mission.buildingName}
                    </p>
                    <p className="mt-0.5 text-xs text-blue-800/80 dark:text-blue-300/80">
                      {mission.address}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-blue-800/70 dark:text-blue-300/70">
                      <span className="font-mono">{mission.elevatorCode}</span>
                      {mission.startedAt && (
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" aria-hidden="true" />
                          depuis{" "}
                          {format(new Date(mission.startedAt), "HH:mm", {
                            locale: fr,
                          })}
                        </span>
                      )}
                    </p>
                  </div>
                ) : row.status === "AVAILABLE" ? (
                  <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs font-medium text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300">
                    Aucune mission active
                  </p>
                ) : null}

                {/* Charge du jour. */}
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-800/60">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Terminées
                    </p>
                    <p className="flex items-center gap-1 text-lg font-bold text-gray-900 dark:text-white">
                      <CheckCircle2
                        className="h-4 w-4 text-emerald-500"
                        aria-hidden="true"
                      />
                      {row.completedToday}
                    </p>
                  </div>
                  <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-800/60">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Restantes
                    </p>
                    <p className="flex items-center gap-1 text-lg font-bold text-gray-900 dark:text-white">
                      <Clock
                        className="h-4 w-4 text-amber-500"
                        aria-hidden="true"
                      />
                      {row.remainingToday}
                    </p>
                  </div>
                </div>

                {/* Le dernier code d'accès. */}
                <p className="mt-3 inline-flex items-center gap-1.5 self-start rounded-lg bg-gray-900 px-2.5 py-1.5 font-mono text-[11px] font-bold text-white dark:bg-black">
                  🔑 Code : {row.lastAccessCode ?? "non renseigné"}
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-800">
                  {wa ? (
                    <a
                      href={wa}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-emerald-700"
                    >
                      <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
                      Contacter sur WhatsApp
                    </a>
                  ) : (
                    <span
                      title="Aucun numéro renseigné sur la fiche"
                      className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg bg-gray-100 px-2.5 py-1.5 text-[11px] font-bold text-gray-400 dark:bg-gray-800"
                    >
                      <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                      Sans numéro
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setAssignTarget(row)}
                    className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-blue-700"
                  >
                    <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                    Attribuer une mission
                  </button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {assignTarget && (
        <AssignMissionModal
          technician={assignTarget}
          onClose={() => setAssignTarget(null)}
          onAssigned={(orderNumber) => {
            setAssignTarget(null);
            setNotice(
              `Mission ${orderNumber} attribuée à ${assignTarget.name}.`
            );
            void load({ silent: true });
          }}
        />
      )}
    </div>
  );
}

/**
 * Le sélecteur de mission.
 *
 * Il ne liste que les bons ouverts **non affectés** : réaffecter d'autorité le
 * travail de quelqu'un d'autre est une décision qui se prend sur le tableau des
 * interventions, où l'on voit ce qu'on retire. Ici, on donne du travail qui
 * n'attend personne — ce que le bouton promet.
 */
function AssignMissionModal({
  technician,
  onClose,
  onAssigned,
}: {
  technician: TechnicianRow;
  onClose: () => void;
  onAssigned: (orderNumber: string) => void;
}) {
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetch("/api/work-orders?status=OPEN&limit=100")
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((payload) => {
        if (cancelled) return;
        const rows: OpenOrder[] = Array.isArray(payload?.data) ? payload.data : [];
        setOrders(rows.filter((order) => !order.assignedTo));
      })
      .catch(() => {
        if (!cancelled) setError("Impossible de charger les bons ouverts.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function assign(order: OpenOrder) {
    setBusyId(order.id);
    setError("");
    try {
      const res = await fetch(`/api/work-orders?id=${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedToId: technician.id }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(
          payload?.error ?? payload?.message ?? "L'affectation a échoué."
        );
      }
      onAssigned(order.orderNumber);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "L'affectation a échoué."
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="assign-heading"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl dark:bg-gray-900">
        <header className="flex items-start justify-between gap-4 border-b border-gray-200 p-5 dark:border-gray-800">
          <div>
            <h2
              id="assign-heading"
              className="text-lg font-bold text-gray-900 dark:text-white"
            >
              Attribuer une mission
            </h2>
            <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
              {technician.name} · bons ouverts non affectés
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="max-h-[60vh] overflow-y-auto p-5">
          {loading && (
            <p className="flex items-center gap-2 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Chargement des bons…
            </p>
          )}

          {!loading && orders.length === 0 && !error && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Aucun bon ouvert sans affectation. Les urgences se dispatchent
              depuis le tableau de bord.
            </p>
          )}

          {!loading && orders.length > 0 && (
            <ul className="space-y-2">
              {orders.map((order) => (
                <li key={order.id}>
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void assign(order)}
                    className="flex w-full items-start gap-3 rounded-xl border-2 border-gray-200 p-3 text-left transition-colors hover:border-blue-400 hover:bg-blue-50/50 disabled:opacity-60 dark:border-gray-700 dark:hover:border-blue-700 dark:hover:bg-blue-950/20"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-gray-900 dark:text-white">
                        {order.title}
                      </span>
                      <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                        {order.elevator.building.name} ·{" "}
                        {order.elevator.elevatorCode} ·{" "}
                        {order.priority === "CRITICAL" ||
                        order.priority === "EMERGENCY"
                          ? "🔴 Urgent"
                          : order.priority === "HIGH"
                            ? "🟠 Élevée"
                            : "🟢 Normale"}
                      </span>
                    </span>
                    {busyId === order.id ? (
                      <Loader2
                        className="mt-0.5 h-4 w-4 animate-spin text-blue-600"
                        aria-hidden="true"
                      />
                    ) : (
                      <Zap
                        className="mt-0.5 h-4 w-4 text-blue-600"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {error && (
            <p
              role="alert"
              className="mt-3 text-sm font-medium text-red-700 dark:text-red-400"
            >
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
