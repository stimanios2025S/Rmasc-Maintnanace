"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Activity,
  ClipboardList,
  HeartPulse,
  Network,
  Radio,
  ShieldAlert,
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
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import { Card } from "@/components/ui/card";
import { ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { FleetMapCard } from "@/components/map/fleet-map-card";
import { ClientOverview } from "@/components/dashboard/client-overview";
import { IncomingFaults } from "@/components/admin/incoming-faults";
import { TRAFFIC_LEVELS } from "@/lib/ui/traffic";
import type { TrafficLevel } from "@/lib/ui/traffic";

// ─── Types ────────────────────────────────────────────────────

interface DashboardStats {
  totalBuildings: number;
  /** Immeubles couverts par un contrat en vigueur, pas seulement existants. */
  buildingsUnderContract: number;
  totalElevators: number;
  operationalCount: number;
  serviceRequiredCount: number;
  anomalyCount: number;
  criticalCount: number;
  offlineCount: number;
  openWorkOrders: number;
  emergencyWorkOrders: number;
  /** Urgences bloquées par une pièce en vérification ou en commande. */
  blockedCriticalParts: number;
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

/**
 * Une grandeur relevée par les capteurs d'un appareil.
 *
 * Le niveau est calculé par le serveur avec les seuils réglés dans
 * `/seuils` — le panneau ne réinvente pas de bornes côté navigateur.
 */
interface SensorReading {
  metricName: string;
  title: string;
  unit: string;
  value: number;
  level: "ok" | "warning" | "critical";
}

interface SensorRow {
  elevatorId: string;
  elevatorCode: string;
  buildingName: string;
  status: string;
  lastUpdated: string;
  readings: SensorReading[];
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

/**
 * Les libellés de mesure, côté panneau.
 *
 * `SensorReading.title` est le titre de l'alerte (« Vibration élevée »),
 * juste dans un message de seuil mais faux comme étiquette de mesure : un
 * relevé normal n'est pas « élevé ». Ces libellés-ci décrivent la grandeur.
 */
const SENSOR_LABELS: Record<string, string> = {
  motor_temperature_c: "Température moteur",
  motor_vibration_mm_s: "Vibration moteur",
  cabin_load_kg: "Charge cabine",
};

/**
 * Le niveau d'un relevé, dans le vocabulaire de la table de couleurs.
 *
 * Le serveur renvoie `ok | warning | critical` ; la table unique parle
 * `ok | warning | danger`. Cette passerelle est la seule traduction, et elle
 * évite qu'un panneau invente un cinquième code couleur.
 */
function readingTrafficLevel(level: SensorReading["level"]): TrafficLevel {
  if (level === "critical") return "danger";
  if (level === "warning") return "warning";
  return "ok";
}

/** Le niveau le plus grave d'une ligne, pour son témoin de synthèse. */
function worstLevel(row: SensorRow): SensorReading["level"] {
  if (row.readings.some((reading) => reading.level === "critical")) {
    return "critical";
  }
  if (row.readings.some((reading) => reading.level === "warning")) {
    return "warning";
  }
  return "ok";
}

/**
 * Le témoin d'une ligne : l'état de l'appareil d'abord, les relevés ensuite.
 *
 * Un ascenseur à l'arrêt doit être rouge même si sa dernière mesure est
 * ancienne ou dans les bornes, et un appareil hors ligne doit être gris plutôt
 * que vert : la mesure ne dit plus rien de lui. Les capteurs ne complètent
 * l'état que lorsqu'il est nominal.
 */
function unitTrafficLevel(row: SensorRow): TrafficLevel {
  if (row.status === "CRITICAL_SHUTDOWN") return "danger";
  if (row.status === "OFFLINE") return "neutral";
  if (row.status === "SERVICE_REQUIRED" || row.status === "ANOMALY_DETECTED") {
    return "warning";
  }
  // Une ligne sans mesure n'est pas « tout va bien » : elle ne dit rien.
  if (row.readings.length === 0) return "neutral";
  return readingTrafficLevel(worstLevel(row));
}

// ─── Dashboard Page ─────────────────────────────────────────

/**
 * Le tableau de bord, en deux rendus selon le rôle.
 *
 * UNE SEULE ADRESSE, DEUX VUES
 * Le client garde `/tableau-de-bord` : c'est l'adresse que tout le monde
 * connaît, et un lien reçu d'un collègue de l'entreprise mène le client à sa
 * propre vue plutôt qu'à un écran vide ou à un refus. Les deux rendus sont des
 * composants distincts, et non une page commune parsemée de conditions — le
 * tableau de bord interne est un poste de pilotage écrit pour un dispatcheur,
 * et y laisser un compteur derrière un `if` mal placé est la façon la plus sûre
 * d'en faire fuiter un jour le contenu vers un client.
 *
 * LE RÔLE N'EST PAS CONNU AU PREMIER RENDU
 * La session se résout côté navigateur, donc il existe une première frame sans
 * rôle. Afficher la vue du personnel pendant celle-ci montrerait à un client
 * les compteurs de l'entreprise, et l'inverse montrerait au bureau la vue d'un
 * client. Cette frame ne dit donc rien plutôt que de dire le contraire.
 */
export default function DashboardPage() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <div className="space-y-6">
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  return session?.user?.role === "BUILDING_OWNER" ? (
    <ClientOverview />
  ) : (
    <StaffDashboard />
  );
}

function StaffDashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [statusBreakdown, setStatusBreakdown] = useState<StatusSlice[]>([]);
  const [buildingHealth, setBuildingHealth] = useState<BuildingHealth[]>([]);
  const [sensorSnapshot, setSensorSnapshot] = useState<SensorRow[]>([]);
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
      setSensorSnapshot(
        Array.isArray(json.data.sensorSnapshot) ? json.data.sensorSnapshot : []
      );
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

  /**
   * Les quatre indicateurs, dans l'ordre où un dispatcheur les lit.
   *
   * Un chiffre, son unité, une ligne de contexte. Les cartes précédentes
   * empilaient liseré, badge et pastille : lisible une fois, bruité quatre
   * fois de suite en haut d'un écran qu'on ouvre dix fois par jour.
   */
  const statCards = [
    {
      key: "fleet",
      label: "Parc global",
      value: String(stats.totalElevators),
      unit: stats.totalElevators > 1 ? "Ascenseurs" : "Ascenseur",
      sub: `${stats.buildingsUnderContract} ${
        stats.buildingsUnderContract > 1 ? "immeubles" : "immeuble"
      } sous contrat`,
      icon: Network,
      tint: "text-blue-600 bg-blue-50 dark:bg-blue-950/40 dark:text-blue-400",
      tone: "text-gray-900 dark:text-white",
      subTone: "text-gray-500 dark:text-gray-400",
      alert: false,
    },
    {
      key: "health",
      label: "Santé du parc",
      value: `${stats.avgHealth} %`,
      unit: "Santé",
      sub: `${stats.operationalCount} / ${stats.totalElevators} appareils opérationnels`,
      icon: HeartPulse,
      tint: "text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-400",
      tone:
        stats.avgHealth >= 80
          ? "text-emerald-600 dark:text-emerald-400"
          : stats.avgHealth >= 50
            ? "text-amber-600 dark:text-amber-400"
            : "text-red-600 dark:text-red-400",
      subTone: "text-gray-500 dark:text-gray-400",
      alert: false,
    },
    {
      key: "workload",
      label: "Charge de travail",
      value: String(stats.openWorkOrders),
      unit: stats.openWorkOrders > 1 ? "Bons ouverts" : "Bon ouvert",
      sub:
        stats.emergencyWorkOrders > 0
          ? `🔴 ${stats.emergencyWorkOrders} ${
              stats.emergencyWorkOrders > 1 ? "urgences" : "urgence"
            } en attente`
          : "Aucune urgence en attente",
      icon: ClipboardList,
      tint: "text-amber-600 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-400",
      tone: "text-gray-900 dark:text-white",
      subTone:
        stats.emergencyWorkOrders > 0
          ? "font-semibold text-red-600 dark:text-red-400"
          : "text-gray-500 dark:text-gray-400",
      alert: stats.emergencyWorkOrders > 0,
    },
    {
      key: "alerts",
      label: "Alertes & arrêts",
      value: String(stats.criticalCount),
      unit: stats.criticalCount > 1 ? "Unités critiques" : "Unité critique",
      sub:
        (stats.criticalCount > 0
          ? `🔴 ${stats.criticalCount} ${
              stats.criticalCount > 1 ? "arrêts bloquants" : "arrêt bloquant"
            }`
          : "Aucun arrêt bloquant") +
        (stats.blockedCriticalParts > 0
          ? ` · ${stats.blockedCriticalParts} bloquée${
              stats.blockedCriticalParts > 1 ? "s" : ""
            } par pièce`
          : ""),
      icon: ShieldAlert,
      tint: "text-red-600 bg-red-50 dark:bg-red-950/40 dark:text-red-400",
      tone:
        stats.criticalCount > 0
          ? "text-red-600 dark:text-red-400"
          : "text-gray-900 dark:text-white",
      subTone: "text-gray-500 dark:text-gray-400",
      alert: stats.criticalCount > 0,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">        {statCards.map((stat) => (
          <Card
            key={stat.key}
            className={`p-5 ${
              stat.alert ? "border-red-200 dark:border-red-900/70" : ""
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  {stat.label}
                </p>
                <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
                  <span
                    className={`text-3xl font-extrabold tabular-nums ${stat.tone}`}
                  >
                    {stat.value}
                  </span>
                  <span className="text-sm font-semibold text-gray-600 dark:text-gray-300">
                    {stat.unit}
                  </span>
                </p>
                <p className={`mt-2 text-xs ${stat.subTone}`}>{stat.sub}</p>
              </div>
              <span
                className={`flex h-10 w-10 flex-none items-center justify-center rounded-xl ${stat.tint}`}
              >
                <stat.icon className="h-5 w-5" aria-hidden="true" />
              </span>
            </div>
          </Card>
        ))}
      </div>

      {/*
        L'alerte de blocage logistique.

        Une urgence rouge avec un technicien affecté et un statut normal ne
        signale rien : elle est bloquée par une pièce que le magasin n'a pas
        encore servie. Sans cette ligne, personne ne sait qu'elle n'avancera
        pas avant une commande fournisseur.
      */}
      {stats.blockedCriticalParts > 0 && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          <ShieldAlert className="h-5 w-5 flex-none" aria-hidden="true" />
          <p className="font-semibold">
            {stats.blockedCriticalParts} intervention
            {stats.blockedCriticalParts > 1 ? "s" : ""} prioritaire
            {stats.blockedCriticalParts > 1 ? "s" : ""} bloquée
            {stats.blockedCriticalParts > 1 ? "s" : ""} par un manque de pièce.
          </p>
          <Link
            href="/administration/pieces"
            className="ml-auto font-bold underline decoration-2 underline-offset-2 hover:text-red-900 dark:hover:text-red-200"
          >
            Ouvrir les pièces à commander
          </Link>
        </div>
      )}

      {/*
        La réception du bureau, entre les compteurs et la carte.

        Les compteurs disent combien ; cette bande dit *quoi*, *pour qui* et
        *où*. C'est l'ordre dans lequel on traite une journée : le volume, puis
        les deux files qui attendent une décision, puis la carte.
      */}
      <IncomingFaults />

      {/*
        The fleet map.

        Placed above the charts rather than after them, because it answers the
        question this page opens with — *where* in the fleet is something wrong
        — and the charts answer the follow-up. A KPI tile saying "4 unités
        critiques" does not tell anyone which four, or which of them are the
        same building; this does, in one glance, from the same payload and the
        same five-level rule as `/carte`.

        Everything it shows is interactive in place: the level chips filter the
        pins, and selecting one lists that site's units underneath. The map is
        collapsed with one click for anyone who wants the page they had before.
      */}
      <FleetMapCard title="Carte du parc" height={360} moreHref="/carte" />

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

        {/*
          Centre de télémétrie & capteurs IoT.

          Remplace la liste « Alertes récentes » : celle-ci doublait l'écran
          `/alertes`, qui reste le registre des alertes levées et acquittées.
          Ce panneau-ci répond à une autre question — « que disent les capteurs
          en ce moment ? » —, appareil par appareil, avec le niveau calculé par
          les seuils réglés dans `/seuils`. Les deux ne se recouvrent plus.
        */}
        <Card className="p-6">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-white">
                <Radio className="h-5 w-5 text-blue-500" aria-hidden="true" />
                Centre de télémétrie &amp; capteurs IoT
              </h3>
              <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
                Capteurs IoT — dernier relevé reçu pour chaque appareil.
              </p>
            </div>
            <Link
              href="/seuils"
              className="inline-flex flex-none items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
            >
              Seuils d&apos;alerte
            </Link>
          </div>

          {sensorSnapshot.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <Activity className="h-8 w-8 text-gray-300 dark:text-gray-600" aria-hidden="true" />
              <p className="text-sm font-medium text-gray-900 dark:text-white">
                Aucun relevé de capteur
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Les appareils équipés remonteront leur état ici dès la première
                mesure reçue.
              </p>
            </div>
          ) : (
            <ul className="space-y-2.5">
              {sensorSnapshot.slice(0, 5).map((row) => {
                const updated = new Date(row.lastUpdated);
                const stale =
                  Date.now() - updated.getTime() > LIVE_WINDOW_MS;
                const style = stale
                  ? TRAFFIC_LEVELS.neutral
                  : TRAFFIC_LEVELS[unitTrafficLevel(row)];

                return (
                  <li
                    key={row.elevatorId}
                    className="rounded-xl border border-gray-200 p-3 dark:border-gray-800"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`h-2 w-2 flex-none rounded-full ${style.dot}`}
                        aria-hidden="true"
                      />
                      <span className="font-mono text-xs font-semibold text-gray-900 dark:text-white">
                        {row.elevatorCode}
                      </span>
                      <span className="truncate text-xs text-gray-500 dark:text-gray-400">
                        {row.buildingName}
                      </span>
                      <span className="ml-auto whitespace-nowrap text-[10px] uppercase tracking-wide text-gray-400">
                        {stale
                          ? `Figé · ${formatDistanceToNow(updated, {
                              locale: fr,
                            })}`
                          : "En direct"}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {row.readings.map((reading) => {
                        const readingStyle =
                          TRAFFIC_LEVELS[readingTrafficLevel(reading.level)];
                        return (
                          <span
                            key={reading.metricName}
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${readingStyle.bg} ${readingStyle.text} ${readingStyle.border}`}
                          >
                            <span
                              className={`h-1.5 w-1.5 flex-none rounded-full ${readingStyle.dot}`}
                              aria-hidden="true"
                            />
                            {SENSOR_LABELS[reading.metricName] ?? reading.title}
                            <span className="font-mono font-semibold">
                              {reading.value.toLocaleString("fr-FR", {
                                maximumFractionDigits: 1,
                              })}
                              {reading.unit ? ` ${reading.unit}` : ""}
                            </span>
                          </span>
                        );
                      })}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="mt-3 text-[11px] text-gray-400 dark:text-gray-500">
            Les règles de déclenchement se règlent dans{" "}
            <Link
              href="/seuils"
              className="underline hover:text-gray-600 dark:hover:text-gray-300"
            >
              Seuils d&apos;alerte
            </Link>
            .
          </p>
        </Card>
      </div>
    </div>
  );
}
