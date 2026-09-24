"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Building2,
  Search,
  ChevronRight,
  Thermometer,
  Clock,
} from "lucide-react";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { formatEnum } from "@/lib/utils";
import { elevatorStatusStyle } from "@/lib/ui/status-styles";

// ─── Types ────────────────────────────────────────────────────

interface ElevatorRow {
  id: string;
  elevatorCode: string;
  brand: string;
  model: string;
  status: string;
  overallHealth: number;
  operatingHours: number;
  building: { id: string; name: string; address: string };
  latestTelemetry: {
    motorTemperatureC: number | null;
    motorVibrationMmS: number | null;
  } | null;
  _count: { workOrders: number; alerts: number };
}

const FILTERS = [
  "ALL",
  "OPERATIONAL",
  "SERVICE_REQUIRED",
  "ANOMALY_DETECTED",
  "CRITICAL_SHUTDOWN",
  "OFFLINE",
];

/**
 * French labels for the enum values this screen renders. The keys remain the
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

/** `plural(1)` -> `""`, `plural(2)` -> `"s"` — French takes the singular at 0. */
function plural(count: number, suffix = "s"): string {
  return count > 1 ? suffix : "";
}

export default function ElevatorsPage() {
  const [elevators, setElevators] = useState<ElevatorRow[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/elevators");
      if (!res.ok) throw new Error(`L'API des ascenseurs a renvoyé ${res.status}`);
      const json = await res.json();
      setElevators(json.data ?? []);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Impossible de charger les ascenseurs"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(
    () =>
      elevators.filter((el) => {
        const matchSearch =
          search === "" ||
          el.elevatorCode.toLowerCase().includes(search.toLowerCase()) ||
          el.building.name.toLowerCase().includes(search.toLowerCase());
        const matchFilter = filter === "ALL" || el.status === filter;
        return matchSearch && matchFilter;
      }),
    [elevators, search, filter]
  );

  const buildingCount = useMemo(
    () => new Set(elevators.map((e) => e.building.id)).size,
    [elevators]
  );

  if (loading) {
    return (
      <div className="space-y-6">
        <LoadingSkeleton rows={5} />
      </div>
    );
  }

  if (error) {
    return <ErrorState message={error} onRetry={load} />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            Parc d&apos;ascenseurs
          </h2>
          <p className="text-gray-500 mt-1">
            {elevators.length} ascenseur{plural(elevators.length)} dans{" "}
            {buildingCount} immeuble{plural(buildingCount)}
          </p>
        </div>
      </div>

      {/* Search & Filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Rechercher par code ou par immeuble…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
                filter === f
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800"
              }`}
            >
              {f === "ALL" ? "Tous" : STATUS_LABELS[f] ?? formatEnum(f)}
            </button>
          ))}
        </div>
      </div>

      {/* Elevator Cards */}
      {filtered.length === 0 ? (
        <EmptyState
          title={
            elevators.length === 0
              ? "Aucun ascenseur enregistré"
              : "Aucun ascenseur ne correspond à vos filtres"
          }
          hint={
            elevators.length === 0
              ? "Enregistrez des ascenseurs via POST /api/elevators, puis lancez le simulateur IoT."
              : "Essayez d'effacer la recherche ou de choisir un autre statut."
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((el) => {
            const statusStyle = elevatorStatusStyle(el.status);
            return (
              <Link
                key={el.id}
                href={`/ascenseurs/${el.id}`}
                className="group bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 hover:shadow-lg hover:border-blue-200 dark:hover:border-blue-800 transition-all"
              >
                {/* Header */}
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="font-mono text-sm font-semibold text-gray-900 dark:text-white">
                      {el.elevatorCode}
                    </h3>
                    <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
                      <Building2 className="w-3 h-3" />
                      {el.building.name}
                    </p>
                  </div>
                  <span
                    className={`px-2 py-1 text-[10px] font-bold rounded-full border ${statusStyle.bg} ${statusStyle.text}`}
                  >
                    <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${statusStyle.dot}`} />
                    {STATUS_LABELS[el.status] ?? formatEnum(el.status)}
                  </span>
                </div>

                {/* Model Info */}
                <p className="text-xs text-gray-500 mb-3">
                  {BRAND_LABELS[el.brand] ?? el.brand} {el.model}
                  {el._count.alerts > 0 && (
                    <span className="ml-2 text-red-500 font-medium">
                      • {el._count.alerts} alerte
                      {plural(el._count.alerts)} ouverte
                      {plural(el._count.alerts)}
                    </span>
                  )}
                </p>

                {/* Health Bar */}
                <div className="mb-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-gray-500">Santé</span>
                    <span className="text-xs font-bold text-gray-900 dark:text-white">
                      {el.overallHealth}%
                    </span>
                  </div>
                  <div className="h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        el.overallHealth > 70
                          ? "bg-green-500"
                          : el.overallHealth > 40
                          ? "bg-yellow-500"
                          : "bg-red-500"
                      }`}
                      style={{ width: `${el.overallHealth}%` }}
                    />
                  </div>
                </div>

                {/* Quick Metrics */}
                <div className="grid grid-cols-3 gap-2">
                  <div className="text-center p-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
                    <Thermometer className="w-3.5 h-3.5 mx-auto text-red-400 mb-1" />
                    <p className="text-xs font-bold text-gray-900 dark:text-white">
                      {el.latestTelemetry?.motorTemperatureC != null
                        ? `${el.latestTelemetry.motorTemperatureC}°C`
                        : "—"}
                    </p>
                  </div>
                  <div className="text-center p-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
                    <Activity className="w-3.5 h-3.5 mx-auto text-blue-400 mb-1" />
                    <p className="text-xs font-bold text-gray-900 dark:text-white">
                      {el.latestTelemetry?.motorVibrationMmS ?? "—"}
                    </p>
                    <p className="text-[9px] text-gray-400">mm/s</p>
                  </div>
                  <div className="text-center p-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
                    <Clock className="w-3.5 h-3.5 mx-auto text-gray-400 mb-1" />
                    <p className="text-xs font-bold text-gray-900 dark:text-white">
                      {(el.operatingHours / 1000).toLocaleString("fr-FR", {
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      })}
                      k
                    </p>
                    <p className="text-[9px] text-gray-400">heures</p>
                  </div>
                </div>

                {/* Footer */}
                <div className="mt-3 flex items-center justify-end text-xs text-blue-600 font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                  Voir le détail <ChevronRight className="w-3 h-3 ml-1" />
                </div>
              </Link>
            );
          })}
        </div>
      )}

    </div>
  );
}
