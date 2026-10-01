"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Plus,
  Clock,
  User,
  Calendar,
  ChevronRight,
  Wrench,
  CheckCircle2,
  X,
  Zap,
  MessageCircleWarning,
  ClipboardCheck,
  Banknote,
  CirclePause,
  CircleX,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { ValidationBadge } from "@/components/ui/validation-badge";
import { ProgressTrack } from "@/components/ui/progress-track";
import { formatEnum } from "@/lib/utils";
import { enumLabel } from "@/lib/ui/enum-labels";
import { formatDzd } from "@/lib/ui/money";
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
  elevator: { elevatorCode: string; building: { name: string } };
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
 * Combien de temps un rapport attend.
 *
 * Arrondi vers le bas, et en une seule unité : « il y a 2 j » se lit d'un coup
 * d'œil dans une colonne, « il y a 2 jours 4 heures et 12 minutes » se lit une
 * fois. Au-delà d'un mois on passe aux semaines, parce que le nombre de jours
 * cesse d'être une information à ce stade — c'est le rapport lui-même qu'il
 * faut aller chercher.
 */
function waitingFor(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;

  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return "il y a moins d'une heure";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `il y a ${days} j`;
  const weeks = Math.floor(days / 7);
  return `il y a ${weeks} sem.`;
}

/**
 * Un montant lisible, en dinars.
 *
 * `fr-DZ` groupe les milliers par une espace et utilise la virgule décimale,
 * ce qui est la façon dont le montant sera écrit sur la facture. Les centimes
 * ne sont affichés que lorsqu'il y en a : « 18 500 DZD » plutôt que
 * « 18 500,00 DZD », qui laisse croire à une précision qui n'existe pas.
 */
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
function WhatsAppState({
  order,
}: {
  order: Pick<
    WorkOrderRow,
    "whatsappAttemptedAt" | "whatsappDeliveredAt" | "whatsappFailure" | "assignedTo"
  >;
}) {
  if (!order.whatsappAttemptedAt || order.whatsappDeliveredAt) return null;

  return (
    <p
      className="mb-3 flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] font-medium text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
      title={whatsappFailureReason(order.whatsappFailure)}
    >
      <MessageCircleWarning
        className="mt-px h-3.5 w-3.5 flex-none"
        aria-hidden="true"
      />
      <span>
        WhatsApp non délivré
        {order.assignedTo ? ` à ${order.assignedTo.name.split(" ")[0]}` : ""} —
        appelez-le.
      </span>
    </p>
  );
}

interface ElevatorOption {
  id: string;
  elevatorCode: string;
  building: { name: string };
}

const PRIORITY_COLORS: Record<string, string> = {
  LOW: "bg-gray-100 text-gray-700",
  MEDIUM: "bg-blue-100 text-blue-700",
  HIGH: "bg-orange-100 text-orange-700",
  EMERGENCY: "bg-red-100 text-red-700",
  CRITICAL: "bg-red-200 text-red-900 animate-pulse",
};

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
  const [view, setView] = useState<"kanban" | "list">("kanban");
  const [orders, setOrders] = useState<WorkOrderRow[]>([]);
  const [elevatorOptions, setElevatorOptions] = useState<ElevatorOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // A BUILDING_OWNER has read-only access to the board. Without this they were
  // shown Create / Auto-dispatch / Move-to controls that every one of produced
  // a 403 from the API.
  const { data: session } = useSession();
  const role = session?.user?.role;
  const canManage = role !== undefined && OPS_ROLES.includes(role);
  // Auto-dispatch is management-only; a field technician sees the board but
  // cannot dispatch work to a colleague.
  const canDispatch = role === "ADMIN" || role === "MAINTENANCE_MANAGER";
  const [formError, setFormError] = useState("");
  const [form, setForm] = useState({
    title: "",
    type: "PREVENTIVE",
    priority: "MEDIUM",
    elevatorId: "",
    scheduledDate: "",
    estimatedHours: "",
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
        throw new Error(`L'API des bons de travail a répondu ${woRes.status}`);
      const woJson = await woRes.json();
      setOrders(woJson.data ?? []);
      if (elRes.ok) {
        const elJson = await elRes.json();
        setElevatorOptions(elJson.data ?? []);
        setForm((f) => ({
          ...f,
          elevatorId: f.elevatorId || elJson.data?.[0]?.id || "",
        }));
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Échec du chargement des bons de travail"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
    setBusyId("create");
    try {
      const res = await fetch("/api/work-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title.trim(),
          type: form.type,
          priority: form.priority,
          elevatorId: form.elevatorId,
          scheduledDate: form.scheduledDate || undefined,
          estimatedHours: form.estimatedHours ? Number(form.estimatedHours) : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Échec de la création");
      setShowCreate(false);
      setForm({ title: "", type: "PREVENTIVE", priority: "MEDIUM", elevatorId: elevatorOptions[0]?.id ?? "", scheduledDate: "", estimatedHours: "" });
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Échec de la création");
    } finally {
      setBusyId(null);
    }
  };

  const ordersByStatus = useMemo(
    () =>
      STATUSES.map((status) => ({
        status,
        orders: orders.filter((wo) => wo.status === status),
      })),
    [orders]
  );

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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            Bons de travail
          </h2>
          <p className="text-gray-500 mt-1">
            {orders.length} {orders.length > 1 ? "bons" : "bon"} au total •{" "}
            {activeCount} {activeCount > 1 ? "actifs" : "actif"}
            {pendingCount > 0 && (
              <>
                {" "}
                •{" "}
                <Link
                  href="#a-valider"
                  className="font-medium text-amber-600 hover:text-amber-700 dark:text-amber-400"
                >
                  {pendingCount} à valider
                </Link>
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
            {(["kanban", "list"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize ${
                  view === v
                    ? "bg-white dark:bg-gray-900 text-gray-900 dark:text-white shadow-sm"
                    : "text-gray-500"
                }`}
              >
                {v === "kanban" ? "Kanban" : "Liste"}
              </button>
            ))}
          </div>
          {canManage && (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Nouveau bon de travail
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">
          {error}
        </p>
      )}

      {/* Kanban View */}
      {view === "kanban" && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          {ordersByStatus.map(({ status, orders: col }) => {
            const config = STATUS_CONFIG[status];
            return (
              <div
                key={status}
                id={status === "PENDING_APPROVAL" ? "a-valider" : undefined}
                className="flex flex-col scroll-mt-6"
              >
                <div className={`${config.headerColor} text-white px-4 py-2.5 rounded-t-lg flex items-center justify-between`}>
                  <div className="flex items-center gap-2">
                    <config.icon className="w-4 h-4" />
                    <span className="text-sm font-semibold">{config.label}</span>
                  </div>
                  <span className="bg-white/20 text-white text-xs font-bold px-2 py-0.5 rounded-full">
                    {col.length}
                  </span>
                </div>

                <div className="bg-gray-50 dark:bg-gray-800/50 rounded-b-lg p-3 space-y-3 min-h-[200px]">
                  {col.map((wo) => {
                    const waiting = waitingFor(wo.reportSubmittedAt);
                    const amount = formatDzd(wo.invoiceAmount);
                    return (
                    <div
                      key={wo.id}
                      className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4 hover:shadow-md transition-shadow"
                    >
                      <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                        <span className={`px-1.5 py-0.5 text-[10px] font-bold rounded ${PRIORITY_COLORS[wo.priority] ?? PRIORITY_COLORS.MEDIUM}`}>
                          {enumLabel(wo.priority)}
                        </span>
                        <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded border ${TYPE_COLORS[wo.type] ?? TYPE_COLORS.INSPECTION}`}>
                          {enumLabel(wo.type)}
                        </span>
                      </div>

                      <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">
                        {wo.title}
                      </h4>
                      {/* Le numéro est le lien vers la fiche, et non la carte
                          entière : la carte contient déjà des boutons
                          (affectation, changement de statut), et un lien qui
                          enveloppe des boutons fait de chaque clic manqué une
                          navigation. */}
                      <Link
                        href={`/bons-de-travail/${wo.id}`}
                        className="mb-2 inline-block text-[10px] font-mono text-gray-400 hover:text-blue-600 hover:underline dark:hover:text-blue-400"
                      >
                        {wo.orderNumber}
                      </Link>

                      <div className="text-xs text-gray-500 space-y-0.5 mb-3">
                        <p className="font-mono">{wo.elevator.elevatorCode}</p>
                        <p>{wo.elevator.building.name}</p>
                      </div>

                      {/* Where this order came from. A corrective order with
                          no incident behind it needs no explanation; one that
                          a customer escalated carries the fault code and the
                          customer's own account, and both are worth reading
                          before deciding who to send. */}
                      {wo.incident && (
                        <div className="mb-3 space-y-1.5 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 px-2.5 py-2">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <ValidationBadge
                              status={wo.incident.status}
                              size="compact"
                            />
                            {wo.incident.isDirectTransfer && (
                              <span
                                className="inline-flex items-center rounded-full border border-red-300 bg-red-50 px-1.5 py-0.5 text-[10px] font-bold text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
                                title="Créé par le bouton d'urgence — l'occupant n'a jamais parcouru les étapes du code d'erreur"
                              >
                                URGENCE
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] font-mono text-gray-400">
                            {wo.incident.incidentNumber}
                            {wo.incident.errorCode && ` · ${wo.incident.errorCode.code}`}
                          </p>
                          {wo.incident.errorCode && (
                            <p className="text-[11px] text-gray-600 dark:text-gray-400">
                              {wo.incident.errorCode.title}
                            </p>
                          )}
                          {/* The bar reads the incident's own status, not the
                              order's. An order sitting in ASSIGNED tells you
                              where the paperwork is; the bar tells you where
                              the *fault* is, which is what the customer is
                              waiting on. */}
                          <ProgressTrack
                            status={wo.incident.status}
                            showLabels={false}
                            className="pt-0.5"
                          />
                          <Link
                            href="/administration/incidents"
                            className="inline-block text-[10px] font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400"
                          >
                            Ouvrir dans le tableau des incidents →
                          </Link>
                        </div>
                      )}

                      <WhatsAppState order={wo} />

                      <div className="flex items-center justify-between text-xs mb-2">
                        {wo.assignedTo ? (
                          <div className="flex items-center gap-1 text-gray-600 dark:text-gray-300">
                            <User className="w-3 h-3" />
                            <span>{wo.assignedTo.name.split(" ")[0]}</span>
                          </div>
                        ) : canDispatch ? (
                          <button
                            onClick={() => dispatch(wo.id)}
                            disabled={busyId === wo.id}
                            className="flex items-center gap-1 text-blue-600 font-medium hover:text-blue-700 disabled:opacity-50"
                          >
                            <Zap className="w-3 h-3" />
                            {busyId === wo.id
                              ? "Affectation…"
                              : "Affectation automatique"}
                          </button>
                        ) : (
                          <span className="text-gray-400">Non affecté</span>
                        )}
                        {wo.scheduledDate && (
                          <div className="flex items-center gap-1 text-gray-400">
                            <Calendar className="w-3 h-3" />
                            <span>
                              {new Date(wo.scheduledDate).toLocaleDateString(
                                "fr-FR"
                              )}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Ce que contient un rapport en attente, et depuis
                          quand. Les deux questions que se pose celui qui
                          ouvre cette colonne — « depuis quand » et « pour
                          combien » — sans avoir à ouvrir chaque fiche pour
                          savoir laquelle traiter d'abord. */}
                      {wo.status === "PENDING_APPROVAL" && (
                        <div className="mb-3 space-y-1 rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-900/10 px-2.5 py-2">
                          <p className="text-[11px] font-medium text-amber-800 dark:text-amber-300">
                            {waiting ?? "Rapport envoyé"}
                          </p>
                          {!wo.isBillable ? (
                            <p className="text-[11px] text-amber-700/80 dark:text-amber-400/80">
                              Non facturable
                            </p>
                          ) : amount ? (
                            <p className="flex items-center gap-1 text-[11px] text-amber-800 dark:text-amber-300">
                              <Banknote className="w-3 h-3 shrink-0" />
                              <span className="tabular-nums">
                                {amount} à facturer
                              </span>
                            </p>
                          ) : (
                            <p className="flex items-center gap-1 text-[11px] font-medium text-amber-800 dark:text-amber-300">
                              <Banknote className="w-3 h-3 shrink-0" />
                              Montant à compléter
                            </p>
                          )}
                          <Link
                            href={`/bons-de-travail/${wo.id}`}
                            className="flex items-center gap-0.5 pt-0.5 text-[11px] font-semibold text-amber-700 hover:text-amber-800 hover:underline dark:text-amber-400"
                          >
                            Lire le rapport et valider
                            <ChevronRight className="w-3 h-3" />
                          </Link>
                        </div>
                      )}

                      <div className="pt-2 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between text-xs text-gray-400">
                        <span>Est. {wo.estimatedHours ?? "—"} h</span>
                        {NEXT_STATUS[wo.status] && canManage ? (
                          <button
                            onClick={() => mutate(wo.id, { status: NEXT_STATUS[wo.status] })}
                            disabled={busyId === wo.id}
                            className="flex items-center gap-0.5 text-blue-600 font-medium hover:text-blue-700 disabled:opacity-50"
                          >
                            Passer à {formatEnum(NEXT_STATUS[wo.status])}
                            <ChevronRight className="w-3 h-3" />
                          </button>
                        ) : !canManage ? (
                          <span className="text-gray-400">
                            {formatEnum(wo.status)}
                          </span>
                        ) : wo.status === "OPEN" ? (
                          <span className="text-gray-400">
                            En attente d&apos;affectation
                          </span>
                        ) : wo.status === "COMPLETED" ? (
                          <span className="flex items-center gap-1 text-green-600">
                            <CheckCircle2 className="w-3 h-3" /> Terminé
                          </span>
                        ) : (
                          // Everything else — en attente, annulé, à valider sans
                          // droit de gestion — porte son propre libellé. Le
                          // « Terminé » vert servait de cas par défaut, si bien
                          // qu'un bon en pause s'affichait comme un bon fini.
                          <span className="text-gray-400">
                            {formatEnum(wo.status)}
                          </span>
                        )}
                      </div>
                    </div>
                    );
                  })}

                  {col.length === 0 && (
                    <div className="text-center py-8 text-gray-400 text-sm">
                      Aucun bon
                    </div>
                  )}
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
                title="Aucun bon de travail"
                hint="Créez votre premier bon avec le bouton ci-dessus."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                    {["N° de bon", "Titre", "Ascenseur", "Type", "Priorité", "Statut", "Incident", "Affecté à", "Planifié"].map((h) => (
                      <th key={h} className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-6 py-3">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                  {orders.map((wo) => (
                    <tr key={wo.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <td className="px-6 py-4 text-xs font-mono">
                        <Link
                          href={`/bons-de-travail/${wo.id}`}
                          className="text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {wo.orderNumber}
                        </Link>
                      </td>
                      <td className="px-6 py-4 text-sm font-medium text-gray-900 dark:text-white">
                        <Link
                          href={`/bons-de-travail/${wo.id}`}
                          className="hover:text-blue-600 dark:hover:text-blue-400"
                        >
                          {wo.title}
                        </Link>
                      </td>
                      <td className="px-6 py-4 text-xs font-mono text-gray-500">{wo.elevator.elevatorCode}</td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-0.5 text-[10px] font-medium rounded border ${TYPE_COLORS[wo.type] ?? TYPE_COLORS.INSPECTION}`}>
                          {enumLabel(wo.type)}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-0.5 text-[10px] font-bold rounded ${PRIORITY_COLORS[wo.priority] ?? PRIORITY_COLORS.MEDIUM}`}>
                          {enumLabel(wo.priority)}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-0.5 text-[10px] font-bold rounded ${STATUS_CONFIG[wo.status as StatusStyleKey]?.color ?? "bg-gray-100 text-gray-600"}`}>
                          {formatEnum(wo.status)}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        {wo.incident ? (
                          <div className="space-y-1">
                            <ValidationBadge
                              status={wo.incident.status}
                              size="compact"
                            />
                            <p className="font-mono text-[10px] text-gray-400">
                              {wo.incident.incidentNumber}
                            </p>
                          </div>
                        ) : (
                          <span className="text-gray-400 italic text-sm">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-400">
                        <span className="inline-flex items-center gap-1.5">
                          {wo.assignedTo?.name ?? (
                            <span className="text-gray-400 italic">—</span>
                          )}
                          {/* Même indicateur que sur la carte, réduit à une
                              icône : en tableau, la largeur d'une cellule ne
                              permet pas la phrase entière, et le survol la
                              donne. */}
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
                      <td className="px-6 py-4 text-sm text-gray-500">
                        {wo.scheduledDate ? (
                          new Date(wo.scheduledDate).toLocaleDateString("fr-FR")
                        ) : (
                          <span className="text-gray-400 italic">—</span>
                        )}
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
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                Nouveau bon de travail
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
                onChange={(e) => setForm({ ...form, elevatorId: e.target.value })}
                className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white"
              >
                {elevatorOptions.map((el) => (
                  <option key={el.id} value={el.id}>
                    {el.elevatorCode} — {el.building.name}
                  </option>
                ))}
              </select>
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
