"use client";

/**
 * The fleet map as an embedded panel.
 *
 * WHY THIS IS A CARD AND NOT THE PAGE WITH A HEIGHT ON IT
 * The full map at `/carte` is a workspace: it fills the screen, the detail sits
 * beside the map, and a site can be placed or repositioned. None of that belongs
 * on a dashboard, where the map is one panel among several and the reader is
 * glancing rather than working. So this is deliberately smaller: it collapses,
 * the detail stacks underneath instead of beside, and placement is not offered
 * at all — it links to the page that has room to do it properly. A control that
 * opens a mode the reader cannot complete in the space available is worse than
 * no control.
 *
 * WHAT IT DOES SHARE
 * The payload, the poll, the level filter and the whole of `FleetMap`,
 * `AttentionLegend` and `SiteDetailPanel`. "Panne" means one thing across every
 * screen that draws a red pin, because there is exactly one definition of it.
 *
 * A COLLAPSED CARD COSTS NOTHING
 * `useFleetMap({ enabled: open })` leaves the hook entirely idle until the panel
 * is opened, so a card nobody expands fires no request and no timer. The
 * trade-off is visible in the header: the count badge appears only once the
 * card has been opened at least once, because until then there is nothing to
 * count. Fetching on mount to decorate a collapsed header would mean every
 * dashboard load pays for a panel the reader never looks at.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronDown, MapPinOff } from "lucide-react";
import { FleetMap } from "./fleet-map";
import { AttentionLegend } from "./attention-legend";
import { SiteDetailPanel } from "./site-detail-panel";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { filterSites, useFleetMap } from "@/lib/map/use-fleet-map";
import { ATTENTION_STYLES } from "@/lib/map/attention";
import type { AttentionFilter } from "@/lib/map/types";
import type { Coordinates } from "@/lib/geo/geofence";
import { cn } from "@/lib/utils";

export interface FleetMapCardProps {
  title?: string;
  /** Canvas height in pixels, once expanded. */
  height?: number;
  defaultOpen?: boolean;
  /**
   * The viewer's own position, drawn as a blue dot.
   *
   * Technicians only. It is also the reason the technician's card draws the
   * check-in radius of the selected site: the two together answer "am I close
   * enough to point my arrival here", which is the question that screen exists
   * to settle.
   */
  selfPosition?: Coordinates | null;
  /** Where "Ouvrir la carte" points. Omitted renders no link. */
  moreHref?: string;
  /**
   * Poll interval, in milliseconds. `0` fetches once and never polls.
   *
   * The technician's card turns this off: a phone on a site with poor signal
   * should not spend the battery re-fetching pins that have not moved.
   */
  intervalMs?: number;
  className?: string;
}

export function FleetMapCard({
  title = "Carte du parc",
  height = 320,
  defaultOpen = true,
  selfPosition = null,
  moreHref,
  intervalMs,
  className,
}: FleetMapCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [filter, setFilter] = useState<AttentionFilter>("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { payload, sites, faults, technicians, loading, error, reload } = useFleetMap({
    enabled: open,
    intervalMs,
  });

  const visibleSites = useMemo(
    () => filterSites(sites, filter),
    [sites, filter]
  );

  /**
   * From the unfiltered list, so the panel describes the site rather than the
   * filter. See the same note in `/carte` — the reasoning is not repeated here
   * because it is one decision, not two.
   */
  const selectedSite = useMemo(
    () => sites.find((s) => s.id === selectedId) ?? null,
    [sites, selectedId]
  );

  const needsPlacing = useMemo(
    () => (payload?.unlocated ?? []).filter((s) => s.reason === "no-coordinates"),
    [payload]
  );

  const attention = payload?.totals.byLevel;

  return (
    <Card className={className}>
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 p-4">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 rounded-md"
        >
          <ChevronDown
            className={cn(
              "h-4 w-4 flex-none text-gray-400 transition-transform",
              open ? "" : "-rotate-90"
            )}
            aria-hidden="true"
          />
          <h3 className="truncate text-sm font-semibold text-gray-900 dark:text-white">
            {title}
          </h3>
          {/* Every level that has anything in it, worst first, so the collapsed
              header already says whether opening it is worth the moment. */}
          {attention && (
            <span className="flex flex-none items-center gap-2">
              {(["PANNE", "MAINTENANCE", "ENTRETIEN"] as const).map((level) =>
                attention[level] > 0 ? (
                  <span
                    key={level}
                    className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 dark:text-gray-300"
                    title={ATTENTION_STYLES[level].description}
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: ATTENTION_STYLES[level].color }}
                      aria-hidden="true"
                    />
                    <span className="tabular-nums">{attention[level]}</span>
                    <span className="sr-only">
                      {ATTENTION_STYLES[level].label}
                    </span>
                  </span>
                ) : null
              )}
            </span>
          )}
        </button>

        {moreHref && (
          <Link
            href={moreHref}
            className="flex flex-none items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 dark:text-blue-400 dark:hover:bg-blue-950"
          >
            Ouvrir la carte
            <ArrowUpRight className="h-3 w-3" />
          </Link>
        )}
      </div>

      {/* ── Body ───────────────────────────────────────────── */}
      {open && (
        <div className="space-y-3 px-4 pb-4">
          {loading && !payload ? (
            <div
              className="animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800"
              style={{ height }}
            />
          ) : error && !payload ? (
            <ErrorState message={error} onRetry={() => void reload()} />
          ) : payload ? (
            <>
              <AttentionLegend
                counts={payload.totals.byLevel}
                active={filter}
                onChange={setFilter}
                hideEmpty
              />

              <div
                className="relative overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800"
                style={{ height }}
              >
                <FleetMap
                  sites={visibleSites}
                  faults={faults}
                  technicians={technicians}
                  selectedId={selectedId}
                  onSelect={(id) =>
                    setSelectedId((current) => (current === id ? null : id))
                  }
                  selfPosition={selfPosition}
                  showGeofence={selectedId !== null}
                  // The wheel belongs to the page here. A map that swallows it
                  // traps the reader halfway down a dashboard they were
                  // scrolling past.
                  scrollWheelZoom={false}
                />

                {visibleSites.length === 0 && (
                  <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center">
                    <p className="rounded-lg bg-white/95 px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm dark:bg-gray-900/95 dark:text-gray-200">
                      {sites.length === 0
                        ? "Aucun immeuble n'a encore de position."
                        : `Aucun site dans l'état « ${
                            filter === "ALL"
                              ? "Tout"
                              : ATTENTION_STYLES[filter].label
                          } ».`}
                    </p>
                  </div>
                )}
              </div>

              {/* Sites the map cannot draw. Stated rather than linked from
                  here: placing a pin needs the full page's placement mode, and
                  a button that cannot finish the job is worse than a sentence
                  naming where to go. */}
              {needsPlacing.length > 0 && (
                <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <MapPinOff className="mt-0.5 h-3 w-3 flex-none" aria-hidden="true" />
                  <span>
                    {needsPlacing.length} site
                    {needsPlacing.length > 1 ? "s" : ""} sans position —{" "}
                    {payload.totals.elevatorsUnlocated} ascenseur
                    {payload.totals.elevatorsUnlocated > 1 ? "s" : ""} absent
                    {payload.totals.elevatorsUnlocated > 1 ? "s" : ""} de la
                    carte
                    {moreHref ? (
                      <>
                        {" "}
                        —{" "}
                        <Link
                          href={moreHref}
                          className="font-medium underline decoration-dotted underline-offset-2"
                        >
                          les placer
                        </Link>
                      </>
                    ) : null}
                  </span>
                </p>
              )}

              {selectedSite && (
                <SiteDetailPanel
                  site={selectedSite}
                  onClose={() => setSelectedId(null)}
                  className="max-h-[360px]"
                />
              )}
            </>
          ) : null}
        </div>
      )}
    </Card>
  );
}

export default FleetMapCard;
