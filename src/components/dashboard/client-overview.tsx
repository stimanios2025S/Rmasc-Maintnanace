"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  CircleX,
  ClipboardList,
  Gauge,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { FleetMapCard } from "@/components/map/fleet-map-card";
import { enumLabel } from "@/lib/ui/enum-labels";

/**
 * Le tableau de bord d'un client — ce qu'il voit de ses propres installations.
 *
 * POURQUOI CE N'EST PAS LE TABLEAU DE BORD DU PERSONNEL, AMOINDRI
 * Le tableau de bord interne est un poste de pilotage : charge de travail,
 * urgences de l'entreprise, télémétrie de l'appareil qui a parlé en dernier. Un
 * client n'y lirait que du bruit, et poser une condition par bloc dans une page
 * écrite pour un autre lecteur est la façon la plus sûre d'y laisser passer un
 * jour un compteur qui ne le concernait pas. Les deux vues partagent la même
 * route — le client garde l'adresse que tout le monde connaît — mais elles sont
 * deux rendus distincts.
 *
 * AUCUN LIEN VERS UN ÉCRAN FERMÉ
 * Le client n'a accès qu'à son tableau de bord et à son espace client. La carte
 * est donc embarquée sans son lien « Ouvrir la carte » (qui mène à `/carte`,
 * désormais hors de sa portée), et la liste des interventions est informative :
 * la fiche d'un bon vit sous `/bons-de-travail`, qu'il ne peut pas atteindre.
 * Un lien qui rebondit est pire qu'une ligne de texte.
 *
 * LA DONNÉE EST DÉJÀ CLOISONNÉE
 * `/api/dashboard` et `/api/map/fleet` appliquent tous deux `buildingScopeFor`
 * au propriétaire : ce composant n'a rien à filtrer, et il ne filtre rien. Ce
 * qu'il n'affiche pas est une décision de présentation ; ce qu'il ne reçoit pas
 * est une décision de sécurité, prise côté serveur.
 */

interface ClientStats {
  totalBuildings: number;
  totalElevators: number;
  operationalCount: number;
  serviceRequiredCount: number;
  anomalyCount: number;
  criticalCount: number;
  offlineCount: number;
  avgHealth: number;
}

interface BuildingHealth {
  id: string;
  name: string;
  elevators: number;
  health: number;
}

interface RecentWorkOrder {
  id: string;
  orderNumber: string;
  title: string;
  type: string;
  status: string;
  elevator: string;
  createdAt: string;
  scheduledDate: string | null;
  completedAt: string | null;
}

interface RecentAlert {
  id: string;
  elevator: string;
  message: string;
  severity: string;
  createdAt: string;
  acknowledged: boolean;
}

interface DashboardPayload {
  stats: ClientStats;
  buildingHealth: BuildingHealth[];
  recentAlerts: RecentAlert[];
  recentWorkOrders?: RecentWorkOrder[];
}

/** La santé d'un immeuble, dite en couleur — même barème que le parc interne. */
function healthTone(health: number): { bar: string; text: string } {
  if (health >= 80)
    return { bar: "bg-green-500", text: "text-green-700 dark:text-green-400" };
  if (health >= 60)
    return { bar: "bg-amber-500", text: "text-amber-700 dark:text-amber-400" };
  return { bar: "bg-red-500", text: "text-red-700 dark:text-red-400" };
}

const SEVERITY_STYLES: Record<string, string> = {
  CRITICAL: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  HIGH: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  MEDIUM: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  LOW: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

/** Les statuts qui veulent dire « c'est terminé », pour la liste des visites. */
const DONE_STATUSES = ["COMPLETED", "CANCELLED"];

export function ClientOverview() {
  const { data: session } = useSession();
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!silent) setLoading(true);
      setError("");
      try {
        const res = await fetch("/api/dashboard");
        if (!res.ok)
          throw new Error(`L'API du tableau de bord a répondu ${res.status}`);
        const json = await res.json();
        setData(json.data);
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : "Échec du chargement de vos installations"
        );
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Slower than the internal board's 30 s: nothing on this screen is a stream,
  // and a customer's browser has no reason to poll as hard as a dispatcher's.
  useEffect(() => {
    const interval = setInterval(() => void load({ silent: true }), 60_000);
    return () => clearInterval(interval);
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-6">
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  if (error || !data) {
    return <ErrorState message={error || "Données indisponibles"} onRetry={load} />;
  }

  const { stats } = data;
  const workOrders = data.recentWorkOrders ?? [];

  const attention = stats.serviceRequiredCount + stats.anomalyCount;
  const stopped = stats.criticalCount + stats.offlineCount;
  const allOperational = stats.totalElevators > 0 && stats.operationalCount === stats.totalElevators;

  const tiles = [
    {
      icon: Gauge,
      label: "Mes appareils",
      value: String(stats.totalElevators),
      hint: `${stats.totalBuildings} immeuble${stats.totalBuildings > 1 ? "s" : ""}`,
      tone: "text-gray-900 dark:text-white",
    },
    {
      icon: CheckCircle2,
      label: "En service",
      value: String(stats.operationalCount),
      hint: allOperational ? "tout fonctionne" : "sans anomalie connue",
      tone: allOperational
        ? "text-green-600 dark:text-green-400"
        : "text-gray-900 dark:text-white",
    },
    {
      icon: AlertTriangle,
      label: "À surveiller",
      value: String(attention),
      hint: "entretien ou anomalie",
      tone:
        attention > 0
          ? "text-amber-600 dark:text-amber-400"
          : "text-gray-900 dark:text-white",
    },
    {
      icon: CircleX,
      label: "À l'arrêt",
      value: String(stopped),
      hint: stopped > 0 ? "nous intervenons" : "aucun appareil arrêté",
      tone:
        stopped > 0 ? "text-red-600 dark:text-red-400" : "text-gray-900 dark:text-white",
    },
  ];

  return (
    <div className="space-y-6">
      {/* ── En-tête + accès au portail ─────────────────────── */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">
              {session?.user?.name
                ? `Bonjour, ${session.user.name}`
                : "Mon installation"}
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              État de vos ascenseurs, santé de vos immeubles et dernières
              interventions.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link
              href="/client"
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
            >
              <Wrench className="h-4 w-4" aria-hidden="true" />
              Signaler une panne
            </Link>
            <Link
              href="/client"
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Mes tickets et factures
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <span className="text-3xl font-bold tabular-nums text-gray-900 dark:text-white">
            {stats.avgHealth}%
          </span>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            santé moyenne de votre parc
          </span>
          <button
            type="button"
            onClick={() => void load({ silent: true })}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Actualiser
          </button>
        </div>
      </Card>

      {/* ── Tuiles d'état ──────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {tiles.map((tile) => (
          <Card key={tile.label} className="p-4">
            <tile.icon className={`h-4 w-4 mb-2 ${tile.tone}`} aria-hidden="true" />
            <p className="text-sm text-gray-500 dark:text-gray-400">{tile.label}</p>
            <p className={`mt-1 text-3xl font-bold tabular-nums ${tile.tone}`}>
              {tile.value}
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {tile.hint}
            </p>
          </Card>
        ))}
      </div>

      {/* ── Où sont les appareils ──────────────────────────── */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
          Emplacement de vos immeubles
        </h3>
        {/*
          `moreHref` est volontairement omis : il pointe vers `/carte`, que le
          rôle client n'atteint plus. Sans lui, le panneau se contente de
          signaler les sites sans coordonnées au lieu d'offrir un lien qui
          rebondirait vers ce même tableau de bord.
        */}
        <FleetMapCard title="Mes immeubles et mes appareils" height={340} defaultOpen />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── Santé par immeuble ───────────────────────────── */}
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            Santé par immeuble
          </h3>

          {data.buildingHealth.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
              Aucun immeuble rattaché à votre compte pour le moment.
            </p>
          ) : (
            <ul className="mt-4 space-y-4">
              {data.buildingHealth.map((building) => {
                const tone = healthTone(building.health);
                return (
                  <li key={building.id}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-medium text-gray-900 dark:text-white">
                        {building.name}
                      </span>
                      <span className={`text-sm font-semibold tabular-nums ${tone.text}`}>
                        {building.health}%
                      </span>
                    </div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                      <div
                        className={`h-full rounded-full ${tone.bar}`}
                        style={{ width: `${Math.max(0, Math.min(100, building.health))}%` }}
                      />
                    </div>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {building.elevators} appareil
                      {building.elevators > 1 ? "s" : ""}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* ── Interventions récentes ───────────────────────── */}
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            Interventions récentes
          </h3>

          {workOrders.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
              Aucune intervention enregistrée sur vos installations.
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {workOrders.map((order) => {
                const done = DONE_STATUSES.includes(order.status);
                return (
                  <li
                    key={order.id}
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
                  >
                    <ClipboardList
                      className="h-3.5 w-3.5 flex-none text-gray-400"
                      aria-hidden="true"
                    />
                    <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                      {order.elevator}
                    </span>
                    <span className="text-sm text-gray-900 dark:text-gray-100">
                      {order.title}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                        done
                          ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300"
                          : "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300"
                      }`}
                    >
                      {enumLabel(order.status)}
                    </span>
                    <span className="ml-auto text-xs text-gray-400">
                      {formatDistanceToNow(
                        new Date(order.completedAt ?? order.createdAt),
                        { locale: fr, addSuffix: true }
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
            Le détail d&apos;une intervention et son rapport vous sont
            transmis par l&apos;équipe. Vos factures se téléchargent depuis
            votre espace client.
          </p>
        </Card>
      </div>

      {/* ── Événements en cours ────────────────────────────── */}
      {data.recentAlerts.length > 0 && (
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            Signaux en cours sur vos appareils
          </h3>
          <ul className="mt-4 space-y-3">
            {data.recentAlerts.map((alert) => (
              <li key={alert.id} className="flex flex-wrap items-baseline gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    SEVERITY_STYLES[alert.severity] ?? SEVERITY_STYLES.LOW
                  }`}
                >
                  {enumLabel(alert.severity)}
                </span>
                <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                  {alert.elevator}
                </span>
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  {alert.message}
                </span>
                <span className="ml-auto text-xs text-gray-400">
                  {formatDistanceToNow(new Date(alert.createdAt), {
                    locale: fr,
                    addSuffix: true,
                  })}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

export default ClientOverview;
