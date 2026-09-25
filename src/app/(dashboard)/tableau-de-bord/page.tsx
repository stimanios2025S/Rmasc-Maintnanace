"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ArrowUpRight,
  ClipboardList,
  Building2,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  Legend,
} from "recharts";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import { Card } from "@/components/ui/card";
import { ErrorState, LoadingSkeleton } from "@/components/ui/states";

// ─── Types ────────────────────────────────────────────────────

interface DashboardStats {
  totalBuildings: number;
  totalElevators: number;
  operationalCount: number;
  serviceRequiredCount: number;
  anomalyCount: number;
  criticalCount: number;
  offlineCount: number;
  openWorkOrders: number;
  emergencyWorkOrders: number;
  avgHealth: number;
}

interface StatusSlice {
  name: string;
  value: number;
  color: string;
}

interface BuildingHealth {
  id: string;
  name: string;
  elevators: number;
  health: number;
}

interface RecentAlert {
  id: string;
  elevator: string;
  message: string;
  severity: string;
  createdAt: string;
  acknowledged: boolean;
}

interface TelemetryPoint {
  time: string;
  vibration: number | null;
  temperature: number | null;
  load: number | null;
}

interface TelemetryFeed {
  elevatorId: string;
  elevatorCode: string;
  lastReadingAt: string;
  points: {
    timestamp: string;
    motorVibrationMmS: number | null;
    motorTemperatureC: number | null;
    cabinLoadKg: number | null;
  }[];
}

/** Readings older than this are shown as stale rather than live. */
const LIVE_WINDOW_MS = 5 * 60 * 1000;

const formatPointTime = (timestamp: string): string =>
  new Date(timestamp).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });

const SEVERITY_COLORS: Record<string, string> = {
  CRITICAL: "bg-red-100 text-red-800 border-red-200",
  EMERGENCY: "bg-red-100 text-red-800 border-red-200",
  ANOMALY: "bg-orange-100 text-orange-800 border-orange-200",
  WARNING: "bg-yellow-100 text-yellow-800 border-yellow-200",
  INFO: "bg-blue-100 text-blue-800 border-blue-200",
};

/**
 * French labels for the severity enum. The enum *value* stays as stored and as
 * the API sends it (`CRITICAL`, …) — only what the reader sees changes.
 */
const SEVERITY_LABELS: Record<string, string> = {
  CRITICAL: "Critique",
  EMERGENCY: "Urgence",
  ANOMALY: "Anomalie",
  WARNING: "Avertissement",
  INFO: "Information",
};

// ─── Dashboard Page ─────────────────────────────────────────

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [statusBreakdown, setStatusBreakdown] = useState<StatusSlice[]>([]);
  const [buildingHealth, setBuildingHealth] = useState<BuildingHealth[]>([]);
  const [alerts, setAlerts] = useState<RecentAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [telemetryFeed, setTelemetryFeed] = useState<TelemetryFeed | null>(null);

  const load = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    // A background refresh must not swap the page back to the skeleton.
    if (!silent) setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/dashboard");
      if (!res.ok)
        throw new Error(`L'API du tableau de bord a répondu ${res.status}`);
      const json = await res.json();
      setStats(json.data.stats);
      setStatusBreakdown(json.data.statusBreakdown);
      setBuildingHealth(json.data.buildingHealth);
      setAlerts(json.data.recentAlerts);
      setTelemetryFeed(json.data.telemetryFeed ?? null);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Échec du chargement des données du tableau de bord"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll for fresh readings. Refreshing the whole payload also keeps the KPI
  // tiles and alert list current, which the previous telemetry-only ticker did
  // not do.
  useEffect(() => {
    const interval = setInterval(() => {
      void load({ silent: true });
    }, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  const telemetryData: TelemetryPoint[] = (telemetryFeed?.points ?? []).map(
    (p) => ({
      time: formatPointTime(p.timestamp),
      vibration: p.motorVibrationMmS,
      temperature: p.motorTemperatureC,
      load: p.cabinLoadKg,
    })
  );

  const lastReadingAt = telemetryFeed?.lastReadingAt
    ? new Date(telemetryFeed.lastReadingAt)
    : null;
  const isLive =
    lastReadingAt !== null && Date.now() - lastReadingAt.getTime() < LIVE_WINDOW_MS;

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} className="p-6">
              <div className="h-8 w-24 rounded bg-gray-100 dark:bg-gray-800 animate-pulse" />
              <div className="h-9 w-16 rounded bg-gray-100 dark:bg-gray-800 animate-pulse mt-2" />
            </Card>
          ))}
        </div>
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  if (error || !stats) {
    return (
      <ErrorState
        message={error || "Aucune donnée du tableau de bord"}
        onRetry={load}
      />
    );
  }

  const statCards = [
    {
      label: "Ascenseurs au total",
      value: String(stats.totalElevators),
      sub: `${stats.totalBuildings} ${
        stats.totalBuildings > 1 ? "immeubles" : "immeuble"
      }`,
      icon: Activity,
      color: "text-blue-600 bg-blue-100 dark:bg-blue-900/30",
    },
    {
      label: "Opérationnels",
      value: String(stats.operationalCount),
      sub: `${stats.avgHealth} % de santé moyenne`,
      icon: CheckCircle2,
      color: "text-green-600 bg-green-100 dark:bg-green-900/30",
    },
    {
      label: "Bons de travail ouverts",
      value: String(stats.openWorkOrders),
      sub: `${stats.emergencyWorkOrders} ${
        stats.emergencyWorkOrders > 1 ? "urgences" : "urgence"
      }`,
      icon: ClipboardList,
      color: "text-yellow-600 bg-yellow-100 dark:bg-yellow-900/30",
    },
    {
      label: "Unités critiques",
      value: String(stats.criticalCount),
      sub: `${stats.anomalyCount} ${
        stats.anomalyCount > 1 ? "anomalies" : "anomalie"
      }`,
      icon: XCircle,
      color: "text-red-600 bg-red-100 dark:bg-red-900/30",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((stat) => (
          <Card key={stat.label} className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {stat.label}
                </p>
                <p className="text-3xl font-bold text-gray-900 dark:text-white mt-1">
                  {stat.value}
                </p>
                <div className="flex items-center gap-1 mt-2">
                  <ArrowUpRight className="w-3 h-3 text-gray-400" />
                  <span className="text-xs text-gray-500">{stat.sub}</span>
                </div>
              </div>
              <div className={`p-3 rounded-xl ${stat.color}`}>
                <stat.icon className="w-6 h-6" />
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Telemetry Chart */}
        <Card className="lg:col-span-2 p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                Télémétrie
              </h3>
              <p className="text-sm text-gray-500">
                {telemetryFeed
                  ? `Derniers relevés de ${telemetryFeed.elevatorCode}`
                  : "Aucune télémétrie reçue pour le moment"}
              </p>
            </div>
            {lastReadingAt && (
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full ${
                    isLive ? "bg-green-500 animate-pulse" : "bg-gray-400"
                  }`}
                />
                <span className="text-xs text-gray-500">
                  {isLive
                    ? "EN DIRECT"
                    : `DERNIER RELEVÉ ${formatDistanceToNow(lastReadingAt, {
                        locale: fr,
                      }).toUpperCase()}`}
                </span>
              </div>
            )}
          </div>
          {telemetryData.length === 0 ? (
            <div className="h-[300px] flex items-center justify-center text-sm text-gray-500">
              Aucun relevé de capteur n&apos;a encore été reçu pour ce parc.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={telemetryData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="time" tick={{ fontSize: 12 }} stroke="#9ca3af" />
                <YAxis tick={{ fontSize: 12 }} stroke="#9ca3af" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "white",
                    border: "1px solid #e5e7eb",
                    borderRadius: "8px",
                    boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
                  }}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="vibration"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={false}
                  name="Vibration (mm/s)"
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="temperature"
                  stroke="#ef4444"
                  strokeWidth={2}
                  dot={false}
                  name="Température (°C)"
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* Status Breakdown Pie */}
        <Card className="p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            État du parc
          </h3>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={statusBreakdown}
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={80}
                paddingAngle={4}
                dataKey="value"
              >
                {statusBreakdown.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
          <div className="grid grid-cols-2 gap-2 mt-2">
            {statusBreakdown.map((item) => (
              <div key={item.name} className="flex items-center gap-2 text-sm">
                <span
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: item.color }}
                />
                <span className="text-gray-600 dark:text-gray-400">
                  {item.name}
                </span>
                <span className="ml-auto font-medium text-gray-900 dark:text-white">
                  {item.value}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Building Health & Alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Building Health */}
        <Card className="p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Vue d&apos;ensemble de la santé des immeubles
          </h3>
          {buildingHealth.length === 0 ? (
            <p className="text-sm text-gray-500">
              Aucun immeuble enregistré pour le moment.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={buildingHealth} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis
                  type="number"
                  domain={[0, 100]}
                  tick={{ fontSize: 12 }}
                  stroke="#9ca3af"
                  tickFormatter={(v: number) => `${v}%`}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={120}
                  tick={{ fontSize: 12 }}
                  stroke="#9ca3af"
                />
                <Tooltip
                  formatter={(value: number) => [`${value}%`, "Santé"]}
                  contentStyle={{
                    backgroundColor: "white",
                    border: "1px solid #e5e7eb",
                    borderRadius: "8px",
                  }}
                />
                <Bar dataKey="health" radius={[0, 4, 4, 0]} fill="#3b82f6" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* Recent Alerts */}
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Alertes récentes
            </h3>
            <span className="text-xs text-gray-500 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              {alerts.length} {alerts.length > 1 ? "affichées" : "affichée"}
            </span>
          </div>
          {alerts.length === 0 ? (
            <p className="text-sm text-gray-500 flex items-center gap-2">
              <Building2 className="w-4 h-4" />
              Aucune alerte — la télémétrie du parc est nominale.
            </p>
          ) : (
            <div className="space-y-3">
              {alerts.map((alert) => (
                <div
                  key={alert.id}
                  className={`p-3 rounded-lg border ${
                    SEVERITY_COLORS[alert.severity] ?? SEVERITY_COLORS.INFO
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono opacity-70">
                        {alert.elevator}
                      </span>
                      <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-black/10">
                        {SEVERITY_LABELS[alert.severity] ?? alert.severity}
                      </span>
                      {alert.acknowledged && (
                        <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-black/10">
                          ACQUITTÉE
                        </span>
                      )}
                    </div>
                    <span className="text-xs opacity-60">
                      {formatDistanceToNow(new Date(alert.createdAt), {
                        addSuffix: true,
                        locale: fr,
                      })}
                    </span>
                  </div>
                  <p className="text-sm mt-1">{alert.message}</p>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
