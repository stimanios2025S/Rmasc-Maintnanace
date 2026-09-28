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
import type { ReportedPositionSource } from "@/types";

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
 * One open fault, at the spot it was reported from.
 *
 * WHY THIS IS NOT A PROPERTY OF A SITE
 * A site's pin answers "how is this building doing". A fault pin answers a
 * different question — "where is the thing somebody rang us about" — and the
 * two do not coincide. A technician reporting a fault from a phone at the gate,
 * four hundred metres from the survey point, is telling us something the site
 * pin cannot express; folding it into the site would round it away to the
 * building's own coordinates and the position would be recorded and never
 * used.
 *
 * Only *open* faults appear. A map that keeps drawing last month's resolved
 * jobs becomes a map of history, and the one thing a dispatcher needs from it
 * is what is outstanding right now.
 *
 * `latitude`/`longitude` are non-null because the endpoint filters out rows
 * without them: an incident raised before positions were recorded, or from a
 * building that has never been geolocated, has no point to draw and is left to
 * the site pin's count rather than placed at a guess.
 */
export interface FleetMapFault {
  incidentId: string;
  incidentNumber: string;
  /** `IncidentStatus`. Left as a string so the UI can fall back gracefully. */
  status: string;
  /** True when it came from the emergency button rather than the wizard. */
  isDirectTransfer: boolean;
  latitude: number;
  longitude: number;
  /**
   * How certain the position is — the reporter's own device, or the site's
   * address standing in for it. Null only for a row written before the column
   * existed, which the tooltip says out loud rather than guessing at.
   */
  source: ReportedPositionSource | null;
  reportedAt: string;
  technicianName: string | null;
  elevatorId: string;
  elevatorCode: string;
  /** The site this fault belongs to, so a click can open its detail panel. */
  buildingId: string;
  buildingName: string;
  /**
   * How wide the intervention zone is around this point, in metres.
   *
   * The site's own check-in radius, reused rather than given a column of its
   * own. A dispatcher drawing the boundary of an intervention and a technician
   * deciding how close is close enough are answering the same question about
   * the same building, and two numbers to keep in step would drift apart the
   * first time either one was changed.
   */
  interventionRadiusM: number;
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
  /**
   * Open faults, drawn where they were reported from.
   *
   * A separate list rather than a field on each site, because a fault is not a
   * property of a building: it belongs to an elevator, it is reported from a
   * place that may not be the building's address, and it disappears from the
   * map when it closes without the site changing at all.
   */
  faults: FleetMapFault[];
  totals: FleetMapTotals;
  /** When the payload was assembled, so the panel can say how fresh it is. */
  generatedAt: string;
}
