/**
 * Geofencing for technician check-in.
 *
 * WHY A PER-SITE RADIUS RATHER THAN A CONSTANT
 * A hundred metres is a reasonable guess for an apartment block and wrong for
 * an industrial estate — the maintenance hut can sit four hundred metres from
 * the gate. A fixed constant would either lock a technician out of a site they
 * are standing on, or wave through one parked at the corner café. The radius
 * therefore belongs to the site, is set by the administrator who knows the
 * place, and 100 m is only the fallback for sites nobody has configured.
 *
 * WHAT THIS MODULE IS NOT
 * It is not security. Coordinates come from the device and a determined user
 * can lie about them. What is being prevented is not fraud but *drift*: a
 * technician marking arrival from the van, or from home, out of habit or
 * optimism — and then the customer being told somebody is on site when nobody
 * is. Against that, the distance check is entirely adequate, and it costs the
 * honest technician nothing.
 *
 * A MISSING COORDINATE NEVER BLOCKS
 * Three things can be absent: the site has never been geolocated, the device
 * refuses or cannot get a fix, or the technician is in a basement with no sky.
 * In every one of those cases the check-in is *allowed* and the reason is
 * recorded. Blocking would punish the technician for missing data that is ours
 * to provide — a van parked outside a building we never geocoded would be
 * unable to start work at all — and the first site visit would become a
 * support call. The verification is a guard rail, not a gate.
 */

// ─── Constants ──────────────────────────────────────────────

/** Used when a site has no radius of its own. */
export const DEFAULT_GEOFENCE_RADIUS_M = 100;

/**
 * Bounds accepted from the administrator.
 *
 * The lower bound is not arbitrary: consumer GPS is typically accurate to
 * 5–20 m and far worse in a street of tall buildings, so a radius below 25 m
 * would fail for a technician standing at the right door. The upper bound
 * keeps a mistyped figure — 100000 instead of 1000 — from disabling the check
 * entirely.
 */
export const MIN_GEOFENCE_RADIUS_M = 25;
export const MAX_GEOFENCE_RADIUS_M = 5000;

/** Mean radius of the Earth, used by the haversine formula. */
const EARTH_RADIUS_M = 6_371_000;

// ─── Types ──────────────────────────────────────────────────

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** Why a check-in was accepted or refused, for the log and the response. */
export type GeofenceReason =
  | "ok"
  | "too-far"
  | "no-site-coordinates"
  | "no-technician-coordinates";

export interface GeofenceVerdict {
  allowed: boolean;
  /** Null when it could not be computed. */
  distanceM: number | null;
  /** The radius that was applied, already resolved to a concrete number. */
  radiusM: number;
  reason: GeofenceReason;
}

// ─── Input validation ───────────────────────────────────────

/**
 * Whether a pair of numbers is a usable position.
 *
 * `(0, 0)` is accepted deliberately. It is a real point in the Atlantic, and
 * treating it as "not set" would be the sort of cleverness that silently
 * rejects a legitimate coordinate. An unset position arrives as null.
 */
export function isCoordinates(value: {
  latitude?: number | null;
  longitude?: number | null;
}): value is Coordinates {
  const { latitude, longitude } = value;
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    return false;
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  return (
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
  );
}

/** Reads a coordinate pair off an object, or null when it is not usable. */
export function readCoordinates(
  source: { latitude?: number | null; longitude?: number | null } | null
): Coordinates | null {
  if (!source) return null;
  return isCoordinates(source) ? { latitude: source.latitude, longitude: source.longitude } : null;
}

// ─── Distance ───────────────────────────────────────────────

/**
 * Distance in metres between two positions, on a sphere.
 *
 * Haversine rather than the flat-earth approximation: over a hundred metres
 * the two agree to well under a centimetre, but the radius is configurable up
 * to five kilometres, where the flat formula starts to matter — and there is
 * no reason to reach for the approximation when the correct one is three lines
 * longer.
 */
export function haversineMeters(a: Coordinates, b: Coordinates): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLon = toRadians(b.longitude - a.longitude);

  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ─── Radius ─────────────────────────────────────────────────

/**
 * The radius to apply to a site, as a concrete number.
 *
 * A stored value outside the accepted bounds is treated as absent rather than
 * clamped. Clamping would hide a corrupt row behind plausible behaviour; the
 * fallback at least makes the site look unconfigured, which is true.
 */
export function effectiveRadiusM(configured: number | null | undefined): number {
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_GEOFENCE_RADIUS_M;
  }
  if (
    configured < MIN_GEOFENCE_RADIUS_M ||
    configured > MAX_GEOFENCE_RADIUS_M
  ) {
    return DEFAULT_GEOFENCE_RADIUS_M;
  }
  return Math.round(configured);
}

// ─── The verdict ────────────────────────────────────────────

/**
 * Decides whether a check-in from `technician` is acceptable at `site`.
 *
 * The distance is rounded to the nearest metre before comparison, so a device
 * reporting 100.4 m at a 100 m site is not refused over four decimetres of GPS
 * noise.
 */
export function evaluateGeofence(
  site: Coordinates | null,
  technician: Coordinates | null,
  configuredRadiusM: number | null
): GeofenceVerdict {
  const radiusM = effectiveRadiusM(configuredRadiusM);

  // Our own data is missing. Allow, and say so.
  if (!site) {
    return { allowed: true, distanceM: null, radiusM, reason: "no-site-coordinates" };
  }

  // The device could not place itself. Allow, and say so.
  if (!technician) {
    return {
      allowed: true,
      distanceM: null,
      radiusM,
      reason: "no-technician-coordinates",
    };
  }

  const distanceM = Math.round(haversineMeters(site, technician));

  return {
    allowed: distanceM <= radiusM,
    distanceM,
    radiusM,
    reason: distanceM <= radiusM ? "ok" : "too-far",
  };
}

// ─── Presentation ───────────────────────────────────────────

/**
 * A distance a person can read at a glance: « 40 m », « 1,2 km ».
 *
 * French formatting, comma decimal separator, because this is shown to
 * technicians and administrators in a French interface.
 */
export function formatDistance(distanceM: number | null): string {
  if (distanceM === null) return "distance inconnue";
  if (distanceM < 1000) return `${distanceM} m`;
  return `${(distanceM / 1000).toFixed(1).replace(".", ",")} km`;
}
