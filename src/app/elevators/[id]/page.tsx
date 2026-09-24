"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import {
  ArrowLeft,
  Activity,
  Gauge,
  DoorOpen,
  Zap,
  Clock,
  AlertTriangle,
  TrendingDown,
  Wrench,
  BarChart3,
  Shield,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  Legend,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
} from "recharts";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { formatEnum } from "@/lib/utils";
import { elevatorStatusStyle } from "@/lib/ui/status-styles";
import { OPS_ROLES } from "@/types";

// ─── Types ────────────────────────────────────────────────────

interface ElevatorDetail {
  id: string;
  elevatorCode: string;
  brand: string;
  model: string;
  serialNumber: string | null;
  installationDate: string | null;
  motorType: string;
  maxPayloadKg: number;
  controllerType: string;
  floorsServed: number;
  status: string;
  operatingHours: number;
  doorCycleCount: number;
  brakeActuations: number;
  overallHealth: number;
  lastMaintenance: string | null;
  nextMaintenance: string | null;
  building: { name: string; address: string; city: string };
  components: Array<{
    id: string;
    name: string;
    componentType: string;
    currentLifeHours: number;
    expectedLifeHours: number | null;
    remainingUsefulLife: number;
  }>;
  latestTelemetry: {
    motorVibrationMmS: number | null;
    motorTemperatureC: number | null;
    cabinLoadKg: number | null;
    levelingOffsetMm: number | null;
  } | null;
  telemetryStreams: Array<{
    id: string;
    timestamp: string;
    motorVibrationMmS: number | null;
    motorTemperatureC: number | null;
    cabinLoadKg: number | null;
    levelingOffsetMm: number | null;
    doorSpeedMs: number | null;
    supplyVoltageV: number | null;
    currentDrawA: number | null;
  }>;
  predictiveScores: Array<{
    id: string;
    componentType: string;
    riskLevel: string;
    riskScore: number;
    remainingUsefulLifePercent: number;
    predictedFailureDate: string | null;
    confidence: number;
    recommendations: string[];
  }>;
  workOrders: Array<{
    id: string;
    orderNumber: string;
    title: string;
    status: string;
    priority: string;
    assignedTo: { name: string } | null;
  }>;
  alerts: Array<{
    id: string;
    title: string;
    message: string;
    severity: string;
    createdAt: string;
    isAcknowledged: boolean;
  }>;
}

const RISK_COLORS: Record<string, string> = {
  LOW: "#22c55e",
  MEDIUM: "#eab308",
  HIGH: "#f97316",
  CRITICAL: "#ef4444",
};

function riskOf(rul: number): string {
  if (rul <= 10) return "CRITICAL";
  if (rul <= 25) return "HIGH";
  if (rul <= 50) return "MEDIUM";
  return "LOW";
}

export default function ElevatorDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { data: session } = useSession();
  const [data, setData] = useState<ElevatorDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<"telemetry" | "rul" | "components" | "history">("telemetry");
  const [runningPrediction, setRunningPrediction] = useState(false);
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [actionMsg, setActionMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/elevators/${id}`);
      if (res.status === 404) throw new Error("Elevator not found");
      if (!res.ok) throw new Error(`Detail API returned ${res.status}`);
      const json = await res.json();
      setData(json.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load elevator");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const runPrediction = async () => {
    setRunningPrediction(true);
    setActionMsg("");
    try {
      const res = await fetch("/api/predictive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ elevatorId: id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Prediction failed");
      setActionMsg(
        `Analysis complete — health ${json.analysis.overallHealth}%, risk ${json.analysis.overallRisk}, ${json.workOrdersGenerated} work order(s) generated.`
      );
      await load();
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Prediction failed");
    } finally {
      setRunningPrediction(false);
    }
  };

  const createWorkOrder = async () => {
    if (!data) return;
    setCreatingOrder(true);
    setActionMsg("");
    try {
      const res = await fetch("/api/work-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Inspection — ${data.elevatorCode}`,
          description: `Manual inspection request for ${data.elevatorCode} (${data.brand} ${data.model}).`,
          type: "INSPECTION",
          priority: data.status === "CRITICAL_SHUTDOWN" ? "EMERGENCY" : "MEDIUM",
          elevatorId: data.id,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Work order creation failed");
      setActionMsg(`Work order ${json.data.orderNumber} created.`);
      await load();
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Creation failed");
    } finally {
      setCreatingOrder(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <LoadingSkeleton rows={6} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Link href="/elevators" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft className="w-4 h-4" /> Back to Fleet
        </Link>
        <ErrorState message={error || "Elevator not found"} onRetry={load} />
      </div>
    );
  }

  const el = data;
  const telemetry = [...el.telemetryStreams].reverse().map((t) => ({
    time: new Date(t.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
    vibration: t.motorVibrationMmS,
    temperature: t.motorTemperatureC,
    load: t.cabinLoadKg,
    levelingOffset: t.levelingOffsetMm,
  }));
  const hasTelemetry = telemetry.length > 0;

  const components = el.components.map((c) => ({
    ...c,
    risk: riskOf(c.remainingUsefulLife),
  }));

  const userRole = session?.user?.role;
  // Mirrors the guards on the API: POST /api/predictive is management-only,
  // POST /api/work-orders is open to ops roles. A BUILDING_OWNER holds neither.
  const canRunPrediction =
    userRole === "ADMIN" || userRole === "MAINTENANCE_MANAGER";
  const canCreateWorkOrder = userRole !== undefined && OPS_ROLES.includes(userRole);

  return (
    <div className="space-y-6">
      {/* Back + Header */}
      <div>
        <Link
          href="/elevators"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Fleet
        </Link>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white font-mono">
                {el.elevatorCode}
              </h2>
              <span
                className={`px-2.5 py-1 text-xs font-bold rounded-full border ${
                  elevatorStatusStyle(el.status).bg
                } ${elevatorStatusStyle(el.status).text}`}
              >
                <span
                  className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${
                    elevatorStatusStyle(el.status).dot
                  }`}
                />
                {formatEnum(el.status)}
              </span>
            </div>
            <p className="text-gray-500 mt-1">
              {formatEnum(el.brand)} {el.model} — {el.building.name} ({el.building.address}, {el.building.city})
            </p>
          </div>
          <div className="flex gap-2">
            {canCreateWorkOrder && (
              <button
                onClick={createWorkOrder}
                disabled={creatingOrder}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                <Wrench className="w-4 h-4 inline mr-1.5" />
                {creatingOrder ? "Creating…" : "Create Work Order"}
              </button>
            )}
            {/* POST /api/predictive is restricted to management roles; showing
                the button to a technician or building owner would only ever
                produce a 403. */}
            {canRunPrediction && (
              <button
                onClick={runPrediction}
                disabled={runningPrediction}
                className="px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-sm font-medium rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
              >
                {runningPrediction ? "Analyzing…" : "Run Prediction"}
              </button>
            )}
          </div>
        </div>
        {actionMsg && (
          <p className="mt-2 text-sm text-blue-600 dark:text-blue-400">{actionMsg}</p>
        )}
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {[
          { icon: Shield, label: "Health", value: `${el.overallHealth}%`, color: "text-green-600" },
          { icon: Gauge, label: "Motor Hours", value: el.operatingHours.toLocaleString(), color: "text-blue-600" },
          { icon: DoorOpen, label: "Door Cycles", value: el.doorCycleCount.toLocaleString(), color: "text-purple-600" },
          { icon: Zap, label: "Brake Acts", value: el.brakeActuations.toLocaleString(), color: "text-orange-600" },
          { icon: Clock, label: "Last Service", value: el.lastMaintenance ? new Date(el.lastMaintenance).toLocaleDateString() : "—", color: "text-gray-600" },
          { icon: AlertTriangle, label: "Next Service", value: el.nextMaintenance ? new Date(el.nextMaintenance).toLocaleDateString() : "—", color: "text-yellow-600" },
        ].map((stat) => (
          <Card key={stat.label} className="p-4">
            <stat.icon className={`w-4 h-4 ${stat.color} mb-2`} />
            <p className="text-xs text-gray-500">{stat.label}</p>
            <p className="text-lg font-bold text-gray-900 dark:text-white">{stat.value}</p>
          </Card>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg w-fit flex-wrap">
        {[
          { key: "telemetry", label: "Live Telemetry", icon: Activity },
          { key: "rul", label: "Predictive RUL", icon: TrendingDown },
          { key: "components", label: "Components", icon: BarChart3 },
          { key: "history", label: "Orders & Alerts", icon: Clock },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key as typeof activeTab)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              activeTab === tab.key
                ? "bg-white dark:bg-gray-900 text-gray-900 dark:text-white shadow-sm"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Telemetry Tab */}
      {activeTab === "telemetry" && (
        !hasTelemetry ? (
          <EmptyState
            title="No telemetry yet"
            hint="Run the IoT simulator (npm run simulate-iot) to stream live sensor data for this unit."
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-900 dark:text-white">Motor Vibration</h3>
                <span className="text-xs text-gray-500">mm/s</span>
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={telemetry}>
                  <defs>
                    <linearGradient id="vibGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="time" tick={{ fontSize: 10 }} stroke="#9ca3af" />
                  <YAxis tick={{ fontSize: 10 }} stroke="#9ca3af" domain={[0, 10]} />
                  <Tooltip />
                  <Area type="monotone" dataKey="vibration" stroke="#3b82f6" fill="url(#vibGrad)" strokeWidth={2} dot={false} connectNulls />
                  <Line type="monotone" dataKey={() => 4} stroke="#eab308" strokeDasharray="5 5" dot={false} strokeWidth={1} />
                  <Line type="monotone" dataKey={() => 7} stroke="#ef4444" strokeDasharray="5 5" dot={false} strokeWidth={1} />
                </AreaChart>
              </ResponsiveContainer>
              <p className="text-xs text-gray-500 mt-2">
                <span className="text-yellow-500">— —</span> Warning (4.0 mm/s) &nbsp;
                <span className="text-red-500">— —</span> Critical (7.0 mm/s)
              </p>
            </Card>

            <Card className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-900 dark:text-white">Motor Temperature</h3>
                <span className="text-xs text-gray-500">°C</span>
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={telemetry}>
                  <defs>
                    <linearGradient id="tempGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#ef4444" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#ef4444" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="time" tick={{ fontSize: 10 }} stroke="#9ca3af" />
                  <YAxis tick={{ fontSize: 10 }} stroke="#9ca3af" domain={[40, 120]} />
                  <Tooltip />
                  <Area type="monotone" dataKey="temperature" stroke="#ef4444" fill="url(#tempGrad)" strokeWidth={2} dot={false} connectNulls />
                  <Line type="monotone" dataKey={() => 85} stroke="#eab308" strokeDasharray="5 5" dot={false} strokeWidth={1} />
                  <Line type="monotone" dataKey={() => 105} stroke="#ef4444" strokeDasharray="5 5" dot={false} strokeWidth={1} />
                </AreaChart>
              </ResponsiveContainer>
            </Card>

            <Card className="p-6">
              <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Cabin Load</h3>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={telemetry}>
                  <defs>
                    <linearGradient id="loadGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="time" tick={{ fontSize: 10 }} stroke="#9ca3af" />
                  <YAxis tick={{ fontSize: 10 }} stroke="#9ca3af" tickFormatter={(v: number) => `${(v / 1000).toFixed(1)}t`} />
                  <Tooltip formatter={(v: number) => [`${v} kg`, "Load"]} />
                  <Area type="monotone" dataKey="load" stroke="#8b5cf6" fill="url(#loadGrad)" strokeWidth={2} dot={false} connectNulls />
                </AreaChart>
              </ResponsiveContainer>
            </Card>

            <Card className="p-6">
              <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Leveling Offset</h3>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={telemetry}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="time" tick={{ fontSize: 10 }} stroke="#9ca3af" />
                  <YAxis tick={{ fontSize: 10 }} stroke="#9ca3af" domain={[-15, 15]} />
                  <Tooltip formatter={(v: number) => [`${v.toFixed(1)} mm`, "Offset"]} />
                  <Line type="monotone" dataKey="levelingOffset" stroke="#06b6d4" strokeWidth={2} dot={false} connectNulls />
                  <Line type="monotone" dataKey={() => 8} stroke="#eab308" strokeDasharray="5 5" dot={false} strokeWidth={1} />
                  <Line type="monotone" dataKey={() => -8} stroke="#eab308" strokeDasharray="5 5" dot={false} strokeWidth={1} />
                </LineChart>
              </ResponsiveContainer>
            </Card>
          </div>
        )
      )}

      {/* RUL Tab */}
      {activeTab === "rul" && (
        <div className="space-y-6">
          {el.predictiveScores.length === 0 && components.length === 0 ? (
            <EmptyState
              title="No predictions yet"
              hint="Click “Run Prediction” to analyze this elevator with the AI degradation engine."
            />
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                {(el.predictiveScores.length > 0
                  ? el.predictiveScores.map((s) => ({
                      key: s.id,
                      name: formatEnum(s.componentType),
                      rul: s.remainingUsefulLifePercent,
                      risk: s.riskLevel,
                    }))
                  : components.map((c) => ({
                      key: c.id,
                      name: c.name,
                      rul: c.remainingUsefulLife,
                      risk: c.risk,
                    }))
                ).map((comp) => (
                  <Card key={comp.key} className="p-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-medium text-gray-500 truncate">{comp.name}</p>
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0 ml-1"
                        style={{ backgroundColor: RISK_COLORS[comp.risk] ?? "#6b7280" }}
                      />
                    </div>
                    <p className="text-2xl font-bold text-gray-900 dark:text-white">
                      {comp.rul.toFixed(1)}%
                    </p>
                    <p className="text-xs text-gray-500 mt-1">Remaining Life</p>
                    <div className="mt-2 h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.min(100, Math.max(0, comp.rul))}%`,
                          backgroundColor: RISK_COLORS[comp.risk] ?? "#6b7280",
                        }}
                      />
                    </div>
                    <p
                      className="text-[10px] font-bold mt-1.5"
                      style={{ color: RISK_COLORS[comp.risk] ?? "#6b7280" }}
                    >
                      Risk: {comp.risk}
                    </p>
                  </Card>
                ))}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card className="p-6">
                  <h3 className="font-semibold text-gray-900 dark:text-white mb-4">
                    Component Health Radar
                  </h3>
                  <ResponsiveContainer width="100%" height={300}>
                    <RadarChart
                      data={components.map((c) => ({
                        subject: c.name,
                        health: c.remainingUsefulLife,
                        fullMark: 100,
                      }))}
                    >
                      <PolarGrid />
                      <PolarAngleAxis dataKey="subject" tick={{ fontSize: 10 }} />
                      <PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fontSize: 9 }} />
                      <Radar name="RUL %" dataKey="health" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.3} />
                    </RadarChart>
                  </ResponsiveContainer>
                </Card>

                <Card className="p-6">
                  <h3 className="font-semibold text-gray-900 dark:text-white mb-4">
                    Usage vs Expected Life
                  </h3>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart
                      data={components.map((c) => ({
                        name: c.name,
                        hours: c.currentLifeHours,
                        maxHours: c.expectedLifeHours ?? 0,
                      }))}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="name" tick={{ fontSize: 9 }} stroke="#9ca3af" />
                      <YAxis tick={{ fontSize: 10 }} stroke="#9ca3af" tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`} />
                      <Tooltip formatter={(v: number) => [`${(v / 1000).toFixed(1)}k hrs`]} />
                      <Legend />
                      <Bar dataKey="hours" fill="#3b82f6" name="Current Hours" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="maxHours" fill="#e5e7eb" name="Expected Life" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </Card>
              </div>

              {el.predictiveScores.length > 0 && (
                <Card className="p-6">
                  <h3 className="font-semibold text-gray-900 dark:text-white mb-4">
                    AI Recommendations
                  </h3>
                  <div className="space-y-3">
                    {el.predictiveScores.map((s) => (
                      <div key={s.id} className="border-l-4 pl-4" style={{ borderColor: RISK_COLORS[s.riskLevel] ?? "#6b7280" }}>
                        <p className="text-sm font-medium text-gray-900 dark:text-white">
                          {formatEnum(s.componentType)} — {s.riskLevel} (confidence {(s.confidence * 100).toFixed(0)}%)
                        </p>
                        <ul className="mt-1 space-y-0.5">
                          {s.recommendations.map((r, i) => (
                            <li key={i} className="text-sm text-gray-600 dark:text-gray-400">• {r}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      )}

      {/* Components Tab */}
      {activeTab === "components" && (
        <Card>
          <div className="p-6 border-b border-gray-200 dark:border-gray-800">
            <h3 className="font-semibold text-gray-900 dark:text-white">
              Component Breakdown
            </h3>
          </div>
          {components.length === 0 ? (
            <div className="p-6">
              <EmptyState title="No components tracked" hint="Components are created at registration and by the seed script." />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-800">
                    {["Component", "Type", "Current Hours", "Expected Life", "RUL %", "Risk"].map((h) => (
                      <th key={h} className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-6 py-3">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                  {components.map((comp) => (
                    <tr key={comp.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <td className="px-6 py-4 text-sm font-medium text-gray-900 dark:text-white">{comp.name}</td>
                      <td className="px-6 py-4 text-sm text-gray-500 font-mono">{comp.componentType}</td>
                      <td className="px-6 py-4 text-sm text-gray-900 dark:text-white">{comp.currentLifeHours.toLocaleString()} hrs</td>
                      <td className="px-6 py-4 text-sm text-gray-500">{comp.expectedLifeHours?.toLocaleString() ?? "—"} hrs</td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <div className="w-20 h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${Math.min(100, Math.max(0, comp.remainingUsefulLife))}%`,
                                backgroundColor: RISK_COLORS[comp.risk],
                              }}
                            />
                          </div>
                          <span className="text-sm font-medium text-gray-900 dark:text-white">{comp.remainingUsefulLife.toFixed(1)}%</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className="px-2 py-0.5 text-[10px] font-bold rounded-full"
                          style={{
                            backgroundColor: `${RISK_COLORS[comp.risk]}20`,
                            color: RISK_COLORS[comp.risk],
                          }}
                        >
                          {comp.risk}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* History Tab */}
      {activeTab === "history" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="p-6">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Recent Work Orders</h3>
            {el.workOrders.length === 0 ? (
              <EmptyState title="No work orders" hint="Create one from the header button." />
            ) : (
              <div className="space-y-2">
                {el.workOrders.map((wo) => (
                  <div key={wo.id} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                    <div>
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{wo.title}</p>
                      <p className="text-xs text-gray-500 font-mono">{wo.orderNumber} • {wo.assignedTo?.name ?? "Unassigned"}</p>
                    </div>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-700">{wo.status}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card className="p-6">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Recent Alerts</h3>
            {el.alerts.length === 0 ? (
              <EmptyState title="No alerts" hint="Threshold breaches from telemetry will appear here." />
            ) : (
              <div className="space-y-2">
                {el.alerts.map((a) => (
                  <div key={a.id} className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{a.title}</p>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-orange-100 text-orange-700">{a.severity}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">{a.message}</p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Specifications */}
      <Card className="p-6">
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Specifications</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {[
            { label: "Brand", value: formatEnum(el.brand) },
            { label: "Model", value: el.model },
            { label: "Serial No.", value: el.serialNumber ?? "—" },
            { label: "Installation", value: el.installationDate ? new Date(el.installationDate).toLocaleDateString() : "—" },
            { label: "Motor Type", value: formatEnum(el.motorType) },
            { label: "Max Payload", value: `${el.maxPayloadKg} kg` },
            { label: "Controller", value: formatEnum(el.controllerType) },
            { label: "Floors Served", value: String(el.floorsServed) },
          ].map((spec) => (
            <div key={spec.label}>
              <p className="text-xs text-gray-500 mb-0.5">{spec.label}</p>
              <p className="text-sm font-medium text-gray-900 dark:text-white">{spec.value}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
