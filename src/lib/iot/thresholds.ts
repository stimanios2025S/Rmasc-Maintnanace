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
import {
  OVERLOAD_POLICY,
  TELEMETRY_METRICS,
} from "./metric-catalogue";

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
 * The values come from `./metric-catalogue`, which carries the same figures the
 * screen displays as "valeur par défaut". Two literals here and one screen
 * elsewhere is how a fallback ends up disagreeing with what the interface
 * promises — the operator would tune a threshold, see it applied, and never
 * learn that an unreachable database silently substitutes something else.
 *
 * `cabin_load_kg` is deliberately absent: cabin overload is relative to each
 * unit's rated capacity, so it is derived per reading by `payloadThresholds`
 * rather than read from here. An absolute entry would be unreachable dead
 * data at best — see the note on `payloadThresholds`.
 */
export const DEFAULT_THRESHOLDS: readonly ThresholdDefinition[] =
  TELEMETRY_METRICS.map((metric) => ({
    id: null,
    metricName: metric.metricName,
    title: metric.title,
    unit: metric.unit,
    description: metric.description,
    ...metric.defaults,
  }));

const CACHE_TTL_MS = 30_000;

let cached: { rules: Map<string, ThresholdDefinition>; expiresAt: number } | null =
  null;
let inFlight: Promise<Map<string, ThresholdDefinition>> | null = null;

/** Les colonnes d'une `ThresholdRule` que ce module lit réellement. */
interface ThresholdRuleRow {
  id: string;
  metricName: string;
  warningMin: number | null;
  warningMax: number | null;
  criticalMin: number | null;
  criticalMax: number | null;
  description: string | null;
}

function toDefinition(row: ThresholdRuleRow): ThresholdDefinition {
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
 * The union of the built-in defaults and whatever the table overrides.
 *
 * THE DEFAULTS ARE A FLOOR PER METRIC, NOT A FALLBACK FOR THE WHOLE TABLE
 * This used to read `rows.length > 0 ? rows : defaults`, and that single
 * ternary was a silent outage waiting for its first configuration. The moment
 * *one* rule was written — an operator tuning the vibration threshold, via
 * Prisma Studio or an API call — the map stopped carrying the other five
 * metrics, the ingestion loop hit `if (!definition) continue`, and temperature,
 * door speed, levelling, voltage and current simply stopped raising alerts.
 * Nothing failed, nothing logged: five monitored quantities went quiet because
 * a sixth had been configured.
 *
 * Merging makes the ordinary reading true — a metric without a row uses its
 * default — and it gives "restore the default" a meaning that cannot be
 * mistaken for "stop monitoring this": deleting a row puts the metric back on
 * the built-in values instead of removing its coverage.
 *
 * `isActive: false` therefore means the same thing as deleting: the override
 * steps aside and the default applies. There is deliberately no way to silence
 * a metric from here; that would need bounds that never fire, and a mechanism
 * whose purpose is to make alerting stop deserves to be built on purpose.
 */
function mergeWithDefaults(
  rows: readonly ThresholdRuleRow[]
): Map<string, ThresholdDefinition> {
  const merged = new Map<string, ThresholdDefinition>(
    DEFAULT_THRESHOLDS.map((definition) => [definition.metricName, definition])
  );
  for (const row of rows) {
    merged.set(row.metricName, toDefinition(row));
  }
  return merged;
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
      rules = mergeWithDefaults(rows);
    } catch (error) {
      // Never let a threshold lookup failure drop a telemetry reading.
      console.error("[thresholds] falling back to defaults:", error);
      rules = mergeWithDefaults([]);
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
  // ("Vibration élevée") rather than the raw metric key
  // ("motor_vibration_mm_s"). The metric key is still recorded on the Alert
  // row's own `metricName` column.
  //
  // These strings are persisted on the Alert row when the breach is recorded,
  // so translating them changes what future alerts store. Alerts written before
  // the change keep their original wording.
  const { title, unit } = definition;
  const suffix = unit ? ` ${unit}` : "";

  if (definition.criticalMax !== null && value > definition.criticalMax) {
    return {
      severity: "CRITICAL",
      limit: definition.criticalMax,
      message: `${title} : ${value}${suffix} dépasse le maximum critique de ${definition.criticalMax}${suffix}`,
    };
  }
  if (definition.criticalMin !== null && value < definition.criticalMin) {
    return {
      severity: "CRITICAL",
      limit: definition.criticalMin,
      message: `${title} : ${value}${suffix} est en dessous du minimum critique de ${definition.criticalMin}${suffix}`,
    };
  }
  if (definition.warningMax !== null && value > definition.warningMax) {
    return {
      severity: "WARNING",
      limit: definition.warningMax,
      message: `${title} : ${value}${suffix} dépasse le maximum d'avertissement de ${definition.warningMax}${suffix}`,
    };
  }
  if (definition.warningMin !== null && value < definition.warningMin) {
    return {
      severity: "WARNING",
      limit: definition.warningMin,
      message: `${title} : ${value}${suffix} est en dessous du minimum d'avertissement de ${definition.warningMin}${suffix}`,
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
    title: "Surcharge de la cabine",
    unit: "kg",
    description: `Charge de la cabine par rapport à la capacité nominale de ${maxPayloadKg} kg`,
    warningMin: null,
    warningMax: round(maxPayloadKg * OVERLOAD_POLICY.warningRatio),
    criticalMin: null,
    criticalMax: round(maxPayloadKg * OVERLOAD_POLICY.criticalRatio),
  };
}
