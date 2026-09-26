/**
 * The payload `GET /api/map/fleet` returns, shared by the route that builds it
 * and the components that draw it.
 *
 * WHY THE SHAPE IS DECLARED ONCE, IN NEITHER PLACE
 * The map is drawn by four surfaces — the fleet page, the dashboard panel, the
 * technician's map and the site detail panel — and one of them silently
 * disagreeing with the endpoint is the kind of break that only shows up as an
 * empty popup in production. Declaring it here means a field the route stops
 * sending is a compile error at every consumer.
 *
 * It is free of Prisma imports on purpose: the browser bundle imports this
 * file. Dates are `string` rather than `Date` for the same reason — a `Date`
 * that has been through `JSON.stringify` is a string, and typing it as a `Date`
 * is a lie the compiler cannot catch.
 */

import type { AttentionCounts, AttentionLevel } from "./attention";

/** One elevator as it appears inside a site. */
export interface FleetMapElevator {
  id: string;
  elevatorCode: string;
  brand: string;
  model: string;
  floorsServed: number;
  /** `ElevatorStatus`. Left as a string so the UI can fall back gracefully. */
  status: string;
  overallHealth: number;
  nextMaintenance: string | null;
  lastMaintenance: string | null;
  /** The worst level found — what colours the row in the detail panel. */
  level: AttentionLevel;
  /** The headline for that level, already in French. */
  reason: string;
  /** Everything true about this unit, most urgent first. */
  reasons: { level: AttentionLevel; label: string }[];
}

/**
 * One site, with its position resolved.
 *
 * A site appears here only when it has coordinates. `latitude` and `longitude`
 * are therefore non-null, unlike on the `Building` row — an unlocated site has
 * no pin to draw and is reported separately in `unlocated` instead.
 */
export interface FleetMapSite {
  id: string;
  name: string;
  address: string;
  city: string;
  slaTier: string;
  contactPerson: string;
  contactPhone: string | null;
  latitude: number;
  longitude: number;
  /** The configured check-in radius, or the fleet default. Never null. */
  geofenceRadiusM: number;
  /** The worst of this site's elevators. Drives the pin colour. */
  level: AttentionLevel;
  /** Active, non-retired units at this site. */
  elevatorCount: number;
  /** How many of them are not NORMAL. Shown as a badge on the pin. */
  needsAttention: number;
  elevators: FleetMapElevator[];
}

/**
 * A site the map cannot speak about, listed so it can be fixed rather than
 * forgotten.
 *
 * Two different situations, and they need different words on screen. A site
 * with no coordinates is a mapping job; a site with coordinates but no
 * elevators is either a mis-typed record or a portfolio that has never been
 * surveyed. Folding them into one list with one explanation would tell an
 * administrator to go and place a pin that is already placed.
 */
export interface UnlocatedSite {
  id: string;
  name: string;
  address: string;
  city: string;
  elevatorCount: number;
  reason: "no-coordinates" | "no-elevators";
}

/**
 * What the map is currently showing: one level, or everything.
 *
 * Declared here rather than beside the legend that renders it, because it is
 * not a property of that control — it is the argument `filterSites` takes, and
 * three different surfaces pass it.
 */
export type AttentionFilter = AttentionLevel | "ALL";

export interface FleetMapTotals {
  sites: number;
  sitesLocated: number;
  sitesUnlocated: number;
  elevators: number;
  /** Elevators at sites with no coordinates — visible in no map, in no count. */
  elevatorsUnlocated: number;
  byLevel: AttentionCounts;
}

export interface FleetMapPayload {
  sites: FleetMapSite[];
  unlocated: UnlocatedSite[];
  totals: FleetMapTotals;
  /** When the payload was assembled, so the panel can say how fresh it is. */
  generatedAt: string;
}
