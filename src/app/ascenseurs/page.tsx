"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Search } from "lucide-react";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { TrafficLegend } from "@/components/ui/traffic";
import { contractForBuilding } from "@/lib/contracts/coverage";
import type { CoverageContract } from "@/lib/contracts/coverage";
import { formatEnum } from "@/lib/utils";
import { SectionTabs, PARC_TABS } from "@/components/layout/section-tabs";
import { ElevatorCard } from "@/components/fleet/elevator-card";
import type { ElevatorData } from "@/components/fleet/elevator-card";

// ─── Types ────────────────────────────────────────────────────

interface ElevatorRow {
  id: string;
  elevatorCode: string;
  brand: string;
  model: string;
  status: string;
  overallHealth: number;
  operatingHours: number;
  building: { id: string; name: string; address: string; city: string; accessCode: string | null };
  latestTelemetry: {
    motorTemperatureC: number | null;
    motorVibrationMmS: number | null;
    doorSpeedMs: number | null;
    operatingHours: number | null;
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
  const router = useRouter();
  const [elevators, setElevators] = useState<ElevatorRow[]>([]);
  /**
   * La couverture contractuelle, lue à part.
   *
   * Un badge n'est pas une raison de faire échouer le parc : si la couverture
   * est indisponible, la liste s'affiche sans badge plutôt qu'avec un message
   * d'erreur à la place des appareils.
   */
  const [contracts, setContracts] = useState<CoverageContract[]>([]);
  /**
   * Distingue « aucun contrat » de « couverture non lue ».
   *
   * Sans cet état, une panne de la route afficherait « Hors contrat » sur tout
   * le parc — une affirmation fausse, et plus grave qu'un badge absent.
   */
  const [coverageLoaded, setCoverageLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  /**
   * Le filtre passé par la recherche globale.
   *
   * La palette oriente un résultat « immeuble » vers `/ascenseurs?q=<nom>`.
   * Le paramètre est lu dans `window.location` plutôt que par
   * `useSearchParams` : ce dernier exige une frontière Suspense pour le rendu
   * statique, et cette page n'a aucune raison d'en ajouter une pour préremplir
   * un champ.
   */
  useEffect(() => {
    try {
      const initial = new URLSearchParams(window.location.search).get("q");
      if (initial) setSearch(initial);
    } catch {
      // Pas de paramètre : la liste s'ouvre sans filtre.
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [res, coverageRes] = await Promise.all([
        fetch("/api/elevators"),
        fetch("/api/contracts/coverage").catch(() => null),
      ]);
      if (!res.ok) throw new Error(`L'API des ascenseurs a renvoyé ${res.status}`);
      const json = await res.json();
      setElevators(json.data ?? []);

      const coverage = coverageRes?.ok
        ? await coverageRes.json().catch(() => null)
        : null;
      const rows = Array.isArray(coverage?.data) ? coverage.data : null;
      setContracts(rows ?? []);
      setCoverageLoaded(rows !== null);
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
      <SectionTabs tabs={PARC_TABS} ariaLabel="Parc ascenseurs" />

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

      {/* Le code couleur, expliqué une fois pour tout l'écran. */}
      <TrafficLegend className="rounded-lg border border-gray-200 bg-white px-4 py-2.5 dark:border-gray-800 dark:bg-gray-900" />

      {/* Elevator Cards */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={Activity}
          title={
            elevators.length === 0
              ? "Aucun ascenseur enregistré"
              : "Aucun ascenseur ne correspond à vos filtres"
          }
          description={
            elevators.length === 0
              ? "Le parc se remplit depuis la fiche d'un immeuble ou à la reprise d'un appareil. Une fois l'appareil enregistré, sa télémétrie et ses interventions s'affichent ici."
              : "Effacez la recherche ou choisissez un autre état. Les appareils en service apparaissent en vert, ceux à surveiller en orange, les arrêts critiques en rouge."
          }
          action={
            elevators.length === 0
              ? {
                  label: "Enregistrer un appareil",
                  href: "/administration/ascenseurs",
                }
              : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((el) => {
            const contract = contractForBuilding(contracts, el.building.id);
            const cardStatus: ElevatorData["status"] =
              el.status === "CRITICAL_SHUTDOWN" || el.status === "OFFLINE"
                ? "CRITICAL"
                : el.status === "SERVICE_REQUIRED" ||
                    el.status === "ANOMALY_DETECTED"
                  ? "WARNING"
                  : "OPERATIONAL";

            const openDetails = () => router.push(`/ascenseurs/${el.id}`);
            const openIntervention = () =>
              router.push(`/bons-de-travail?elevatorId=${el.id}`);

            return (
              <ElevatorCard
                key={el.id}
                elevator={{
                  id: el.elevatorCode,
                  buildingName: el.building.name,
                  city: el.building.city,
                  accessCode: el.building.accessCode,
                  brandModel: `${BRAND_LABELS[el.brand] ?? formatEnum(el.brand)} ${el.model}`,
                  underContract: coverageLoaded && contract != null,
                  healthScore: el.overallHealth,
                  status: cardStatus,
                  telemetry: {
                    temperature: el.latestTelemetry?.motorTemperatureC ?? null,
                    speed: el.latestTelemetry?.doorSpeedMs ?? null,
                    /**
                     * Les heures viennent du relevé, pas de la colonne
                     * cumulée de l'appareil : une machine dont la télémétrie
                     * est muette affichait `0 k h`, un chiffre qui ressemble à
                     * une mesure et n'en est pas une.
                     */
                    operatingHours:
                      el.latestTelemetry?.operatingHours != null
                        ? Math.round(el.latestTelemetry.operatingHours / 100) / 10
                        : null,
                  },
                }}
                onViewDetails={openDetails}
                onCreateWorkOrder={openIntervention}
              />
            );
          })}
        </div>
      )}

    </div>
  );
}
