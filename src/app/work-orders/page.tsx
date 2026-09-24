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
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { ValidationBadge } from "@/components/ui/validation-badge";
import { ProgressTrack } from "@/components/ui/progress-track";
import { formatEnum } from "@/lib/utils";
import { useSession } from "next-auth/react";
import { OPS_ROLES } from "@/types";
import type { IncidentStatus } from "@/types";

// ─── Types ────────────────────────────────────────────────────

type StatusKey = "OPEN" | "ASSIGNED" | "IN_PROGRESS" | "COMPLETED";

const STATUSES: StatusKey[] = ["OPEN", "ASSIGNED", "IN_PROGRESS", "COMPLETED"];

const STATUS_CONFIG: Record<
  StatusKey,
  { label: string; icon: typeof Clock; color: string; headerColor: string }
> = {
  OPEN: { label: "Open", icon: Clock, color: "bg-gray-100 text-gray-600", headerColor: "bg-gray-500" },
  ASSIGNED: { label: "Assigned", icon: User, color: "bg-blue-100 text-blue-600", headerColor: "bg-blue-500" },
  IN_PROGRESS: { label: "In Progress", icon: Wrench, color: "bg-yellow-100 text-yellow-600", headerColor: "bg-yellow-500" },
  COMPLETED: { label: "Completed", icon: CheckCircle2, color: "bg-green-100 text-green-600", headerColor: "bg-green-500" },
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
const NEXT_STATUS: Record<string, string> = {
  ASSIGNED: "IN_PROGRESS",
  IN_PROGRESS: "COMPLETED",
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
      if (!woRes.ok) throw new Error(`Work orders API returned ${woRes.status}`);
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
      setError(e instanceof Error ? e.message : "Failed to load work orders");
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
        throw new Error(json.error ?? "Update failed");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
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
      if (!res.ok) throw new Error(json.message ?? json.error ?? "Dispatch failed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dispatch failed");
    } finally {
      setBusyId(null);
    }
  };

  const createOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");
    if (!form.title.trim() || !form.elevatorId) {
      setFormError("Title and elevator are required.");
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
      if (!res.ok) throw new Error(json.error ?? "Creation failed");
      setShowCreate(false);
      setForm({ title: "", type: "PREVENTIVE", priority: "MEDIUM", elevatorId: elevatorOptions[0]?.id ?? "", scheduledDate: "", estimatedHours: "" });
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Creation failed");
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

  const activeCount = orders.filter((wo) => wo.status !== "COMPLETED").length;

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
            Work Orders
          </h2>
          <p className="text-gray-500 mt-1">
            {orders.length} total orders • {activeCount} active
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
                {v}
              </button>
            ))}
          </div>
          {canManage && (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Work Order
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
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {ordersByStatus.map(({ status, orders: col }) => {
            const config = STATUS_CONFIG[status];
            return (
              <div key={status} className="flex flex-col">
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
                  {col.map((wo) => (
                    <div
                      key={wo.id}
                      className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4 hover:shadow-md transition-shadow"
                    >
                      <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                        <span className={`px-1.5 py-0.5 text-[10px] font-bold rounded ${PRIORITY_COLORS[wo.priority] ?? PRIORITY_COLORS.MEDIUM}`}>
                          {wo.priority}
                        </span>
                        <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded border ${TYPE_COLORS[wo.type] ?? TYPE_COLORS.INSPECTION}`}>
                          {wo.type}
                        </span>
                      </div>

                      <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">
                        {wo.title}
                      </h4>
                      <p className="text-[10px] font-mono text-gray-400 mb-2">
                        {wo.orderNumber}
                      </p>

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
                                title="Created by the emergency button — the occupant never worked through the error code"
                              >
                                EMERGENCY
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
                            href="/admin/incidents"
                            className="inline-block text-[10px] font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400"
                          >
                            Open on the incident board →
                          </Link>
                        </div>
                      )}

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
                            {busyId === wo.id ? "Dispatching…" : "Auto-dispatch"}
                          </button>
                        ) : (
                          <span className="text-gray-400">Unassigned</span>
                        )}
                        {wo.scheduledDate && (
                          <div className="flex items-center gap-1 text-gray-400">
                            <Calendar className="w-3 h-3" />
                            <span>{new Date(wo.scheduledDate).toLocaleDateString()}</span>
                          </div>
                        )}
                      </div>

                      <div className="pt-2 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between text-xs text-gray-400">
                        <span>Est. {wo.estimatedHours ?? "—"}h</span>
                        {NEXT_STATUS[wo.status] && canManage ? (
                          <button
                            onClick={() => mutate(wo.id, { status: NEXT_STATUS[wo.status] })}
                            disabled={busyId === wo.id}
                            className="flex items-center gap-0.5 text-blue-600 font-medium hover:text-blue-700 disabled:opacity-50"
                          >
                            Move to {formatEnum(NEXT_STATUS[wo.status])}
                            <ChevronRight className="w-3 h-3" />
                          </button>
                        ) : !canManage ? (
                          <span className="text-gray-400">
                            {formatEnum(wo.status)}
                          </span>
                        ) : wo.status === "OPEN" ? (
                          <span className="text-gray-400">Awaiting assignment</span>
                        ) : (
                          <span className="flex items-center gap-1 text-green-600">
                            <CheckCircle2 className="w-3 h-3" /> Done
                          </span>
                        )}
                      </div>
                    </div>
                  ))}

                  {col.length === 0 && (
                    <div className="text-center py-8 text-gray-400 text-sm">
                      No orders
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
              <EmptyState title="No work orders" hint="Create your first order with the button above." />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                    {["Order", "Title", "Elevator", "Type", "Priority", "Status", "Incident", "Assigned", "Scheduled"].map((h) => (
                      <th key={h} className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-6 py-3">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                  {orders.map((wo) => (
                    <tr key={wo.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <td className="px-6 py-4 text-xs font-mono text-blue-600">{wo.orderNumber}</td>
                      <td className="px-6 py-4 text-sm font-medium text-gray-900 dark:text-white">{wo.title}</td>
                      <td className="px-6 py-4 text-xs font-mono text-gray-500">{wo.elevator.elevatorCode}</td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-0.5 text-[10px] font-medium rounded border ${TYPE_COLORS[wo.type] ?? TYPE_COLORS.INSPECTION}`}>
                          {wo.type}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-0.5 text-[10px] font-bold rounded ${PRIORITY_COLORS[wo.priority] ?? PRIORITY_COLORS.MEDIUM}`}>
                          {wo.priority}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-0.5 text-[10px] font-bold rounded ${STATUS_CONFIG[wo.status as StatusKey]?.color ?? "bg-gray-100 text-gray-600"}`}>
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
                        {wo.assignedTo?.name ?? <span className="text-gray-400 italic">—</span>}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-500">
                        {wo.scheduledDate ? new Date(wo.scheduledDate).toLocaleDateString() : <span className="text-gray-400 italic">—</span>}
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
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">New Work Order</h3>
              <button onClick={() => setShowCreate(false)} aria-label="Close" className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800">
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
                placeholder="Title (e.g. Monthly Safety Inspection)"
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
                  placeholder="Est. hours"
                  className="px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white"
                />
              </div>
              <button
                type="submit"
                disabled={busyId === "create"}
                className="w-full py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {busyId === "create" ? "Creating…" : "Create Work Order"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
