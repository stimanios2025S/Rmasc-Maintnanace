"use client";

/**
 * The fleet map.
 *
 * WHAT THIS SCREEN IS FOR
 * One question: where in the fleet is something wrong, and what is it. Every
 * other screen answers a version of that for a list of rows; this one answers
 * it for a place, which is the shape the answer actually has when you have to
 * send somebody somewhere.
 *
 * WHAT IS NOT HERE
 * The fetching, the poll and the level filter. All three are shared with the
 * dashboard panel and the technician's card and live in `useFleetMap` /
 * `filterSites`, so the three surfaces cannot drift apart on what "Panne" means
 * or on how stale the picture is allowed to get. What is left in this file is
 * the part that is genuinely this screen's own: a full-height workspace with the
 * map on the left and the detail beside it, and the placement flow, which no
 * other surface offers.
 *
 * PLACING A SITE
 * A site with no coordinates appears in no map, in no count and in no cluster —
 * it is simply absent, which is the one failure mode that leaves no trace on
 * screen. So the sites that cannot be drawn are listed above the map, and each
 * one can be placed by clicking its position. The same control repositions a
 * site that was placed roughly the first time.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  MapPinOff,
  RefreshCw,
  Undo2,
  X,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import { FleetMap } from "@/components/map/fleet-map";
import { AttentionLegend } from "@/components/map/attention-legend";
import { SiteDetailPanel } from "@/components/map/site-detail-panel";
import { Card } from "@/components/ui/card";
import { ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { filterSites, useFleetMap } from "@/lib/map/use-fleet-map";
import { ATTENTION_STYLES } from "@/lib/map/attention";
import type { AttentionFilter, FleetMapSite } from "@/lib/map/types";
import type { Coordinates } from "@/lib/geo/geofence";
import { cn } from "@/lib/utils";

/** What is being placed, and where it currently sits. */
interface PlacementTarget {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
}

export default function CartePage() {
  const { payload, sites, faults, technicians, loading, error, refreshedAt, reload } =
    useFleetMap();

  const [filter, setFilter] = useState<AttentionFilter>("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [placingFor, setPlacingFor] = useState<PlacementTarget | null>(null);
  const [draft, setDraft] = useState<Coordinates | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(
    null
  );

  const visibleSites = useMemo<FleetMapSite[]>(
    () => filterSites(sites, filter),
    [sites, filter]
  );

  /**
   * Taken from the *unfiltered* list, not from `visibleSites`.
   *
   * Under an active filter the pins are levelled to one colour and their badges
   * count only the matching units, which is the right reading for a spread of
   * pins and the wrong one for a single site: the panel is that site's record,
   * and a header repainted to match the filter — or a count of two where there
   * are six units — would be the panel agreeing with a lens rather than with the
   * fleet. The panel always tells the truth about the site; the map tells the
   * truth about the filter.
   */
  const selectedSite = useMemo(
    () => sites.find((s) => s.id === selectedId) ?? null,
    [sites, selectedId]
  );

  // Selecting a site, then filtering it out of view, must not leave the panel
  // describing something that is no longer on the map.
  useEffect(() => {
    if (selectedId && !visibleSites.some((s) => s.id === selectedId)) {
      setSelectedId(null);
    }
  }, [visibleSites, selectedId]);

  const handleMapClick = useCallback(
    (position: Coordinates) => {
      if (!placingFor) return;
      setDraft(position);
      setNotice(null);
    },
    [placingFor]
  );

  const startPlacing = useCallback((target: PlacementTarget) => {
    setPlacingFor(target);
    setDraft(null);
    setNotice(null);
    setSelectedId(null);
  }, []);

  const cancelPlacing = useCallback(() => {
    setPlacingFor(null);
    setDraft(null);
  }, []);

  const savePlacement = useCallback(async () => {
    if (!placingFor || !draft) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/buildings/${placingFor.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latitude: draft.latitude,
          longitude: draft.longitude,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          body?.error ?? `L'enregistrement a échoué (${res.status})`
        );
      }

      setNotice({
        tone: "ok",
        text: `Position enregistrée pour ${placingFor.name}.`,
      });
      setPlacingFor(null);
      setDraft(null);
      await reload({ silent: true });
    } catch (e) {
      setNotice({
        tone: "error",
        text:
          e instanceof Error ? e.message : "Échec de l'enregistrement de la position",
      });
    } finally {
      setSaving(false);
    }
  }, [placingFor, draft, reload]);

  // ── Loading and failure ───────────────────────────────────

  if (loading && !payload) {
    return (
      <div className="space-y-4">
        <LoadingSkeleton rows={2} />
        <div className="h-[520px] animate-pulse rounded-xl bg-gray-100 dark:bg-gray-800" />
      </div>
    );
  }

  if (error && !payload) {
    return <ErrorState message={error} onRetry={() => void reload()} />;
  }

  if (!payload) {
    return (
      <ErrorState message="Aucune donnée de carte" onRetry={() => void reload()} />
    );
  }

  const { totals, unlocated } = payload;
  const needsPlacing = unlocated.filter((s) => s.reason === "no-coordinates");

  return (
    <div className="flex h-full min-h-[600px] flex-col gap-4">
      {/* ── Toolbar ────────────────────────────────────────── */}
      <Card className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <AttentionLegend
            counts={totals.byLevel}
            active={filter}
            onChange={setFilter}
            hideEmpty
          />
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Les nombres comptent les ascenseurs, non les sites.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {totals.sitesLocated} site{totals.sitesLocated > 1 ? "s" : ""} sur{" "}
            {totals.sites} cartographié
            {totals.sitesLocated > 1 ? "s" : ""}
          </span>
          <span className="hidden text-xs text-gray-400 sm:inline">
            {refreshedAt
              ? `actualisé ${formatDistanceToNow(refreshedAt, {
                  addSuffix: true,
                  locale: fr,
                })}`
              : ""}
          </span>
          <button
            type="button"
            onClick={() => void reload({ silent: true })}
            className="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            aria-label="Actualiser la carte"
            title="Actualiser"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </button>
        </div>
      </Card>

      {/* ── Outcome of the last save ───────────────────────── */}
      {notice && (
        <div
          role="status"
          className={cn(
            "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
            notice.tone === "ok"
              ? "border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300"
              : "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          )}
        >
          {notice.tone === "ok" ? (
            <Check className="h-4 w-4 flex-none" />
          ) : (
            <AlertTriangle className="h-4 w-4 flex-none" />
          )}
          <span className="flex-1">{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="rounded p-0.5 hover:bg-black/5"
            aria-label="Masquer le message"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── Sites the map cannot show ──────────────────────── */}
      {needsPlacing.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/30">
          <div className="flex items-start gap-2">
            <MapPinOff className="mt-0.5 h-4 w-4 flex-none text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                {needsPlacing.length} site
                {needsPlacing.length > 1 ? "s" : ""} sans position —{" "}
                {totals.elevatorsUnlocated} ascenseur
                {totals.elevatorsUnlocated > 1 ? "s" : ""} invisible
                {totals.elevatorsUnlocated > 1 ? "s" : ""} sur la carte
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {needsPlacing.map((site) => (
                  <li key={site.id}>
                    <button
                      type="button"
                      onClick={() =>
                        startPlacing({
                          id: site.id,
                          name: site.name,
                          latitude: null,
                          longitude: null,
                        })
                      }
                      className="rounded-full border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 dark:border-amber-800 dark:bg-gray-900 dark:text-amber-200 dark:hover:bg-amber-950"
                    >
                      Placer « {site.name} »
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      )}

      {/* ── Placement mode ─────────────────────────────────── */}
      {placingFor && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm dark:border-blue-900 dark:bg-blue-950/40">
          <span className="font-medium text-blue-900 dark:text-blue-200">
            {draft
              ? `Position choisie : ${draft.latitude.toFixed(5)}, ${draft.longitude.toFixed(5)}`
              : "Cliquez sur la carte à l'emplacement exact du chantier."}
          </span>
          <span className="text-blue-700 dark:text-blue-300">
            {placingFor.name}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={cancelPlacing}
              className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <Undo2 className="h-3.5 w-3.5" />
              Annuler
            </button>
            <button
              type="button"
              onClick={() => void savePlacement()}
              disabled={!draft || saving}
              className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" />
              {saving ? "Enregistrement…" : "Enregistrer la position"}
            </button>
          </div>
        </div>
      )}

      {/* ── Map and detail ─────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <div
          className={cn(
            "relative min-h-[320px] flex-1 overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800 lg:min-h-0",
            placingFor && "ep-map-placing"
          )}
        >
          <FleetMap
            sites={visibleSites}
            faults={faults}
            technicians={technicians}
            selectedId={selectedId}
            onSelect={(id) =>
              setSelectedId((current) => (current === id ? null : id))
            }
            onMapClick={handleMapClick}
            draftPosition={draft}
            showGeofence={selectedId !== null}
            // The map fills the screen here, so there is nothing below it for
            // the wheel to scroll to and swallowing it costs the reader nothing.
            scrollWheelZoom
          />

          {visibleSites.length === 0 && (
            <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center">
              <p className="rounded-lg bg-white/95 px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm dark:bg-gray-900/95 dark:text-gray-200">
                {sites.length === 0
                  ? "Aucun immeuble n'a encore de position. Placez-en un pour commencer."
                  : `Aucun site dans l'état « ${
                      filter === "ALL" ? "Tout" : ATTENTION_STYLES[filter].label
                    } ».`}
              </p>
            </div>
          )}
        </div>

        {selectedSite && (
          <SiteDetailPanel
            site={selectedSite}
            onClose={() => setSelectedId(null)}
            onReposition={() =>
              startPlacing({
                id: selectedSite.id,
                name: selectedSite.name,
                latitude: selectedSite.latitude,
                longitude: selectedSite.longitude,
              })
            }
            className="max-h-[60vh] flex-none lg:max-h-none lg:w-[380px]"
          />
        )}
      </div>
    </div>
  );
}
