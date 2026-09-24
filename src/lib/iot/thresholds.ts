/**
 * Threshold evaluation for telemetry ingestion.
 *
 * Thresholds are read from the `ThresholdRule` table — which the schema, the
 * seed script and the Prisma Studio workflow all expose — instead of being
 * hardcoded in the route handler. Previously the table was written but never
 * read, so editing a rule had no effect and `Alert.thresholdRuleId` was
 * always null, breaking the link between a breach and the rule that fired.
 *
 * Rules are cached briefly to keep the ingestion hot path off the database;
 * a short TTL means an operator's edit takes effect within seconds without a
 * redeploy, which is the point of storing them in the database at all.
 *
 * One metric is the exception: `cabin_load_kg`. Cabin overload is only
 * meaningful relative to the unit's rated capacity, so its bounds are derived
 * per reading by `payloadThresholds` and a `ThresholdRule` row for that metric
 * is ignored. That includes the 4500/5000 kg row the seed used to write: it
 * was inert, and anyone editing it in Prisma Studio — which this module's own
 * documentation invites — would have seen the change silently do nothing.
 * The seed no longer writes it and `DEFAULT_THRESHOLDS` no longer carries it.
 */

import { prisma } from "@/lib/db/prisma";
import type { AlertSeverity } from "@/types";

export interface ThresholdDefinition {
  /** `ThresholdRule.id`, or null for a built-in fallback rule. */
  id: string | null;
  metricName: string;
  title: string;
  unit: string;
  description: string;
  warningMin: number | null;
  warningMax: number | null;
  criticalMin: number | null;
  criticalMax: number | null;
}

/**
 * Baseline rules, used when the table is empty or unreachable so ingestion
 * keeps working rather than failing closed.
 *
 * `cabin_load_kg` is deliberately absent: cabin overload is relative to each
 * unit's rated capacity, so it is derived per reading by `payloadThresholds`
 * rather than read from here. An absolute entry would be unreachable dead
 * data at best — see the note on `payloadThresholds`.
 */
export const DEFAULT_THRESHOLDS: readonly ThresholdDefinition[] = [
  { id: null, metricName: "motor_vibration_mm_s", title: "High Vibration", unit: "mm/s", description: "Motor vibration level", warningMin: null, warningMax: 4.0, criticalMin: null, criticalMax: 7.0 },
  { id: null, metricName: "motor_temperature_c", title: "Motor Temperature", unit: "°C", description: "Motor winding temperature", warningMin: null, warningMax: 85, criticalMin: null, criticalMax: 105 },
  { id: null, metricName: "door_speed_ms", title: "Door Speed", unit: "m/s", description: "Door open/close speed", warningMin: 0.3, warningMax: 1.5, criticalMin: 0.1, criticalMax: 2.0 },
  { id: null, metricName: "leveling_offset_mm", title: "Leveling Offset", unit: "mm", description: "Floor leveling offset", warningMin: -8, warningMax: 8, criticalMin: -15, criticalMax: 15 },
  { id: null, metricName: "supply_voltage_v", title: "Supply Voltage", unit: "V", description: "Supply voltage", warningMin: 360, warningMax: 440, criticalMin: 340, criticalMax: 460 },
  { id: null, metricName: "current_draw_a", title: "Motor Current", unit: "A", description: "Motor current draw", warningMin: null, warningMax: 60, criticalMin: null, criticalMax: 80 },
];

const CACHE_TTL_MS = 30_000;

let cached: { rules: Map<string, ThresholdDefinition>; expiresAt: number } | null =
  null;
let inFlight: Promise<Map<string, ThresholdDefinition>> | null = null;

function toDefinition(row: {
  id: string;
  metricName: string;
  warningMin: number | null;
  warningMax: number | null;
  criticalMin: number | null;
  criticalMax: number | null;
  description: string | null;
}): ThresholdDefinition {
  const fallback = DEFAULT_THRESHOLDS.find(
    (d) => d.metricName === row.metricName
  );
  return {
    id: row.id,
    metricName: row.metricName,
    title: fallback?.title ?? row.metricName,
    unit: fallback?.unit ?? "",
    description: row.description ?? fallback?.description ?? "",
    warningMin: row.warningMin,
    warningMax: row.warningMax,
    criticalMin: row.criticalMin,
    criticalMax: row.criticalMax,
  };
}

/**
 * Returns the active threshold map, refreshing at most once per TTL.
 * Concurrent callers share a single in-flight query.
 */
export async function loadThresholds(): Promise<Map<string, ThresholdDefinition>> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.rules;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    let rules: Map<string, ThresholdDefinition>;
    try {
      const rows = await prisma.thresholdRule.findMany({
        where: { isActive: true },
      });
      rules = new Map(
        rows.length > 0
          ? rows.map((r) => [r.metricName, toDefinition(r)])
          : DEFAULT_THRESHOLDS.map((d) => [d.metricName, d])
      );
    } catch (error) {
      // Never let a threshold lookup failure drop a telemetry reading.
      console.error("[thresholds] falling back to defaults:", error);
      rules = new Map(DEFAULT_THRESHOLDS.map((d) => [d.metricName, d]));
    }
    cached = { rules, expiresAt: Date.now() + CACHE_TTL_MS };
    return rules;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Clears the cache so an operator's edit is picked up immediately. */
export function invalidateThresholdCache(): void {
  cached = null;
}

export interface ThresholdBreach {
  severity: Extract<AlertSeverity, "WARNING" | "CRITICAL">;
  message: string;
  limit: number;
}

/**
 * Evaluates one metric value against its rule.
 *
 * Critical bounds are checked before warning bounds, and maxima before
 * minima, so a value breaching both yields the more severe verdict.
 */
export function evaluateThreshold(
  definition: ThresholdDefinition,
  value: number
): ThresholdBreach | null {
  // Alert messages are shown to operators, so use the human-readable title
  // ("High Vibration") rather than the raw metric key
  // ("motor_vibration_mm_s"). The metric key is still recorded on the Alert
  // row's own `metricName` column.
  const { title, unit } = definition;
  const suffix = unit ? ` ${unit}` : "";

  if (definition.criticalMax !== null && value > definition.criticalMax) {
    return {
      severity: "CRITICAL",
      limit: definition.criticalMax,
      message: `${title} at ${value}${suffix} exceeds critical maximum of ${definition.criticalMax}${suffix}`,
    };
  }
  if (definition.criticalMin !== null && value < definition.criticalMin) {
    return {
      severity: "CRITICAL",
      limit: definition.criticalMin,
      message: `${title} at ${value}${suffix} is below critical minimum of ${definition.criticalMin}${suffix}`,
    };
  }
  if (definition.warningMax !== null && value > definition.warningMax) {
    return {
      severity: "WARNING",
      limit: definition.warningMax,
      message: `${title} at ${value}${suffix} exceeds warning maximum of ${definition.warningMax}${suffix}`,
    };
  }
  if (definition.warningMin !== null && value < definition.warningMin) {
    return {
      severity: "WARNING",
      limit: definition.warningMin,
      message: `${title} at ${value}${suffix} is below warning minimum of ${definition.warningMin}${suffix}`,
    };
  }
  return null;
}

/**
 * Overload bounds derived from the unit's rated capacity.
 *
 * A fixed 4,500 kg cabin threshold is meaningless across a fleet rated
 * between 1,000 and 1,800 kg: every unit would need to be at ~3x nameplate
 * before anything fired, and the "critical" bound of 5,000 kg was in fact
 * unreachable because the ingestion schema rejects anything above 5,000 kg.
 * Overload is inherently relative to the machine, so it is derived from
 * `Elevator.maxPayloadKg`: warning at nameplate, critical at 110%.
 *
 * Because the magnitude is a property of the machine, the resulting rule
 * carries `id: null` and is NOT looked up in `ThresholdRule` — editing a
 * `cabin_load_kg` row has no effect on ingestion. Adjust the overload policy
 * here, or change the unit's `maxPayloadKg`.
 */
export function payloadThresholds(maxPayloadKg: number): ThresholdDefinition {
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    id: null,
    metricName: "cabin_load_kg",
    title: "Cabin Overload",
    unit: "kg",
    description: `Cabin payload relative to ${maxPayloadKg} kg rated capacity`,
    warningMin: null,
    warningMax: round(maxPayloadKg),
    criticalMin: null,
    criticalMax: round(maxPayloadKg * 1.1),
  };
}
