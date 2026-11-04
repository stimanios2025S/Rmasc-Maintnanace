"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Plus,
  Clock,
  User,
  ChevronRight,
  Wrench,
  CheckCircle2,
  X,
  Zap,
  MessageCircleWarning,
  ClipboardCheck,
  CirclePause,
  CircleX,
  ClipboardList,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import {
  SectionTabs,
  INTERVENTION_TABS,
} from "@/components/layout/section-tabs";
import { formatEnum } from "@/lib/utils";
import { enumLabel } from "@/lib/ui/enum-labels";
import { useSession } from "next-auth/react";
import { OPS_ROLES } from "@/types";
import type { IncidentStatus } from "@/types";

// ─── Types ────────────────────────────────────────────────────

/** Les statuts qu'une colonne du tableau peut porter, dans l'ordre du flux. */
type StatusKey =
  | "OPEN"
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "ON_HOLD"
  | "PENDING_APPROVAL"
  | "COMPLETED";

/**
 * Tous les statuts qu'un bon peut porter — colonne ou pas.
 *
 * `CANCELLED` en est et n'a pourtant pas de colonne, ce qui est un choix et non
 * un oubli : un bon annulé n'est pas une étape du travail, c'est une archive, et
 * une colonne qui ne se remplit jamais apprend à ne plus la regarder. Il reste
 * visible dans la vue Liste, et l'en-tête annonce combien il y en a — sans quoi
 * un bon annulé disparaîtrait purement et simplement de l'écran.
 *
 * `ON_HOLD`, lui, a sa colonne. Un bon en attente est du travail en suspens :
 * c'est exactement ce qu'un répartiteur doit voir pour le relancer, et il
 * figure déjà dans les statuts « ouverts » du produit.
 */
type StatusStyleKey = StatusKey | "CANCELLED";

const STATUSES: StatusKey[] = [
  "OPEN",
  "ASSIGNED",
  "IN_PROGRESS",
  "ON_HOLD",
  "PENDING_APPROVAL",
  "COMPLETED",
];

const STATUS_CONFIG: Record<
  StatusStyleKey,
  { label: string; icon: typeof Clock; color: string; headerColor: string }
> = {
  OPEN: { label: "Ouvert", icon: Clock, color: "bg-gray-100 text-gray-600", headerColor: "bg-gray-500" },
  ASSIGNED: { label: "Assigné", icon: User, color: "bg-blue-100 text-blue-600", headerColor: "bg-blue-500" },
  IN_PROGRESS: { label: "En cours", icon: Wrench, color: "bg-yellow-100 text-yellow-600", headerColor: "bg-yellow-500" },
  /**
   * Orange, entre l'en-cours et l'à-valider : un bon en attente n'est ni en
   * train d'être fait, ni terminé. Il est en suspens, et c'est ce que la couleur
   * doit dire — un gris l'aurait rangé avec les archives.
   */
  ON_HOLD: { label: "En attente", icon: CirclePause, color: "bg-orange-100 text-orange-700", headerColor: "bg-orange-500" },
  /**
   * Amber, not green: this column is work, not an archive. It is the only one
   * on this board that somebody has to *do* something about, and the colour is
   * the one signal that survives a glance.
   */
  PENDING_APPROVAL: { label: "À valider", icon: ClipboardCheck, color: "bg-amber-100 text-amber-700", headerColor: "bg-amber-500" },
  COMPLETED: { label: "Terminé", icon: CheckCircle2, color: "bg-green-100 text-green-600", headerColor: "bg-green-500" },
  /**
   * Sans colonne, mais avec un style : la vue Liste s'en sert pour la pastille
   * de statut, et sans cette entrée un bon annulé y tombait sur le gris par
   * défaut — la couleur de « rien de particulier », qui est justement ce qu'un
   * bon annulé n'est pas.
   */
  CANCELLED: { label: "Annulé", icon: CircleX, color: "bg-gray-200 text-gray-500 line-through", headerColor: "bg-gray-400" },
};

interface WorkOrderRow {
  id: string;
  orderNumber: string;
  title: string;
  type: string;
  priority: string;
  status: string;
  scheduledDate: string | null;
  estimatedHours: number | null;
  elevator: {
    id: string;
    elevatorCode: string;
    building: { name: string; address: string; accessCode: string | null };
  };
  assignedTo: { id: string; name: string } | null;
  /**
   * Present only when a customer escalation produced this order. Absent on
   * every order the maintenance plan raised on its own, which is most of them.
   */
  incident: {
    id: string;
    incidentNumber: string;
    status: IncidentStatus;
    isDirectTransfer: boolean;
    errorCode: { code: string; title: string } | null;
  } | null;
  /**
   * Ce que le technicien a réellement reçu sur son téléphone.
   *
   * Les trois colonnes répondent à une seule question — « est-ce qu'il a été
   * prévenu ? » — et la paire qui compte est `whatsappAttemptedAt` non nul avec
   * `whatsappDeliveredAt` nul : quelqu'un a essayé, et le technicien n'a pas été
   * joint. C'est le seul état que ce tableau affiche ; voir `WhatsAppState`.
   */
  whatsappAttemptedAt: string | null;
  whatsappDeliveredAt: string | null;
  whatsappFailure: string | null;
  /**
   * Le rapport du technicien, du côté commercial.
   *
   * `reportSubmittedAt` est l'horloge de la colonne « À valider » : sans elle,
   * un rapport envoyé ce matin et un rapport oublié depuis trois semaines se
   * ressemblent exactement, et c'est le second qui coûte.
   *
   * `invoiceAmount` arrive en chaîne de caractères quand Prisma sérialise un
   * `Decimal` — le formatage passe par `formatDzd`, qui accepte les deux.
   */
  isBillable: boolean;
  invoiceAmount: string | number | null;
  reportSubmittedAt: string | null;
}

/**
 * La file d'un technicien de terrain : trois onglets, une carte par mission.
 *
 * POURQUOI PAS LE KANBAN
 * Six colonnes supposent qu'on choisit un statut. Un technicien n'en choisit
 * pas : il a ce qui est à faire, ce qu'il a commencé, et ce qu'il a terminé. Le
 * kanban lui montrait aussi les cartes de gestion (À valider, Suspendu,
 * Annulé), le numéro de bon, l'état WhatsApp et la charge de ses collègues —
 * tout ce dont il n'a pas besoin sur un toit.
 *
 * Les cartes ne portent que quatre choses : priorité & type, immeuble &
 * appareil, motif, action. Pas de WO-…, pas d'INC-…, pas de pourcentage.
 */
const TECHNICIAN_TABS = [
  { key: "todo", label: "À faire", icon: ClipboardList },
  { key: "doing", label: "En cours", icon: Zap },
  { key: "done", label: "Terminées", icon: CheckCircle2 },
] as const;

type TechnicianTab = (typeof TECHNICIAN_TABS)[number]["key"];

function priorityDot(priority: string): string {
  if (priority === "CRITICAL" || priority === "EMERGENCY") return "bg-red-500";
  if (priority === "HIGH") return "bg-orange-500";
  if (priority === "MEDIUM") return "bg-amber-400";
  return "bg-gray-400";
}

/**
 * Le badge de priorité des cartes kanban, compact et homogène.
 *
 * Un seul mot, une seule couleur, une seule forme — les trois cartes d'une
 * colonne doivent se lire comme une série, pas comme trois avis différents.
 */
function kanbanPriority(priority: string): {
  emoji: string;
  label: string;
  className: string;
} {
  if (priority === "CRITICAL" || priority === "EMERGENCY") {
    return {
      emoji: "🔴",
      label: "CRITIQUE",
      className:
        "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
    };
  }
  if (priority === "HIGH") {
    return {
      emoji: "🟠",
      label: "ÉLEVÉE",
      className:
        "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
    };
  }
  if (priority === "MEDIUM") {
    return {
      emoji: "🔵",
      label: "MOYENNE",
      className:
        "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
    };
  }
  return {
    emoji: "⚪",
    label: "FAIBLE",
    className: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  };
}

/** Les initiales d'un technicien, pour l'avatar sans photo. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * L'avancement d'un bon, sur quatre crans.
 *
 * `CANCELLED` est traité comme un bon clos : il n'est pas « en cours », et le
 * laisser au cran 0 aurait affiché une étape active sur une archive.
 */
function workOrderStepIndex(status: string): number {
  if (status === "COMPLETED" || status === "CANCELLED") return 4;
  if (status === "PENDING_APPROVAL") return 3;
  if (status === "IN_PROGRESS" || status === "ON_HOLD") return 2;
  if (status === "ASSIGNED") return 1;
  return 0;
}

function TechnicianMissionList({ orders }: { orders: WorkOrderRow[] }) {
  const [tab, setTab] = useState<TechnicianTab>("todo");

  const groups: Record<TechnicianTab, WorkOrderRow[]> = {
    todo: orders.filter((o) => o.status === "OPEN" || o.status === "ASSIGNED"),
    doing: orders.filter((o) => o.status === "IN_PROGRESS"),
    // Le rapport envoyé au bureau est terminé du point de vue du terrain.
    done: orders.filter(
      (o) => o.status === "COMPLETED" || o.status === "PENDING_APPROVAL"
    ),
  };

  const current = groups[tab];
  const action =
    tab === "todo"
      ? "📍 Démarrer la mission"
      : tab === "doing"
        ? "⚡ Reprendre la mission"
        : "👁️ Consulter le rapport";

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-black tracking-tight text-gray-900 dark:text-white">
          Mes missions
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          {groups.todo.length + groups.doing.length === 0
            ? "Aucune mission active."
            : `${groups.todo.length + groups.doing.length} mission${
                groups.todo.length + groups.doing.length > 1 ? "s" : ""
              } à traiter.`}
        </p>
      </div>

      <div
        role="tablist"
        aria-label="Filtrer les missions"
        className="grid grid-cols-3 gap-1 rounded-xl bg-gray-100 p-1 dark:bg-gray-800"
      >
        {TECHNICIAN_TABS.map(({ key, label, icon: Icon }) => {
          const selected = tab === key;
          return (
            <button
              key={key}
              role="tab"
              aria-selected={selected}
              onClick={() => setTab(key)}
              className={`flex flex-col items-center justify-center gap-1 rounded-lg px-2 py-2 text-xs font-bold transition-colors ${
                selected
                  ? "bg-white text-gray-900 shadow-sm dark:bg-gray-900 dark:text-white"
                  : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>
                {label} ({groups[key].length})
              </span>
            </button>
          );
        })}
      </div>

      {current.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-500 dark:border-gray-800">
          Aucune mission dans cette catégorie.
        </p>
      ) : (
        <ul className="space-y-3">
          {current.map((order) => (
            <li
              key={order.id}
              className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-50 px-2.5 py-1 text-[11px] font-bold text-gray-700 dark:bg-gray-800 dark:text-gray-200">
                  <span
                    className={`h-2 w-2 rounded-full ${priorityDot(order.priority)}`}
                    aria-hidden="true"
                  />
                  {enumLabel(order.priority)}
                </span>
                <span className="rounded-full border border-gray-200 px-2.5 py-1 text-[11px] font-semibold text-gray-600 dark:border-gray-700 dark:text-gray-300">
                  {enumLabel(order.type)}
                </span>
              </div>

              <p className="mt-3 text-lg font-bold leading-tight text-gray-900 dark:text-white">
                {order.elevator.building.name}
              </p>
              <p className="font-mono text-xs tracking-wide text-gray-500">
                {order.elevator.elevatorCode}
              </p>

              <p className="mt-2 line-clamp-2 text-sm text-gray-600 dark:text-gray-400">
                {order.title}
              </p>

              <Link
                href={
                  tab === "done"
                    ? `/bons-de-travail/${order.id}`
                    : "/technicien"
                }
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-blue-700"
              >
                {action}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** La cause d'un échec WhatsApp, en clair, pour l'infobulle. */
function whatsappFailureReason(code: string | null): string {
  switch (code) {
    case "no-recipient":
    case "bad-number":
      return "Aucun numéro WhatsApp utilisable dans la fiche du technicien — appelez-le.";
    case "no-transport":
      return "Aucune instance Evolution API n'est configurée sur le serveur.";
    case "rejected":
      return "Evolution API a refusé le message (numéro absent de WhatsApp, ou clé invalide).";
    default:
      return "Evolution API n'a pas répondu (réseau ou instance arrêtée).";
  }
}

/**
 * Dit qu'un technicien n'a pas pu être joint — et rien d'autre.
 *
 * Rien dans le cas normal : le message est parti, l'affectation est en règle, et
 * afficher « WhatsApp délivré » sur chaque carte apprendrait au gestionnaire à
 * ignorer un indicateur qui ne veut rien dire la plupart du temps. Cet
 * indicateur n'existe que pour l'échec.
 *
 * `rejected` et `transport-error` sont montrés de la même façon, parce que le
 * geste est le même : décrocher le téléphone et appeler. La nuance technique est
 * dans l'infobulle, pour celui qui va réparer l'instance.
 */
interface ElevatorOption {
  id: string;
  elevatorCode: string;
  installationLocation: string | null;
  building: { name: string; address: string; city: string };
}

/**
 * Le lieu proposé pour un appareil.
 *
 * L'adresse de l'immeuble puis son complément (cage, étage) : c'est ce que le
 * champ obligatoire du formulaire pré-remplit, et ce que le bureau corrige
 * quand l'intervention ne se fait pas au pied de la machine.
 */
function suggestedLocation(elevator: ElevatorOption | undefined): string {
  if (!elevator) return "";
  return [
    elevator.building.address,
    elevator.building.city,
    elevator.installationLocation,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Un technicien proposé à la création, avec sa charge réelle. */
interface TechnicianOption {
  id: string;
  name: string;
  status: string;
  openWorkOrders: number;
  openIncidents: number;
}

/**
 * L'état d'un technicien, dit en une ligne lisible dans un `<select>`.
 *
 * Les trois couleurs sont celles de la demande : vert joignable, orange déjà
 * sur un job, rouge hors service. Le nombre de tâches vient des bons ouverts
 * (ASSIGNED / IN_PROGRESS / ON_HOLD), calculé par l'API — un compteur stocké
 * aurait dérivé au premier changement d'état manqué.
 */
function technicianAvailability(technician: TechnicianOption): string {
  if (technician.status === "OFF_DUTY") return "🔴 Hors service";
  if (technician.status === "ON_LEAVE") return "🔴 En congé";

  const load = technician.openWorkOrders;
  const tasks =
    load > 0
      ? ` - ${load} tâche${load > 1 ? "s" : ""} active${load > 1 ? "s" : ""}`
      : "";

  /**
   * La charge décide de la couleur, pas seulement le statut déclaré.
   *
   * Un technicien encore marqué « disponible » mais qui porte déjà deux bons
   * n'est pas libre : le sélecteur le présente donc en orange, avec le nombre
   * de tâches. C'est la même lecture que la carte de suivi de la flotte.
   */
  if (technician.status === "ON_JOB" || load > 0) {
    return `🟠 En intervention${tasks}`;
  }
  return "🟢 Disponible";
}

const TYPE_COLORS: Record<string, string> = {
  PREVENTIVE: "bg-green-50 text-green-700 border-green-200",
  PREDICTIVE: "bg-purple-50 text-purple-700 border-purple-200",
  CORRECTIVE: "bg-yellow-50 text-yellow-700 border-yellow-200",
  EMERGENCY: "bg-red-50 text-red-700 border-red-200",
  INSPECTION: "bg-blue-50 text-blue-700 border-blue-200",
};

// OPEN is deliberately absent: an order cannot become ASSIGNED until a
// technician is attached, so an open order advances via "Auto-dispatch"
// (or by editing the order), not by a bare status change. The API rejects
// ASSIGNED-without-assignee outright.
//
// IN_PROGRESS no longer jumps straight to COMPLETED. That shortcut is exactly
// what the approval step exists to close — a board where the fast path bypasses
// the queue is a board where the queue is never worked — and the API refuses
// the transition outright. A job whose technician never filed a report is
// carried through the queue by hand, in two clicks, leaving a trace that it
// passed that way.
const NEXT_STATUS: Record<string, string> = {
  ASSIGNED: "IN_PROGRESS",
  IN_PROGRESS: "PENDING_APPROVAL",
  PENDING_APPROVAL: "COMPLETED",
  /**
   * Un bon en attente se reprend, il ne se termine pas.
   *
   * Sans cette entrée, la seule façon de ressortir un bon suspendu était
   * l'API — et comme il n'avait pas non plus de colonne, il était invisible et
   * irrécupérable depuis cet écran. Les deux manques allaient ensemble.
   */
  ON_HOLD: "IN_PROGRESS",
};

export default function WorkOrdersPage() {
  const [view, setView] = useState<"cards" | "list">("cards");
  /**
   * Le filtre de statut, porté par les cartes KPI horizontales.
   *
   * Il remplace les colonnes Kanban : plus de pavés à faire défiler
   * horizontalement, une seule liste filtrée par un clic. Le filtre ne change
   * aucun statut en base — c'est une lecture, pas une décision.
   */
  const [statusFilter, setStatusFilter] = useState<
    "ALL" | "OPEN" | "ASSIGNED" | "IN_PROGRESS" | "PENDING_APPROVAL" | "COMPLETED"
  >("ALL");
  /** Quel bon affiche son code d'accès, quand on a cliqué sur la clé. */
  const [codeOpenId, setCodeOpenId] = useState<string | null>(null);
  /**
   * Le filtre « un appareil », posé par la carte du parc.
   *
   * Lu depuis l'URL au premier rendu plutôt que par `useSearchParams` : le
   * paramètre ne change pas pendant la vie de l'écran, et un composant client
   * qui appelle ce hook hors d'une frontière Suspense casse le rendu statique.
   */
  const [elevatorFilter] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("elevatorId");
  });
  const [orders, setOrders] = useState<WorkOrderRow[]>([]);
  const [elevatorOptions, setElevatorOptions] = useState<ElevatorOption[]>([]);
  const [technicians, setTechnicians] = useState<TechnicianOption[]>([]);
  const [techniciansLoaded, setTechniciansLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  /**
   * Message affiché quand la fiche d'un appareil a refusé l'accès (403) et que
   * l'écran a renvoyé ici. Lu depuis l'URL, puis celle-ci est nettoyée pour
   * qu'un rafraîchissement ne rejoue pas l'alerte.
   */
  const [accessDenied, setAccessDenied] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("acces") !== "refuse") return;

    setAccessDenied(true);
    window.history.replaceState({}, "", "/bons-de-travail");
  }, []);

  // A BUILDING_OWNER has read-only access to the board. Without this they were
  // shown Create / Auto-dispatch / Move-to controls that every one of produced
  // a 403 from the API.
  const { data: session } = useSession();
  const role = session?.user?.role;
  const canManage = role !== undefined && OPS_ROLES.includes(role);
  // Auto-dispatch is management-only; a field technician sees the board but
  // cannot dispatch work to a colleague.
  const canDispatch = role === "ADMIN" || role === "MAINTENANCE_MANAGER";
  /**
   * Un technicien ne crée pas de bon de travail : il exécute ceux qu'on lui
   * affecte. Le bouton et le formulaire disparaissent, plutôt que de rester
   * visibles et de produire un refus.
   */
  const canCreate = canManage && role !== "FIELD_TECHNICIAN";
  const [formError, setFormError] = useState("");
  const [form, setForm] = useState({
    title: "",
    type: "PREVENTIVE",
    priority: "MEDIUM",
    elevatorId: "",
    /**
     * Le lieu exact de l'intervention, obligatoire.
     *
     * Pré-rempli avec l'adresse du site et le complément de l'appareil dès
     * qu'un ascenseur est choisi. Le bureau peut le remplacer par une adresse
     * plus précise (entrée, cage, étage), et la valeur saisie part telle quelle
     * sur le bon.
     */
    interventionAddress: "",
    scheduledDate: "",
    estimatedHours: "",
    /** Vide = « assigner plus tard » : le bon reste OPEN au dispatching. */
    assignedToId: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [woRes, elRes] = await Promise.all([
        fetch("/api/work-orders?limit=100"),
        fetch("/api/elevators"),
      ]);
      if (!woRes.ok)
        throw new Error(`La liste des interventions a répondu ${woRes.status}`);
      const woJson = await woRes.json();
      setOrders(woJson.data ?? []);
      if (elRes.ok) {
        const elJson = await elRes.json();
        const options = (elJson.data ?? []) as ElevatorOption[];
        setElevatorOptions(options);
        setForm((f) => {
          const elevatorId = f.elevatorId || options[0]?.id || "";
          const selected = options.find((option) => option.id === elevatorId);
          return {
            ...f,
            elevatorId,
            // Ne remplace pas un lieu déjà saisi : un rafraîchissement de la
            // liste ne doit pas effacer la correction du bureau.
            interventionAddress:
              f.interventionAddress || suggestedLocation(selected),
          };
        });
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Échec du chargement des interventions"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Le roster n'est lu qu'à l'ouverture du formulaire.
   *
   * `all=1` inclut les absents pour pouvoir les afficher en rouge et les
   * désactiver — les masquer laisserait croire que l'équipe est plus petite
   * qu'elle n'est. La route reste réservée aux rôles de gestion, comme le
   * bouton qui ouvre ce formulaire.
   */
  useEffect(() => {
    if (!showCreate || !canDispatch) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/technicians?all=1", { cache: "no-store" });
        if (!res.ok) throw new Error(`Le roster a répondu ${res.status}`);
        const json = await res.json();
        if (!cancelled) {
          setTechnicians(Array.isArray(json.data) ? json.data : []);
        }
      } catch {
        if (!cancelled) setTechnicians([]);
      } finally {
        if (!cancelled) setTechniciansLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [showCreate, canDispatch]);

  const mutate = async (id: string, body: Record<string, unknown>) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/work-orders?id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? "Échec de la mise à jour");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Échec de la mise à jour");
    } finally {
      setBusyId(null);
    }
  };

  const dispatch = async (id: string) => {
    setBusyId(id);
    try {
      const res = await fetch("/api/work-orders/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workOrderId: id }),
      });
      const json = await res.json();
      if (!res.ok)
        throw new Error(json.message ?? json.error ?? "L'affectation a échoué");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "L'affectation a échoué");
    } finally {
      setBusyId(null);
    }
  };

  const createOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");
    if (!form.title.trim() || !form.elevatorId) {
      setFormError("Le titre et l'ascenseur sont obligatoires.");
      return;
    }
    if (!form.interventionAddress.trim()) {
      setFormError(
        "Le lieu / l'adresse exacte de l'intervention est obligatoire."
      );
      return;
    }
    setBusyId("create");
    try {
      const res = await fetch("/api/work-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title.trim(),
          interventionAddress: form.interventionAddress.trim(),
          type: form.type,
          priority: form.priority,
          elevatorId: form.elevatorId,
          scheduledDate: form.scheduledDate || undefined,
          estimatedHours: form.estimatedHours ? Number(form.estimatedHours) : undefined,
          /**
           * Le serveur pose `ASSIGNED` dès qu'une personne est nommée, et
           * `OPEN` sinon — c'est la règle de la route de création, pas une
           * décision de l'écran.
           */
          assignedToId: form.assignedToId || undefined,
        }),
        });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Échec de la création");
      setShowCreate(false);
      setForm({ title: "", type: "PREVENTIVE", priority: "MEDIUM", elevatorId: elevatorOptions[0]?.id ?? "", interventionAddress: suggestedLocation(elevatorOptions[0]), scheduledDate: "", estimatedHours: "", assignedToId: "" });
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Échec de la création");
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Le périmètre « un appareil », puis le statut choisi.
   *
   * `En cours` regroupe `IN_PROGRESS` et `ON_HOLD` : les deux états disent
   * qu'une intervention est engagée, et les séparer dans la barre aurait
   * ajouté une onglet que personne n'ouvre.
   */
  const scopedOrders = useMemo(
    () =>
      elevatorFilter
        ? orders.filter((wo) => wo.elevator.id === elevatorFilter)
        : orders,
    [orders, elevatorFilter]
  );

  const visibleOrders = useMemo(() => {
    if (statusFilter === "ALL") return scopedOrders;
    if (statusFilter === "IN_PROGRESS") {
      return scopedOrders.filter(
        (wo) => wo.status === "IN_PROGRESS" || wo.status === "ON_HOLD"
      );
    }
    return scopedOrders.filter((wo) => wo.status === statusFilter);
  }, [scopedOrders, statusFilter]);

  /** Les compteurs des cartes KPI, calculés sur le périmètre complet. */
  const statusCounts = useMemo(() => {
    const count = (statuses: readonly string[]) =>
      scopedOrders.filter((wo) => statuses.includes(wo.status)).length;

    return {
      ALL: scopedOrders.length,
      OPEN: count(["OPEN"]),
      ASSIGNED: count(["ASSIGNED"]),
      IN_PROGRESS: count(["IN_PROGRESS", "ON_HOLD"]),
      PENDING_APPROVAL: count(["PENDING_APPROVAL"]),
      COMPLETED: count(["COMPLETED", "CANCELLED"]),
    };
  }, [scopedOrders]);

  /**
   * « Actif » veut dire : quelqu'un a encore quelque chose à faire dessus.
   *
   * Un bon annulé n'est pas actif. Un bon terminé non plus. Et un bon en
   * attente de validation non plus — il compte sur sa propre ligne, parce qu'un
   * total qui le confond avec les interventions encore sur le terrain cache le
   * seul chiffre qui soit une liste de choses à faire.
   *
   * Les trois exclusions sont écrites, et pas seulement les deux que le bon
   * sens suggère : la version précédente ne retirait que TERMINÉ et ANNULÉ tout
   * en portant un commentaire qui annonçait trois exclusions. L'en-tête
   * annonçait donc « 8 actifs » sur un tableau qui en montrait 5, et le même
   * bon était compté deux fois — une fois dans les actifs, une fois dans les
   * « à valider ».
   */
  const INACTIVE_STATUSES = ["COMPLETED", "CANCELLED", "PENDING_APPROVAL"];
  const activeCount = orders.filter(
    (wo) => !INACTIVE_STATUSES.includes(wo.status)
  ).length;

  const cancelledCount = orders.filter((wo) => wo.status === "CANCELLED").length;

  const pendingCount = orders.filter(
    (wo) => wo.status === "PENDING_APPROVAL"
  ).length;

  if (loading) {
    return (
      <div className="space-y-6">
        <LoadingSkeleton rows={6} />
      </div>
    );
  }

  if (error && orders.length === 0) {
    return <ErrorState message={error} onRetry={load} />;
  }

  // Le terrain a sa propre vue : trois onglets, quatre informations par carte.
  // Le kanban, ses six colonnes et ses indicateurs WhatsApp restent au bureau.
  if (role === "FIELD_TECHNICIAN") {
    return <TechnicianMissionList orders={orders} />;
  }

  return (
    <div className="space-y-6">
      <SectionTabs tabs={INTERVENTION_TABS} ariaLabel="Interventions et maintenance" />

      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            Interventions &amp; Bons de travail
          </h2>
          <p className="text-gray-500 mt-1">
            {orders.length} intervention{orders.length > 1 ? "s" : ""} au total
            {" · "}
            {activeCount} en cours
            {pendingCount > 0 && (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => setStatusFilter("PENDING_APPROVAL")}
                  className="font-medium text-amber-600 hover:text-amber-700 dark:text-amber-400"
                >
                  {pendingCount} à valider
                </button>
              </>
            )}
            {/* Les bons annulés n'ont pas de colonne — voir `StatusStyleKey` —
                et ils resteraient donc invisibles si l'en-tête se taisait. Le
                lien bascule sur la vue Liste, qui les affiche tous. */}
            {cancelledCount > 0 && (
              <>
                {" "}
                •{" "}
                <button
                  type="button"
                  onClick={() => setView("list")}
                  className="font-medium text-gray-500 hover:text-gray-700 hover:underline dark:text-gray-400 dark:hover:text-gray-200"
                >
                  {cancelledCount} annulé{cancelledCount > 1 ? "s" : ""}
                </button>
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <div className="flex bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
            {(["cards", "list"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize ${
                  view === v
                    ? "bg-white dark:bg-gray-900 text-gray-900 dark:text-white shadow-sm"
                    : "text-gray-500"
                }`}
              >
                {v === "cards" ? "Cartes" : "Liste"}
              </button>
            ))}
          </div>
          {canCreate && (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Nouvelle intervention
            </button>
          )}
        </div>
      </div>

      {elevatorFilter && (
        <p className="flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
          Interventions filtrées sur un appareil.
          <Link href="/bons-de-travail" className="underline">
            Voir toutes les interventions
          </Link>
        </p>
      )}

      {/*
        La barre de statuts remplace les colonnes Kanban.

        Six cartes filtrantes, chacune avec sa bordure d'accent et son
        compteur : un clic restreint la liste en dessous. Le compteur porte le
        total réel, pas le total filtré — un chiffre qui change quand on le
        clique ne dit plus rien.
      */}
      <div
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
        role="tablist"
        aria-label="Filtrer les interventions par statut"
      >
        {(
          [
            {
              key: "ALL",
              label: "Tous",
              emoji: "",
              border: "border-t-slate-300",
              dot: "bg-slate-400",
              count: statusCounts.ALL,
            },
            {
              key: "OPEN",
              label: "Ouvert",
              emoji: "⚪",
              border: "border-t-slate-400",
              dot: "bg-slate-400",
              count: statusCounts.OPEN,
            },
            {
              key: "ASSIGNED",
              label: "Assigné",
              emoji: "🔵",
              border: "border-t-blue-500",
              dot: "bg-blue-500",
              count: statusCounts.ASSIGNED,
            },
            {
              key: "IN_PROGRESS",
              label: "En cours",
              emoji: "🟡",
              border: "border-t-amber-500",
              dot: "bg-amber-500",
              count: statusCounts.IN_PROGRESS,
            },
            {
              key: "PENDING_APPROVAL",
              label: "À valider",
              emoji: "🟣",
              border: "border-t-purple-500",
              dot: "bg-purple-500",
              count: statusCounts.PENDING_APPROVAL,
            },
            {
              key: "COMPLETED",
              label: "Clôturé",
              emoji: "🟢",
              border: "border-t-emerald-500",
              dot: "bg-emerald-500",
              count: statusCounts.COMPLETED,
            },
          ] as const
        ).map((item) => {
          const active = statusFilter === item.key;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setStatusFilter(item.key)}
              className={`flex items-center justify-between gap-2 rounded-lg border border-t-2 border-slate-200/80 bg-white px-3 py-2 text-left transition-colors dark:border-slate-800 dark:bg-slate-900 ${item.border} ${
                active
                  ? "ring-2 ring-blue-500/40"
                  : "hover:bg-slate-50 dark:hover:bg-slate-800/60"
              }`}
            >
              <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-800 dark:text-slate-200">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full shadow-sm ${item.dot}`}
                  aria-hidden="true"
                />
                {item.emoji ? `${item.emoji} ` : ""}
                <span className="truncate">{item.label}</span>
              </span>
              <span className="rounded-full border border-slate-200/60 bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                {item.count}
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">
          {error}
        </p>
      )}

      {accessDenied && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3 dark:bg-red-950/40 dark:border-red-900 dark:text-red-300"
        >
          <span>
            <strong>Accès refusé.</strong> Cet appareil ne fait pas partie de vos
            interventions — sa fiche n&apos;est visible que par un technicien qui
            y est affecté.
          </span>
          <button
            type="button"
            onClick={() => setAccessDenied(false)}
            aria-label="Fermer le message"
            className="flex-none rounded p-1 hover:bg-red-100 dark:hover:bg-red-900/40"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Vue cartes — une ligne par intervention */}
      {view === "cards" && (
        <div className="space-y-2">
          {visibleOrders.length === 0 && (
            <Card className="p-8 text-center text-sm text-gray-500 dark:text-gray-400">
              Aucune intervention pour ce filtre.
            </Card>
          )}

          {visibleOrders.map((wo) => {
            const priority = kanbanPriority(wo.priority);
            const step = workOrderStepIndex(wo.status);
            const next = NEXT_STATUS[wo.status];
            const accessCode = wo.elevator.building.accessCode;
            const codeOpen = codeOpenId === wo.id;
            const canAct = Boolean(canManage && next);

            return (
              <div
                key={wo.id}
                className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,1.1fr)_auto] lg:items-center">
                  {/* 1 — urgence & appareil */}
                  <div className="min-w-0">
                    <span
                      className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-extrabold tracking-wide ${priority.className}`}
                    >
                      {priority.emoji} {priority.label}
                    </span>
                    <p className="mt-1 font-mono text-sm font-bold text-slate-900 dark:text-white">
                      {wo.elevator.elevatorCode}
                    </p>
                    <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {wo.elevator.building.name}
                    </p>
                    {codeOpen && (
                      <p className="mt-1 inline-flex rounded bg-slate-900 px-2 py-0.5 font-mono text-[10px] font-bold text-white dark:bg-black">
                        🔑 {accessCode ?? "non renseigné"}
                      </p>
                    )}
                  </div>

                  {/* 2 — mission */}
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900 dark:text-white">
                      {wo.title}
                    </p>
                    <span
                      className={`mt-1 inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                        TYPE_COLORS[wo.type] ?? TYPE_COLORS.INSPECTION
                      }`}
                    >
                      {enumLabel(wo.type)}
                    </span>
                  </div>

                  {/* 3 — technicien */}
                  <div className="flex min-w-0 items-center gap-2">
                    {wo.assignedTo ? (
                      <>
                        <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-slate-900 text-[10px] font-bold text-white dark:bg-slate-700">
                          {initials(wo.assignedTo.name)}
                        </span>
                        <span className="truncate text-xs font-medium text-slate-700 dark:text-slate-300">
                          {wo.assignedTo.name}
                        </span>
                      </>
                    ) : (
                      <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                        Non assigné
                      </span>
                    )}
                  </div>

                  {/* 4 — mini-stepper */}
                  <div className="flex flex-wrap items-center gap-1 text-[10px]">
                    {["Signalé", "Assigné", "En cours", "Validé"].map(
                      (label, index) => {
                        const done = index < step;
                        const active = index === step;
                        return (
                          <span
                            key={label}
                            className="inline-flex items-center gap-1"
                          >
                            {index > 0 && (
                              <span
                                className="h-px w-2 bg-slate-300 dark:bg-slate-700"
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
                              {index + 1}. {label}
                            </span>
                          </span>
                        );
                      }
                    )}
                  </div>

                  {/* 5 — actions */}
                  <div className="flex items-center justify-end gap-1.5">
                    {wo.status === "OPEN" && canDispatch ? (
                      <button
                        type="button"
                        onClick={() => dispatch(wo.id)}
                        disabled={busyId === wo.id}
                        className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        <Zap className="h-3 w-3" aria-hidden="true" />
                        Intervenir
                      </button>
                    ) : canAct ? (
                      <button
                        type="button"
                        onClick={() => mutate(wo.id, { status: next })}
                        disabled={busyId === wo.id}
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                        {wo.status === "ASSIGNED"
                          ? "Démarrer"
                          : wo.status === "IN_PROGRESS"
                            ? "Clôturer"
                            : "Valider"}
                      </button>
                    ) : (
                      <Link
                        href={`/bons-de-travail/${wo.id}`}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                      >
                        👁️ Consulter
                      </Link>
                    )}

                    <button
                      type="button"
                      onClick={() => setCodeOpenId(codeOpen ? null : wo.id)}
                      aria-label="Voir le code d'accès de l'immeuble"
                      aria-expanded={codeOpen}
                      title={
                        accessCode
                          ? `Code : ${accessCode}`
                          : "Code non renseigné"
                      }
                      className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-[12px] hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                    >
                      🔑
                    </button>
                    <Link
                      href={`/bons-de-travail/${wo.id}`}
                      aria-label="Ouvrir la fiche détaillée"
                      title="Ouvrir la fiche détaillée"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-[12px] hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                    >
                      📄
                    </Link>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}


      {/* List View */}
      {view === "list" && (
        <Card className="overflow-hidden">
          {orders.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={ClipboardCheck}
                title="Aucune intervention enregistrée"
                description="Une intervention regroupe le travail à faire sur un appareil : un dépannage, une visite d'entretien ou une inspection. Créez la première, ou laissez le bureau vous en affecter une."
                action={{
                  label: "Créer une intervention",
                  icon: Plus,
                  onClick: () => setShowCreate(true),
                }}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                    {[
                      "Urgence",
                      "Immeuble · accès",
                      "Motif",
                      "Technicien",
                      "Statut",
                      "Planifié",
                      "Fiche",
                    ].map((h) => (
                      <th
                        key={h}
                        className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                  {visibleOrders.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-4 py-10 text-center text-sm text-gray-500 dark:text-gray-400"
                      >
                        Aucune intervention pour ce filtre.
                      </td>
                    </tr>
                  )}
                  {visibleOrders.map((wo) => (
                    <tr
                      key={wo.id}
                      className="hover:bg-gray-50 dark:hover:bg-gray-800/50"
                    >
                      {/* Urgence : le feu, puis le libellé. */}
                      <td className="px-4 py-4">
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-700 dark:text-gray-300">
                          <span
                            className={`h-2 w-2 rounded-full ${priorityDot(
                              wo.priority
                            )}`}
                            aria-hidden="true"
                          />
                          {enumLabel(wo.priority)}
                        </span>
                      </td>

                      {/* L'immeuble et son code, ce qu'on lit au téléphone. */}
                      <td className="px-4 py-4">
                        <p className="text-sm font-semibold text-gray-900 dark:text-white">
                          {wo.elevator.building.name}
                        </p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                          <span className="font-mono">
                            {wo.elevator.elevatorCode}
                          </span>
                          <span className="rounded bg-gray-900 px-1.5 py-0.5 font-mono text-[10px] font-bold text-white dark:bg-black">
                            🔑{" "}
                            {wo.elevator.building.accessCode ??
                              "non renseigné"}
                          </span>
                        </p>
                      </td>

                      {/* Le motif. Le numéro de bon n'est plus affiché : il
                          reste dans l'URL de la fiche, pas à l'écran. */}
                      <td className="px-4 py-4">
                        <Link
                          href={`/bons-de-travail/${wo.id}`}
                          className="text-sm font-medium text-gray-900 hover:text-blue-600 dark:text-white dark:hover:text-blue-400"
                        >
                          {wo.title}
                        </Link>
                        <span
                          className={`mt-1 ml-1 inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                            TYPE_COLORS[wo.type] ?? TYPE_COLORS.INSPECTION
                          }`}
                        >
                          {enumLabel(wo.type)}
                        </span>
                        {wo.incident?.errorCode && (
                          <p className="mt-0.5 text-[11px] text-gray-400">
                            {wo.incident.errorCode.code} —{" "}
                            {wo.incident.errorCode.title}
                          </p>
                        )}
                      </td>

                      <td className="px-4 py-4 text-sm text-gray-600 dark:text-gray-400">
                        <span className="inline-flex items-center gap-1.5">
                          {wo.assignedTo?.name ?? (
                            <span className="italic text-gray-400">
                              Non affecté
                            </span>
                          )}
                          {wo.whatsappAttemptedAt && !wo.whatsappDeliveredAt && (
                            <span
                              className="inline-flex flex-none"
                              title={whatsappFailureReason(wo.whatsappFailure)}
                            >
                              <MessageCircleWarning
                                className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400"
                                aria-hidden="true"
                              />
                              <span className="sr-only">
                                WhatsApp non délivré.
                              </span>
                            </span>
                          )}
                        </span>
                      </td>

                      <td className="px-4 py-4">
                        <span
                          className={`px-2 py-0.5 text-[10px] font-bold rounded ${
                            STATUS_CONFIG[wo.status as StatusStyleKey]?.color ??
                            "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {formatEnum(wo.status)}
                        </span>
                      </td>

                      <td className="px-4 py-4 text-sm text-gray-500">
                        {wo.scheduledDate ? (
                          new Date(wo.scheduledDate).toLocaleDateString("fr-FR")
                        ) : (
                          <span className="italic text-gray-400">—</span>
                        )}
                      </td>

                      <td className="px-4 py-4">
                        <Link
                          href={`/bons-de-travail/${wo.id}`}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:underline dark:text-blue-400"
                        >
                          Ouvrir
                          <ChevronRight className="h-3 w-3" aria-hidden="true" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Create Modal */}
      {canCreate && showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                Nouvelle intervention
              </h3>
              <button
                onClick={() => setShowCreate(false)}
                aria-label="Fermer"
                className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            {formError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{formError}</p>
            )}
            <form onSubmit={createOrder} className="space-y-3">
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Titre (ex. : inspection de sécurité mensuelle)"
                className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="grid grid-cols-2 gap-3">
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                  className="px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white"
                >
                  {["PREVENTIVE", "PREDICTIVE", "CORRECTIVE", "EMERGENCY", "INSPECTION"].map((t) => (
                    <option key={t} value={t}>{formatEnum(t)}</option>
                  ))}
                </select>
                <select
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                  className="px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white"
                >
                  {["LOW", "MEDIUM", "HIGH", "EMERGENCY", "CRITICAL"].map((p) => (
                    <option key={p} value={p}>{formatEnum(p)}</option>
                  ))}
                </select>
              </div>
              <select
                value={form.elevatorId}
                onChange={(e) => {
                  const elevatorId = e.target.value;
                  const selected = elevatorOptions.find(
                    (option) => option.id === elevatorId
                  );
                  setForm((f) => ({
                    ...f,
                    elevatorId,
                    // Changer d'appareil change le lieu proposé. La valeur
                    // déjà corrigée est remplacée volontairement : elle
                    // décrivait l'ancienne machine, pas la nouvelle.
                    interventionAddress: suggestedLocation(selected),
                  }));
                }}
                className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white"
              >
                {elevatorOptions.map((el) => (
                  <option key={el.id} value={el.id}>
                    {el.elevatorCode} — {el.building.name}
                  </option>
                ))}
              </select>
              {/*
                Le lieu exact, obligatoire. Pré-rempli depuis l'appareil mais
                éditable : un ensemble de plusieurs cages ou un local
                technique ne se déduit pas d'une adresse de rue, et c'est
                précisément ce que le technicien doit lire avant de partir.
              */}
              <div>
                <label
                  htmlFor="create-address"
                  className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
                >
                  Lieu / adresse exacte de l&apos;intervention{" "}
                  <span className="text-red-500">*</span>
                </label>
                <textarea
                  id="create-address"
                  value={form.interventionAddress}
                  onChange={(e) =>
                    setForm({ ...form, interventionAddress: e.target.value })
                  }
                  rows={2}
                  required
                  placeholder="Ex. : 12 rue des Oliviers — Bâtiment A, 3e étage, local technique"
                  className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                  Repris sur la fiche du technicien et utilisé pour
                  l&apos;itinéraire.
                </p>
              </div>
              <div>
                <label
                  htmlFor="create-assignee"
                  className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
                >
                  Assigner un technicien
                </label>
                <select
                  id="create-assignee"
                  value={form.assignedToId}
                  onChange={(e) =>
                    setForm({ ...form, assignedToId: e.target.value })
                  }
                  className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white"
                >
                  <option value="">Assigner plus tard (Non assigné)</option>
                  {technicians.map((technician) => {
                    const unavailable =
                      technician.status === "OFF_DUTY" ||
                      technician.status === "ON_LEAVE";
                    return (
                      <option
                        key={technician.id}
                        value={technician.id}
                        disabled={unavailable}
                      >
                        {technician.name} — {technicianAvailability(technician)}
                      </option>
                    );
                  })}
                </select>
                <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                  {form.assignedToId
                    ? "Le bon sera créé au statut « Assigné » et apparaîtra dans l'espace du technicien."
                    : "Le bon restera en attente (non assigné) dans le centre de dispatching."}
                </p>
                {techniciansLoaded && technicians.length === 0 && (
                  <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                    Aucun technicien lisible pour ce compte.
                  </p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="date"
                  value={form.scheduledDate}
                  onChange={(e) => setForm({ ...form, scheduledDate: e.target.value })}
                  className="px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white"
                />
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={form.estimatedHours}
                  onChange={(e) => setForm({ ...form, estimatedHours: e.target.value })}
                  placeholder="Heures estimées"
                  className="px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white"
                />
              </div>
              <button
                type="submit"
                disabled={busyId === "create"}
                className="w-full py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {busyId === "create"
                  ? "Création…"
                  : "Créer le bon de travail"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
