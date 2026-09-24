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

/**
 * French labels for the enum values this screen renders. The keys stay the
 * API's identifiers — only the text the user reads is translated.
 */
const STATUS_LABELS: Record<string, string> = {
  OPERATIONAL: "En service",
  SERVICE_REQUIRED: "Entretien requis",
  ANOMALY_DETECTED: "Anomalie détectée",
  CRITICAL_SHUTDOWN: "Arrêt critique",
  OFFLINE: "Hors ligne",
};

/** Brand names are proper nouns and stay as they are; only `OTHER` translates. */
const BRAND_LABELS: Record<string, string> = {
  OTIS: "OTIS",
  SCHINDLER: "SCHINDLER",
  THYSSENKRUPP: "THYSSENKRUPP",
  MITSUBISHI: "MITSUBISHI",
  HITACHI: "HITACHI",
  KONE: "KONE",
  OTHER: "Autre",
};

const MOTOR_TYPE_LABELS: Record<string, string> = {
  AC_GEARED: "Alternatif avec réducteur",
  AC_GEARDLESS: "Alternatif sans réducteur",
  DC_GEARED: "Continu avec réducteur",
  HYDRAULIC: "Hydraulique",
  OTHER: "Autre",
};

const CONTROLLER_TYPE_LABELS: Record<string, string> = {
  MICROPROCESSOR: "Microprocesseur",
  PLC: "Automate programmable",
  RELAY_LOGIC: "Logique à relais",
  FULLY_DIGITAL: "Entièrement numérique",
  OTHER: "Autre",
};

const COMPONENT_TYPE_LABELS: Record<string, string> = {
  TRACTION_MOTOR: "Moteur de traction",
  BRAKE_ASSEMBLY: "Ensemble de frein",
  DOOR_OPERATOR: "Opérateur de porte",
  STEEL_ROPES: "Câbles en acier",
  GUIDE_SHOES: "Patins de guidage",
  CONTROLLER_BOARD: "Carte de commande",
  COUNTERWEIGHT: "Contrepoids",
  CABIN: "Cabine",
  HYDRAULIC_UNIT: "Groupe hydraulique",
  SAFETY_GEAR: "Parachute",
  BUFFER: "Amortisseur",
  OTHER: "Autre",
};

const RISK_LABELS: Record<string, string> = {
  LOW: "Faible",
  MEDIUM: "Moyen",
  HIGH: "Élevé",
  CRITICAL: "Critique",
};

const WORK_ORDER_STATUS_LABELS: Record<string, string> = {
  OPEN: "Ouvert",
  ASSIGNED: "Assigné",
  IN_PROGRESS: "En cours",
  ON_HOLD: "En attente",
  COMPLETED: "Terminé",
  CANCELLED: "Annulé",
};

const ALERT_SEVERITY_LABELS: Record<string, string> = {
  INFO: "Information",
  WARNING: "Avertissement",
  ANOMALY: "Anomalie",
  CRITICAL: "Critique",
  EMERGENCY: "Urgence",
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
      if (res.status === 404) throw new Error("Ascenseur introuvable");
      if (!res.ok) throw new Error(`L'API de détail a renvoyé ${res.status}`);
      const json = await res.json();
      setData(json.data);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Impossible de charger l'ascenseur"
      );
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
      if (!res.ok) throw new Error(json.error ?? "Échec de l'analyse prédictive");
      const riskLabel =
        RISK_LABELS[json.analysis.overallRisk] ?? json.analysis.overallRisk;
      const generatedSuffix = json.workOrdersGenerated > 1 ? "s" : "";
      setActionMsg(
        `Analyse terminée — santé ${json.analysis.overallHealth} %, risque ${riskLabel}, ` +
          `${json.workOrdersGenerated} bon${generatedSuffix} de travail généré${generatedSuffix}.`
      );
      await load();
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Échec de l'analyse prédictive");
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
          description: `Demande d'inspection manuelle pour ${
            data.elevatorCode
          } (${BRAND_LABELS[data.brand] ?? data.brand} ${data.model}).`,
          type: "INSPECTION",
          priority: data.status === "CRITICAL_SHUTDOWN" ? "EMERGENCY" : "MEDIUM",
          elevatorId: data.id,
        }),
      });
      const json = await res.json();
      if (!res.ok)
        throw new Error(json.error ?? "Échec de la création du bon de travail");
      setActionMsg(`Bon de travail ${json.data.orderNumber} créé.`);
      await load();
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Échec de la création");
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
        <Link href="/ascenseurs" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft className="w-4 h-4" /> Retour au parc
        </Link>
        <ErrorState message={error || "Ascenseur introuvable"} onRetry={load} />
      </div>
    );
  }

  const el = data;
  const telemetry = [...el.telemetryStreams].reverse().map((t) => ({
    time: new Date(t.timestamp).toLocaleTimeString("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
    }),
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
          href="/ascenseurs"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> Retour au parc
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
                {STATUS_LABELS[el.status] ?? formatEnum(el.status)}
              </span>
            </div>
            <p className="text-gray-500 mt-1">
              {BRAND_LABELS[el.brand] ?? el.brand} {el.model} —{" "}
              {el.building.name} ({el.building.address}, {el.building.city})
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
                {creatingOrder ? "Création…" : "Créer un bon de travail"}
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
                {runningPrediction
                  ? "Analyse en cours…"
                  : "Lancer l'analyse prédictive"}
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
          {
            icon: Shield,
            label: "Santé",
            value: `${el.overallHealth}%`,
            color: "text-green-600",
          },
          {
            icon: Gauge,
            label: "Heures moteur",
            value: el.operatingHours.toLocaleString("fr-FR"),
            color: "text-blue-600",
          },
          {
            icon: DoorOpen,
            label: "Cycles de porte",
            value: el.doorCycleCount.toLocaleString("fr-FR"),
            color: "text-purple-600",
          },
          {
            icon: Zap,
            label: "Actionnements de frein",
            value: el.brakeActuations.toLocaleString("fr-FR"),
            color: "text-orange-600",
          },
          {
            icon: Clock,
            label: "Dernier entretien",
            value: el.lastMaintenance
              ? new Date(el.lastMaintenance).toLocaleDateString("fr-FR")
              : "—",
            color: "text-gray-600",
          },
          {
            icon: AlertTriangle,
            label: "Prochain entretien",
            value: el.nextMaintenance
              ? new Date(el.nextMaintenance).toLocaleDateString("fr-FR")
              : "—",
            color: "text-yellow-600",
          },
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
          { key: "telemetry", label: "Télémétrie en direct", icon: Activity },
          {
            key: "rul",
            label: "Prédictif — durée de vie restante",
            icon: TrendingDown,
          },
          { key: "components", label: "Composants", icon: BarChart3 },
          { key: "history", label: "Bons de travail et alertes", icon: Clock },
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
            title="Aucune télémétrie pour le moment"
            hint="Lancez le simulateur IoT (npm run simulate-iot) pour diffuser les données des capteurs de cet ascenseur."
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-900 dark:text-white">Vibrations du moteur</h3>
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
                <span className="text-yellow-500">— —</span> Avertissement (4,0
                mm/s) &nbsp;
                <span className="text-red-500">— —</span> Critique (7,0 mm/s)
              </p>
            </Card>

            <Card className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-900 dark:text-white">Température du moteur</h3>
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
              <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Charge de la cabine</h3>
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
                  <YAxis
                    tick={{ fontSize: 10 }}
                    stroke="#9ca3af"
                    tickFormatter={(v: number) =>
                      `${(v / 1000).toLocaleString("fr-FR", {
                        maximumFractionDigits: 1,
                      })} t`
                    }
                  />
                  <Tooltip
                    formatter={(v: number) => [
                      `${v.toLocaleString("fr-FR")} kg`,
                      "Charge",
                    ]}
                  />
                  <Area type="monotone" dataKey="load" stroke="#8b5cf6" fill="url(#loadGrad)" strokeWidth={2} dot={false} connectNulls />
                </AreaChart>
              </ResponsiveContainer>
            </Card>

            <Card className="p-6">
              <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Décalage de nivellement</h3>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={telemetry}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="time" tick={{ fontSize: 10 }} stroke="#9ca3af" />
                  <YAxis tick={{ fontSize: 10 }} stroke="#9ca3af" domain={[-15, 15]} />
                  <Tooltip
                    formatter={(v: number) => [
                      `${v.toLocaleString("fr-FR", {
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      })} mm`,
                      "Décalage",
                    ]}
                  />
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
              title="Aucune prédiction pour le moment"
              hint="Cliquez sur « Lancer l'analyse prédictive » pour analyser cet ascenseur avec le moteur de dégradation IA."
            />
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                {(el.predictiveScores.length > 0
                  ? el.predictiveScores.map((s) => ({
                      key: s.id,
                      name:
                        COMPONENT_TYPE_LABELS[s.componentType] ??
                        formatEnum(s.componentType),
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
                      {comp.rul.toLocaleString("fr-FR", {
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      })}
                      %
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      Durée de vie restante
                    </p>
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
                      Risque : {RISK_LABELS[comp.risk] ?? comp.risk}
                    </p>
                  </Card>
                ))}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card className="p-6">
                  <h3 className="font-semibold text-gray-900 dark:text-white mb-4">
                    Radar de santé des composants
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
                      <Radar
                        name="Durée de vie restante (%)"
                        dataKey="health"
                        stroke="#3b82f6"
                        fill="#3b82f6"
                        fillOpacity={0.3}
                      />
                    </RadarChart>
                  </ResponsiveContainer>
                </Card>

                <Card className="p-6">
                  <h3 className="font-semibold text-gray-900 dark:text-white mb-4">
                    Usage et durée de vie attendue
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
                      <YAxis
                        tick={{ fontSize: 10 }}
                        stroke="#9ca3af"
                        tickFormatter={(v: number) =>
                          `${(v / 1000).toLocaleString("fr-FR", {
                            maximumFractionDigits: 0,
                          })} k`
                        }
                      />
                      <Tooltip
                        formatter={(v: number) => [
                          `${(v / 1000).toLocaleString("fr-FR", {
                            minimumFractionDigits: 1,
                            maximumFractionDigits: 1,
                          })} k h`,
                        ]}
                      />
                      <Legend />
                      <Bar
                        dataKey="hours"
                        fill="#3b82f6"
                        name="Heures actuelles"
                        radius={[4, 4, 0, 0]}
                      />
                      <Bar
                        dataKey="maxHours"
                        fill="#e5e7eb"
                        name="Durée de vie attendue"
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </Card>
              </div>

              {el.predictiveScores.length > 0 && (
                <Card className="p-6">
                  <h3 className="font-semibold text-gray-900 dark:text-white mb-4">
                    Recommandations de l&apos;IA
                  </h3>
                  <div className="space-y-3">
                    {el.predictiveScores.map((s) => (
                      <div key={s.id} className="border-l-4 pl-4" style={{ borderColor: RISK_COLORS[s.riskLevel] ?? "#6b7280" }}>
                        <p className="text-sm font-medium text-gray-900 dark:text-white">
                          {COMPONENT_TYPE_LABELS[s.componentType] ??
                            formatEnum(s.componentType)}{" "}
                          — {RISK_LABELS[s.riskLevel] ?? s.riskLevel} (confiance{" "}
                          {(s.confidence * 100).toFixed(0)} %)
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
              Détail des composants
            </h3>
          </div>
          {components.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="Aucun composant suivi"
                hint="Les composants sont créés à l'enregistrement et par le script de peuplement."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-800">
                    {[
                      "Composant",
                      "Type",
                      "Heures actuelles",
                      "Durée de vie attendue",
                      "Durée de vie restante (%)",
                      "Risque",
                    ].map((h) => (
                      <th key={h} className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-6 py-3">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                  {components.map((comp) => (
                    <tr key={comp.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <td className="px-6 py-4 text-sm font-medium text-gray-900 dark:text-white">{comp.name}</td>
                      <td className="px-6 py-4 text-sm text-gray-500">
                        {COMPONENT_TYPE_LABELS[comp.componentType] ??
                          formatEnum(comp.componentType)}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900 dark:text-white">
                        {comp.currentLifeHours.toLocaleString("fr-FR")} h
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-500">
                        {comp.expectedLifeHours?.toLocaleString("fr-FR") ?? "—"} h
                      </td>
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
                          {RISK_LABELS[comp.risk] ?? comp.risk}
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
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4">
              Bons de travail récents
            </h3>
            {el.workOrders.length === 0 ? (
              <EmptyState
                title="Aucun bon de travail"
                hint="Créez-en un depuis le bouton en haut de page."
              />
            ) : (
              <div className="space-y-2">
                {el.workOrders.map((wo) => (
                  <div key={wo.id} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                    <div>
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{wo.title}</p>
                      <p className="text-xs text-gray-500 font-mono">
                        {wo.orderNumber} •{" "}
                        {wo.assignedTo?.name ?? "Non affecté"}
                      </p>
                    </div>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-700">
                      {WORK_ORDER_STATUS_LABELS[wo.status] ??
                        formatEnum(wo.status)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card className="p-6">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4">
              Alertes récentes
            </h3>
            {el.alerts.length === 0 ? (
              <EmptyState
                title="Aucune alerte"
                hint="Les dépassements de seuil issus de la télémétrie apparaîtront ici."
              />
            ) : (
              <div className="space-y-2">
                {el.alerts.map((a) => (
                  <div key={a.id} className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{a.title}</p>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-orange-100 text-orange-700">
                        {ALERT_SEVERITY_LABELS[a.severity] ?? a.severity}
                      </span>
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
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4">
          Caractéristiques techniques
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {[
            { label: "Marque", value: BRAND_LABELS[el.brand] ?? el.brand },
            { label: "Modèle", value: el.model },
            { label: "N° de série", value: el.serialNumber ?? "—" },
            {
              label: "Mise en service",
              value: el.installationDate
                ? new Date(el.installationDate).toLocaleDateString("fr-FR")
                : "—",
            },
            {
              label: "Type de moteur",
              value: MOTOR_TYPE_LABELS[el.motorType] ?? formatEnum(el.motorType),
            },
            { label: "Charge maximale", value: `${el.maxPayloadKg} kg` },
            {
              label: "Commande",
              value:
                CONTROLLER_TYPE_LABELS[el.controllerType] ??
                formatEnum(el.controllerType),
            },
            { label: "Niveaux desservis", value: String(el.floorsServed) },
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
