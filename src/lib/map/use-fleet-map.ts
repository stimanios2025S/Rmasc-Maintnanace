"use client";

/**
 * Loads the fleet map payload, on a timer.
 *
 * WHY THIS IS A HOOK AND NOT WRITTEN OUT THREE TIMES
 * The full map page, the dashboard panel and the technician's card all show the
 * same payload from the same endpoint and all need the same four things: the
 * data, a loading flag, an error string and a way to ask again. Written out
 * three times, the copies drift — one gains a retry, another a different
 * interval, and the third keeps polling after the component is gone. The
 * *presentation* is what genuinely differs between the three, and that is the
 * part left to each caller.
 *
 * WHY THE EFFECT KEY IS `enabled` AND NOT THE PAYLOAD
 * A naive version re-fetches whenever the payload changes, which is exactly
 * what a poll does — so the poll would schedule itself again on every response
 * and the interval would collapse into a request loop. `loadedRef` answers the
 * one question the effect actually has (is this the first load, or a refresh?)
 * without becoming a dependency.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AttentionFilter,
  FleetMapFault,
  FleetMapPayload,
  FleetMapSite,
  FleetMapTechnician,
} from "./types";

/** A minute. A map is read rather than watched; see the callers' comments. */
const DEFAULT_INTERVAL_MS = 60_000;

export interface UseFleetMapOptions {
  /**
   * How often to refresh, in milliseconds. `0` fetches once and never polls.
   *
   * Worth turning off on a screen a technician uses over a poor connection,
   * where a periodic request costs battery and bandwidth to re-fetch pins that
   * have not moved.
   */
  intervalMs?: number;
  /**
   * Whether to fetch at all.
   *
   * False leaves the hook completely idle — no request, no timer — which is what
   * a collapsed panel wants. Flipping it to true loads, and later flips are
   * refreshes rather than first loads, so an open panel never blinks back to a
   * skeleton.
   */
  enabled?: boolean;
}

export interface UseFleetMapResult {
  payload: FleetMapPayload | null;
  /** `payload.sites`, with a stable identity — empty rather than null. */
  sites: FleetMapSite[];
  /**
   * `payload.faults`, same treatment. Deliberately *not* filtered by the
   * attention filter the way `sites` is: the filter narrows which buildings'
   * health you are looking at, and a fault is not a level — hiding the open
   * faults on the units you just filtered out would be the map withholding the
   * most urgent thing it knows.
   */
  faults: FleetMapFault[];
  /**
   * `payload.technicians`, same treatment.
   *
   * Empty for every role that is not staff — the endpoint never puts the list
   * in the payload for a building owner — so a consumer can pass this straight
   * through without knowing who is looking.
   */
  technicians: FleetMapTechnician[];
  loading: boolean;
  error: string;
  refreshedAt: Date | null;
  reload: (options?: { silent?: boolean }) => Promise<void>;
}

export function useFleetMap({
  intervalMs = DEFAULT_INTERVAL_MS,
  enabled = true,
}: UseFleetMapOptions = {}): UseFleetMapResult {
  const [payload, setPayload] = useState<FleetMapPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  /** False until the first load has been fired, so a re-enable is a refresh. */
  const loadedRef = useRef(false);

  const reload = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/map/fleet");
      if (!res.ok) throw new Error(`L'API de la carte a répondu ${res.status}`);
      const json = await res.json();
      setPayload(json.data as FleetMapPayload);
      setRefreshedAt(new Date());
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Échec du chargement de la carte"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    void reload({ silent: loadedRef.current });
    loadedRef.current = true;

    if (intervalMs <= 0) return;
    const id = setInterval(() => void reload({ silent: true }), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, reload]);

  /** Memoised so the `[]` fallback is not a fresh reference on every render. */
  const sites = useMemo(() => payload?.sites ?? [], [payload]);
  const faults = useMemo(() => payload?.faults ?? [], [payload]);
  const technicians = useMemo(() => payload?.technicians ?? [], [payload]);

  return { payload, sites, faults, technicians, loading, error, refreshedAt, reload };
}

/**
 * Narrows the map to one attention level.
 *
 * Under a filter every visible pin takes that level's colour and counts the
 * units in that state at its site, rather than each pin keeping its own worst
 * level. The reason is legibility: a site can be both overdue and broken, so a
 * pin filtered to "Entretien" that still came out red — because red outranks
 * yellow — would look like the filter had failed. Uniform colour under an
 * active filter says one unambiguous thing: everything on screen is what you
 * asked for.
 *
 * The site objects are spreads and the elevator arrays are shared by reference.
 * Nothing downstream mutates them — the detail panel sorts a copy — so this
 * avoids rebuilding a fleet's worth of rows on every render.
 */
export function filterSites(
  sites: FleetMapSite[],
  filter: AttentionFilter
): FleetMapSite[] {
  if (filter === "ALL") return sites;

  const filtered: FleetMapSite[] = [];
  for (const site of sites) {
    const matching = site.elevators.filter((e) => e.level === filter);
    if (matching.length === 0) continue;
    filtered.push({ ...site, level: filter, needsAttention: matching.length });
  }
  return filtered;
}
