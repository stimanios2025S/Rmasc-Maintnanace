"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  BellRing,
  CheckCheck,
  Eye,
  Loader2,
  MapPin,
  Zap,
} from "lucide-react";
import { DispatchModal } from "@/components/admin/dispatch-modal";
import { coordinatesOf } from "@/lib/map/directions";

/**
 * The user's own notification tray.
 *
 * Separate from the alert bell beside it: an alert is a machine saying the
 * fleet has a problem, a notification is a message addressed to one person
 * ("this incident is yours", "the fault you reported was closed"). They are
 * read differently and one cannot stand in for the other.
 *
 * Best effort throughout. A failure to load, or to mark read, must leave the
 * chrome intact — a broken mailbox is not a reason to lose the sidebar.
 */

interface NotificationRow {
  id: string;
  title: string;
  message: string;
  type: string;
  linkUrl: string | null;
  isRead: boolean;
  createdAt: string;
  /** Le bon concerné, quand la notification en désigne un. */
  workOrder?: {
    id: string;
    priority: string;
    status: string;
    title: string;
    description: string | null;
    elevator: {
      id: string;
      elevatorCode: string;
      building: {
        id: string;
        name: string;
        city: string;
        address: string;
        accessCode: string | null;
        latitude: number | null;
        longitude: number | null;
      };
    };
    incident: {
      /** Renseignés pour que la cloche du bureau puisse dispatcher d'ici. */
      id: string;
      incidentNumber: string;
      status: string;
      notes: string | null;
      errorCode: { code: string; title: string } | null;
    } | null;
  } | null;
}

/**
 * Le feu tricolore d'une notification.
 *
 * `EMERGENCY` n'est pas une priorité de bon de travail dans l'enum, mais il
 * apparaît dans les charges utiles historiques : on le traite comme le rouge
 * plutôt que de le laisser sans témoin.
 */
type Urgency = "red" | "orange" | "green" | "neutral";

function urgencyOf(row: NotificationRow): Urgency {
  const priority = row.workOrder?.priority;
  if (priority === "CRITICAL" || priority === "HIGH" || priority === "EMERGENCY") {
    return "red";
  }
  if (priority === "MEDIUM") return "orange";
  if (priority === "LOW") return "green";
  return "neutral";
}

const URGENCY_META: Record<
  Urgency,
  { emoji: string; label: string; badge: string; light: string }
> = {
  red: {
    emoji: "🔴",
    label: "URGENT / CRITIQUE",
    badge: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
    light: "bg-red-600",
  },
  orange: {
    emoji: "🟠",
    label: "À TRAITER / MOYEN",
    badge:
      "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
    light: "bg-amber-500",
  },
  green: {
    emoji: "🟢",
    label: "ROUTINE",
    badge:
      "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300",
    light: "bg-green-600",
  },
  neutral: {
    emoji: "⚪",
    label: "INFO",
    badge: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
    light: "bg-gray-400",
  },
};

/** Le témoin : anneau qui pulse pour le rouge, point plein sinon. */
function UrgencyLight({ urgency }: { urgency: Urgency }) {
  const color = URGENCY_META[urgency].light;

  if (urgency === "red") {
    return (
      <span className="relative mt-1 flex h-2.5 w-2.5 flex-shrink-0">
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full ${color} opacity-70`}
          aria-hidden="true"
        />
        <span
          className={`relative inline-flex h-2.5 w-2.5 rounded-full ${color}`}
          aria-hidden="true"
        />
      </span>
    );
  }

  return (
    <span
      className={`mt-1 h-2.5 w-2.5 flex-shrink-0 rounded-full ${color}`}
      aria-hidden="true"
    />
  );
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor((Date.now() - then) / 60_000);

  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.floor(hours / 24)} j`;
}

export function NotificationBell({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const { data: session } = useSession();
  const role = session?.user?.role;
  const isTechnician = role === "FIELD_TECHNICIAN";
  /**
   * Les deux rôles qui dispatchent. Même règle que le tableau des incidents
   * (`ADMIN`, `MAINTENANCE_MANAGER`) : la cloche ne doit pas offrir un geste
   * que la route refusera.
   */
  const canDispatch = role === "ADMIN" || role === "MAINTENANCE_MANAGER";
  /**
   * Les rôles qui peuvent ouvrir la fiche du bon : le bureau et le terrain.
   * Un compte client garde son lien de suivi, pas l'écran interne.
   */
  const canSeeWorkOrder =
    role === "ADMIN" ||
    role === "MAINTENANCE_MANAGER" ||
    role === "FIELD_TECHNICIAN";
  /** La carte est un écran interne ; le portail client n'y mène pas. */
  const canSeeMap = canSeeWorkOrder;
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  /** La panne dont le sélecteur de technicien est ouvert, s'il l'est. */
  const [dispatchTarget, setDispatchTarget] = useState<{
    id: string;
    incidentNumber: string;
    elevatorCode: string;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications?limit=8");
      if (!res.ok) return;
      const json = await res.json();
      setRows(Array.isArray(json.data) ? json.data : []);
      setUnread(typeof json.unread === "number" ? json.unread : 0);
    } catch {
      // Keep the tray quiet.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => clearInterval(id);
  }, [enabled, load]);

  // Close on an outside click or Escape. A dropdown that only closes via its
  // own trigger is a small but real keyboard trap.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function openRow(row: NotificationRow) {
    setOpen(false);

    // Optimistic: the badge drops immediately, and a failed write only means
    // the row comes back unread on the next poll.
    if (!row.isRead) {
      setUnread((n) => Math.max(0, n - 1));
      setRows((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, isRead: true } : r))
      );
      // Route unitaire : le `userId` est dans son WHERE, donc marquer la
      // notification de quelqu'un d'autre est impossible à exprimer.
      void fetch(`/api/notifications/${row.id}`, {
        method: "PATCH",
      }).catch(() => undefined);
    }

    if (row.linkUrl) router.push(row.linkUrl);
  }

  /** Marque lue sans naviguer : c'est le geste qui arrête le clignotement. */
  function markRead(row: NotificationRow) {
    if (row.isRead) return;

    setUnread((n) => Math.max(0, n - 1));
    setRows((prev) =>
      prev.map((r) => (r.id === row.id ? { ...r, isRead: true } : r))
    );
    void fetch(`/api/notifications/${row.id}`, {
      method: "PATCH",
    }).catch(() => undefined);
  }

  /**
   * Ouvre la fiche du bon, avec la route du rôle.
   *
   * Le terrain a son propre écran d'intervention ; le bureau lit la fiche
   * complète. La notification est marquée lue avant la navigation, y compris
   * quand la fiche est atteinte par un lien direct.
   */
  function viewWorkOrder(row: NotificationRow) {
    markRead(row);
    setOpen(false);
    const id = row.workOrder?.id;
    if (!id) return;
    router.push(
      isTechnician
        ? `/technicien/interventions/${id}`
        : `/bons-de-travail/${id}`
    );
  }

  /**
   * Ouvre la carte centrée sur l'immeuble, avec l'incident en surbrillance.
   *
   * `workOrderId` est porté par l'URL comme demandé ; `site`, `elevator` et
   * `incident` permettent à la carte de sélectionner le bon panneau, et
   * `lat`/`lng` servent de point de centrage de secours.
   */
  function openMap(row: NotificationRow) {
    markRead(row);
    setOpen(false);

    const workplace = row.workOrder;
    const building = workplace?.elevator.building;
    const point = coordinatesOf(building?.latitude, building?.longitude);
    if (!workplace || !building || !point) return;

    const params = new URLSearchParams({
      workOrderId: workplace.id,
      lat: String(point.latitude),
      lng: String(point.longitude),
      site: building.id,
      elevator: workplace.elevator.id,
    });
    if (workplace.incident?.id) params.set("incident", workplace.incident.id);
    router.push(`/carte?${params.toString()}`);
  }

  /**
   * Dispatcher depuis la cloche.
   *
   * Le sélecteur est celui du tableau des incidents — même liste, mêmes
   * statuts réels, même règle « le moins chargé d'abord ». Un second dialogue
   * écrit pour cette cloche aurait fini par proposer d'autres gens.
   */
  function dispatchFromBell(row: NotificationRow) {
    const workplace = row.workOrder;
    if (!workplace?.incident) return;
    markRead(row);
    setOpen(false);
    setDispatchTarget({
      id: workplace.incident.id,
      incidentNumber: workplace.incident.incidentNumber,
      elevatorCode: workplace.elevator.elevatorCode,
    });
  }

  /**
   * Une alerte rouge non lue fait clignoter la cloche elle-même, pas seulement
   * son badge : sur un téléphone posé dans une cage d'ascenseur, c'est le
   * mouvement qui attire l'œil, pas un chiffre.
   */
  const hasUrgentUnread = rows.some(
    (row) => !row.isRead && urgencyOf(row) === "red"
  );

  async function markAllRead() {
    setLoading(true);
    setUnread(0);
    setRows((prev) => prev.map((r) => ({ ...r, isRead: true })));

    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
    } catch {
      // Next poll restores the true state.
    } finally {
      setLoading(false);
    }
  }

  if (!enabled) return null;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={
          unread > 0
            ? `${unread} notification${unread > 1 ? "s" : ""} non lue${unread > 1 ? "s" : ""}`
            : "Notifications"
        }
        title={
          unread > 0
            ? `${unread} notification${unread > 1 ? "s" : ""} non lue${unread > 1 ? "s" : ""}`
            : "Notifications"
        }
        className="relative rounded-lg p-2 hover:bg-gray-100 dark:hover:bg-gray-800"
      >
        <BellRing
          className={`h-5 w-5 ${
            hasUrgentUnread
              ? "animate-pulse text-red-600 dark:text-red-400"
              : "text-gray-500"
          }`}
        />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] animate-pulse items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white ring-2 ring-white dark:ring-gray-950">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Notifications"
          className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg dark:border-gray-800 dark:bg-gray-900"
        >
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-800">
            <p className="text-sm font-semibold text-gray-900 dark:text-white">
              Notifications
            </p>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void markAllRead()}
                disabled={loading}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline disabled:opacity-60 dark:text-blue-400"
              >
                {loading ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                ) : (
                  <CheckCheck className="h-3 w-3" aria-hidden="true" />
                )}
                Tout marquer comme lu
              </button>
            )}
          </div>

          {rows.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400">
              Aucune nouvelle notification.
            </p>
          ) : (
            <ul className="max-h-96 overflow-y-auto">
              {rows.map((row) => {
                const urgency = urgencyOf(row);
                const meta = URGENCY_META[urgency];
                const workOrder = row.workOrder;
                const description =
                  workOrder?.incident?.notes?.trim() ||
                  workOrder?.description?.trim() ||
                  row.message;
                const building = workOrder?.elevator.building;
                const accessCode = building?.accessCode ?? null;
                const canMap =
                  canSeeMap &&
                  coordinatesOf(building?.latitude, building?.longitude) !== null;

                return (
                  <li
                    key={row.id}
                    className={
                      row.isRead ? "" : "bg-blue-50/60 dark:bg-blue-950/20"
                    }
                  >
                    <div className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => void openRow(row)}
                        className="block w-full text-left"
                      >
                        <span className="flex items-start gap-2">
                          <UrgencyLight urgency={urgency} />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center justify-between gap-1.5">
                              {workOrder ? (
                                <span
                                  className={`rounded px-1.5 py-0.5 text-[10px] font-extrabold tracking-wide ${meta.badge}`}
                                >
                                  {meta.emoji} {meta.label}
                                </span>
                              ) : (
                                <span />
                              )}
                              <span className="text-[10px] uppercase tracking-wide text-gray-400">
                                {timeAgo(row.createdAt)}
                              </span>
                            </span>

                            {/*
                              L'immeuble et l'appareil, en gras : c'est ce que
                              le dispatcheur cherche des yeux avant tout le
                              reste. La ville lève l'ambiguïté entre deux sites
                              qui portent le même nom.
                            */}
                            <span className="mt-1 block text-base font-bold leading-snug text-gray-900 dark:text-white">
                              {building?.name ?? workOrder?.title ?? row.title}
                              {building?.city && (
                                <span className="font-semibold text-gray-500 dark:text-gray-400">
                                  {" "}
                                  · {building.city}
                                </span>
                              )}
                            </span>
                            <span className="mt-0.5 flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                              <MapPin
                                className="h-3.5 w-3.5 flex-none"
                                aria-hidden="true"
                              />
                              <span className="font-mono font-semibold text-gray-700 dark:text-gray-300">
                                {workOrder?.elevator.elevatorCode ??
                                  workOrder?.title ??
                                  row.title}
                              </span>
                            </span>

                            {/* Le code d'accès : la question suivante au téléphone. */}
                            <span className="mt-1.5 inline-flex items-center rounded-lg bg-gray-900 px-2 py-1 font-mono text-[11px] font-bold text-white shadow-sm dark:bg-black">
                              🔑 Code accès :{" "}
                              {accessCode ?? "non renseigné"}
                            </span>

                            <span className="mt-1.5 line-clamp-2 block text-xs text-gray-600 dark:text-gray-400">
                              {description}
                            </span>
                          </span>
                        </span>
                      </button>

                      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                        {!row.isRead && (
                          <button
                            type="button"
                            onClick={() => markRead(row)}
                            className="rounded-lg px-2 py-1 text-[11px] font-semibold text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                          >
                            Marquer comme lu
                          </button>
                        )}
                        {workOrder && canSeeWorkOrder && (
                          <button
                            type="button"
                            onClick={() => viewWorkOrder(row)}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-blue-700"
                          >
                            <Eye className="h-3 w-3" aria-hidden="true" />
                            Voir le bon
                          </button>
                        )}
                        {workOrder &&
                          canDispatch &&
                          workOrder.incident?.status === "ESCALATED" && (
                            <button
                              type="button"
                              onClick={() => dispatchFromBell(row)}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-red-700"
                            >
                              <Zap className="h-3 w-3" aria-hidden="true" />
                              Dispatcher en 1-clic
                            </button>
                          )}
                        {workOrder && !canSeeWorkOrder && (
                          <button
                            type="button"
                            onClick={() => void openRow(row)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[11px] font-bold text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                          >
                            <Eye className="h-3 w-3" aria-hidden="true" />
                            Voir le détail
                          </button>
                        )}
                        {workOrder && canMap && (
                          <button
                            type="button"
                            onClick={() => openMap(row)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[11px] font-bold text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                          >
                            <MapPin className="h-3 w-3" aria-hidden="true" />
                            Voir sur la carte
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="border-t border-gray-200 px-4 py-2.5 dark:border-gray-800">
            <Link
              href={
                isTechnician
                  ? "/technicien"
                  : canDispatch
                    ? "/administration/incidents"
                    : "/client"
              }
              onClick={() => setOpen(false)}
              className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
            >
              {isTechnician
                ? "Voir mes missions"
                : canDispatch
                  ? "Tableau des incidents"
                  : "Voir mes signalements"}
            </Link>
          </div>
        </div>
      )}

      <DispatchModal
        incident={dispatchTarget}
        onClose={() => setDispatchTarget(null)}
        onDispatched={() => {
          setDispatchTarget(null);
          void load();
        }}
      />
    </div>
  );
}
