"use client";

import { useParams, useRouter } from "next/navigation";
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
  CalendarClock,
  FileText,
  MapPin,
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
import { InfoHint } from "@/components/ui/info-hint";
import { ContractSlaBadge } from "@/components/contracts/contract-sla-badge";
import { contractForBuilding } from "@/lib/contracts/coverage";
import type { CoverageContract } from "@/lib/contracts/coverage";
import { formatEnum } from "@/lib/utils";
import { elevatorStatusStyle } from "@/lib/ui/status-styles";
import { OPS_ROLES } from "@/types";
import { SchedulePanel } from "@/components/maintenance/schedule-panel";

// ─── Types ────────────────────────────────────────────────────

interface ElevatorDetail {
  id: string;
  elevatorCode: string;
  brand: string;
  model: string;
  serialNumber: string | null;
  installationDate: string | null;
  /** Complément d'adresse propre à l'appareil : bâtiment, cage, étage. */
  installationLocation: string | null;
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
  building: {
    id: string;
    name: string;
    address: string;
    city: string;
    /**
     * Code d'accès immeuble / local technique. L'API le renvoie aux rôles
     * internes, et à un technicien seulement s'il a un bon sur cet appareil.
     */
    accessCode?: string | null;
  };
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
  /** Les trois derniers signalements de l'appareil (rôles internes seulement). */
  recentIncidents?: Array<{
    id: string;
    incidentNumber: string;
    status: string;
    notes: string | null;
    createdAt: string;
    resolvedAt: string | null;
    errorCode: { code: string; title: string } | null;
  }>;
}

/** Libellés des statuts d'incident, pour la carte du technicien. */
const INCIDENT_STATUS_LABELS: Record<string, string> = {
  ESCALATED: "En attente d'affectation",
  TECHNICIAN_ASSIGNED: "Affecté",
  IN_PROGRESS: "En cours",
  CLOSED: "Clôturé",
  RESOLVED_BY_CLIENT: "Résolu par le client",
};

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
  const router = useRouter();
  const { data: session } = useSession();
  /**
   * Rôle lu tôt : il pilote un effet (chargement des codes défaut) qui doit
   * rester au-dessus des retours anticipés, sous peine de violer les règles
   * des hooks.
   */
  const userRole = session?.user?.role;
  const [data, setData] = useState<ElevatorDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /**
   * La couverture contractuelle du parc, lue une fois.
   *
   * Elle ne dépend pas de l'appareil : c'est le contrat de son immeuble. La
   * charger dans `load()` la rejouerait à chaque analyse prédictive ou création
   * de bon, pour une donnée qui ne change pas à ce rythme.
   */
  const [coverage, setCoverage] = useState<CoverageContract[]>([]);
  /** Faux tant que la couverture n'a pas été lue : pas de faux « Hors contrat ». */
  const [coverageLoaded, setCoverageLoaded] = useState(false);
  // The tab list is built at render time — one entry is added only for the
  // management roles — so the union is written out rather than inferred from
  // an array that no longer carries every key.
  const [activeTab, setActiveTab] = useState<
    "telemetry" | "rul" | "components" | "history" | "entretien"
  >("telemetry");
  const [runningPrediction, setRunningPrediction] = useState(false);
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [actionMsg, setActionMsg] = useState("");
  /** Catalogue des codes défaut, pour la carte du technicien sur site. */
  const [errorCodes, setErrorCodes] = useState<
    Array<{ id: string; code: string; title: string }>
  >([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/elevators/${id}`);
      // Un technicien sur un appareil qui ne lui est pas affecté : l'API
      // répond 403, on le renvoie vers ses interventions avec un message.
      // Afficher un écran vide ici laisserait croire à une panne de l'app.
      if (res.status === 403) {
        router.replace("/bons-de-travail?acces=refuse");
        return;
      }
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
  }, [id, router]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/contracts/coverage")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (cancelled) return;
        if (!Array.isArray(json?.data)) {
          throw new Error("Réponse de couverture inattendue");
        }
        setCoverage(json.data);
        setCoverageLoaded(true);
      })
      .catch(() => {
        // Sans couverture, la fiche reste complète — seul le badge manque.
        if (!cancelled) {
          setCoverage([]);
          setCoverageLoaded(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Les codes défaut, seulement pour un technicien.
   *
   * C'est le référentiel qu'il consulte devant l'armoire : le charger pour tous
   * les rôles ajouterait une requête à un écran qui n'en a pas besoin. Un échec
   * laisse la liste vide — la carte d'accès reste utile.
   */
  useEffect(() => {
    if (userRole !== "FIELD_TECHNICIAN") return;

    let cancelled = false;

    fetch("/api/error-codes?limit=50")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (!cancelled && Array.isArray(json?.data)) setErrorCodes(json.data);
      })
      .catch(() => {
        if (!cancelled) setErrorCodes([]);
      });

    return () => {
      cancelled = true;
    };
  }, [userRole]);

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
          /**
           * Le lieu exact accompagne le bon dès sa création. Ici, c'est le
           * site qui le fournit : la fiche de l'appareil ne demande pas
           * d'adresse à l'opérateur, elle connaît déjà l'immeuble et le
           * complément d'installation.
           */
          interventionAddress: [
            data.building.address,
            data.building.city,
            data.installationLocation,
          ]
            .filter(Boolean)
            .join(", "),
          type: "INSPECTION",
          priority: data.status === "CRITICAL_SHUTDOWN" ? "EMERGENCY" : "MEDIUM",
          elevatorId: data.id,
        }),
      });
      const json = await res.json();
      if (!res.ok)
        throw new Error(json.error ?? "Échec de la création du bon de travail");
      setActionMsg(`Intervention ${json.data.orderNumber} créée.`);
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
  const contract = contractForBuilding(coverage, el.building.id);
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
              {/*
                Le contrat de l'immeuble, et non l'étiquette SLA du site : le
                palier affiché est celui qui engage réellement l'entreprise.
              */}
              {coverageLoaded ? (
                <ContractSlaBadge
                  contract={contract}
                  size="sm"
                  showReference
                />
              ) : (
                <span className="text-[10px] text-gray-400">
                  couverture indisponible
                </span>
              )}
            </div>
            <p className="text-gray-500 mt-1">
              {BRAND_LABELS[el.brand] ?? el.brand} {el.model} —{" "}
              {el.building.name} ({el.building.address}, {el.building.city})
            </p>
            {el.installationLocation && (
              <p className="mt-1 flex items-start gap-1.5 text-sm text-gray-600 dark:text-gray-300">
                <MapPin className="mt-0.5 h-4 w-4 flex-none text-gray-400" aria-hidden="true" />
                <span>
                  <span className="font-medium">Lieu d&apos;installation :</span>{" "}
                  {el.installationLocation}
                </span>
              </p>
            )}
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

      {/* ─── Terrain : accès, historique récent, référentiel ─────────── */}
      {userRole === "FIELD_TECHNICIAN" && (
        <Card className="border-2 border-blue-200 p-5 dark:border-blue-900">
          <div className="flex items-center gap-2">
            <Wrench className="h-5 w-5 text-blue-600" aria-hidden="true" />
            <h3 className="text-lg font-bold text-gray-900 dark:text-white">
              Intervention sur site
            </h3>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Code d&apos;accès immeuble / local technique
              </p>
              {el.building.accessCode ? (
                <p className="mt-2 font-mono text-2xl font-bold tracking-[0.2em] text-gray-900 dark:text-white">
                  {el.building.accessCode}
                </p>
              ) : (
                <p className="mt-2 text-sm text-gray-500">
                  Non communiqué — aucun bon de travail ne vous est affecté sur
                  cet appareil.
                </p>
              )}
              <a
                href="/qr-appareil/manuel-ascenseur.pdf"
                target="_blank"
                rel="noopener"
                className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:underline"
              >
                <FileText className="h-4 w-4" aria-hidden="true" />
                Notice technique (PDF)
              </a>
            </div>

            <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                3 derniers signalements
              </p>
              {el.recentIncidents && el.recentIncidents.length > 0 ? (
                <ul className="mt-2 space-y-2">
                  {el.recentIncidents.map((incident) => (
                    <li key={incident.id} className="text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs text-gray-600 dark:text-gray-400">
                          {new Date(incident.createdAt).toLocaleDateString("fr-FR")}
                        </span>
                        <span className="text-xs text-gray-500">
                          {INCIDENT_STATUS_LABELS[incident.status] ??
                            incident.status}
                        </span>
                      </div>
                      <p className="text-gray-600 dark:text-gray-400">
                        {incident.errorCode
                          ? ` · ${incident.errorCode.code}`
                          : ""}
                        {incident.notes ? ` — ${incident.notes}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-gray-500">
                  Aucun signalement récent.
                </p>
              )}
            </div>
          </div>

          <details className="mt-4 rounded-xl border border-gray-200 dark:border-gray-800">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-gray-800 dark:text-gray-200">
              Codes défaut ({errorCodes.length})
            </summary>
            <ul className="grid gap-2 border-t border-gray-200 p-4 dark:border-gray-800 sm:grid-cols-2">
              {errorCodes.map((code) => (
                <li key={code.id} className="text-sm">
                  <span className="font-mono font-semibold">{code.code}</span>
                  {" — "}
                  <span className="text-gray-600 dark:text-gray-400">
                    {code.title}
                  </span>
                </li>
              ))}
              {errorCodes.length === 0 && (
                <li className="text-sm text-gray-500">
                  Référentiel indisponible.
                </li>
              )}
            </ul>
          </details>
        </Card>
      )}

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
          // Le programme d'entretien ne se règle que depuis les rôles de
          // gestion, et `/api/maintenance-schedules` le refuse aux autres :
          // offrir l'onglet à un technicien ou à un propriétaire n'aurait
          // produit qu'un panneau vide ou un 403.
          ...(canRunPrediction
            ? [
                {
                  key: "entretien",
                  label: "Entretien programmé",
                  icon: CalendarClock,
                },
              ]
            : []),
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
                    <p className="mt-1 flex items-center justify-center gap-1 text-xs text-gray-500">
                      Durée de vie restante
                      <InfoHint term="rul" />
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

      {activeTab === "entretien" && canRunPrediction && (
        <SchedulePanel elevatorId={el.id} canEdit={canRunPrediction} />
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
