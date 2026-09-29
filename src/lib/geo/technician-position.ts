/**
 * Reading the position a technician's phone last reported.
 *
 * WHY THIS IS SHARED AND NOT INLINED IN THE ROUTE THAT NEEDED IT FIRST
 * Two screens ask the same question of the same three columns — the incident
 * board ("how far out is the person on this job") and the fleet map ("where is
 * everybody") — and the interesting part of the answer is not the subtraction.
 * It is deciding when a stored position stops meaning "he is there". A phone
 * that went into a basement twenty minutes ago still has coordinates in the
 * database, and drawing those as a live dot is the map lying with data that is
 * perfectly correct. Written once, the freshness rule cannot be one thing on
 * one screen and another thing on the next.
 *
 * NOTHING HERE WRITES. Reading a last-known position is a query-time
 * calculation, and the three columns are only ever written by the technician's
 * own portal, from the technician's own device — see `POST
 * /api/technician/position`.
 */

import { evaluateGeofence, readCoordinates } from "./geofence";
import type { Coordinates } from "./geofence";

/**
 * How old a reported position may be and still be presented as current.
 *
 * Five minutes. The portal sends every 45 seconds, so a live phone is an order
 * of magnitude inside this; what it catches is the case that matters — a
 * technician who closed the tab, lost signal or went home, whose last
 * coordinates would otherwise keep drawing a confident-looking pin in an
 * office that has since moved to another job.
 */
export const POSITION_FRESHNESS_MS = 5 * 60_000;

export interface TechnicianFix {
  /** The last reported point, or null if the device has never given one. */
  position: Coordinates | null;
  /** When it was reported, or null. */
  recordedAt: Date | null;
  /**
   * How long ago that was, in milliseconds. Null when there is nothing to age —
   * an absent position is not a stale one, and the two read differently on
   * screen: "position inconnue" is a fact about the device, "il y a 20 min" is
   * a fact about the traffic.
   */
  ageMs: number | null;
  /** False when the position is missing, or older than the freshness window. */
  isFresh: boolean;
}

/** The three columns this module reads, as Prisma returns them. */
export interface TechnicianPositionColumns {
  lastLatitude: number | null;
  lastLongitude: number | null;
  lastPositionAt: Date | null;
}

/**
 * Turns the stored columns into something a screen can act on.
 *
 * A pair that fails `readCoordinates` — out of range, hand-edited, half
 * written — is reported as no position at all rather than as a wrong one. The
 * same predicate gates the write, so a pair that passed there passes here.
 */
export function readTechnicianFix(
  source: TechnicianPositionColumns,
  now: Date = new Date()
): TechnicianFix {
  const position = readCoordinates({
    latitude: source.lastLatitude,
    longitude: source.lastLongitude,
  });
  const recordedAt = source.lastPositionAt;

  if (!position || !recordedAt) {
    return { position, recordedAt, ageMs: null, isFresh: false };
  }

  // A clock skewed into the future would make the age negative and read as
  // fresher than fresh. Clamped to zero: the worst it can then claim is "just
  // now", which is a second of optimism rather than a permanent green light.
  const ageMs = Math.max(0, now.getTime() - recordedAt.getTime());

  return {
    position,
    recordedAt,
    ageMs,
    isFresh: ageMs <= POSITION_FRESHNESS_MS,
  };
}

/**
 * What both admin screens put on the screen: a distance, the radius it is
 * measured against, and how much the reading can be trusted.
 *
 * WHY IT GOES THROUGH `evaluateGeofence` RATHER THAN SUBTRACTING ITSELF
 * That function is the rule. It is what the check-in button greys out on, what
 * the technician's own télémètre counts down, and what the server refuses a
 * late arrival with. A board that computed its own haversine would be a fourth
 * opinion on one question, and the day the two disagreed it would be the
 * dispatcher's screen that was wrong.
 */
export interface TechnicianProximity {
  /** Metres to the site, or null when either end is unknown. */
  distanceM: number | null;
  /** The radius that was applied, already resolved to a concrete number. */
  radiusM: number;
  /** True only when there is a distance and it is inside the radius. */
  withinRadius: boolean;
  /** Milliseconds since the device last reported. Null when it never has. */
  ageMs: number | null;
  /** Whether that was inside `POSITION_FRESHNESS_MS`. */
  isFresh: boolean;
}

/**
 * Composes a fix and a site into the reading both screens display.
 *
 * `withinRadius` is deliberately not `verdict.allowed`. `evaluateGeofence`
 * *allows* a check-in when either end is unknown — the right call at a door,
 * because refusing would strand a technician at a site we never mapped — but on
 * a dispatcher's board that same `allowed` would read as "he is on site" for a
 * technician whose phone never answered. So the claim is only made when there
 * is a distance to make it about.
 */
export function technicianProximity(
  fix: TechnicianFix,
  site: Coordinates | null,
  configuredRadiusM: number | null
): TechnicianProximity {
  const verdict = evaluateGeofence(site, fix.position, configuredRadiusM);

  return {
    distanceM: verdict.distanceM,
    radiusM: verdict.radiusM,
    withinRadius: verdict.distanceM !== null && verdict.allowed,
    ageMs: fix.ageMs,
    isFresh: fix.isFresh,
  };
}
