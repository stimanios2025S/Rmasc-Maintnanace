/**
 * What state an elevator is in, as read off a map.
 *
 * WHY THIS IS A MODULE AND NOT A TERNARY IN THE COMPONENT
 * Four screens need to answer the same question — the fleet map, the dashboard
 * panel, the technician's map and the site detail panel — and a map is the one
 * place where a disagreement is invisible: two screens showing the same unit in
 * different colours looks like a bug in the data, not in the code. So the rule
 * lives here once, as a pure function, and every surface calls it.
 *
 * THE FOUR LEVELS, AND WHY THEIR ORDER MATTERS
 * A pin on a map can only carry one colour, but a unit can be simultaneously
 * overdue for service, flagged by telemetry and the subject of a customer
 * complaint. The colour therefore reports the *worst* thing true about it, and
 * the full list travels alongside in `reasons` so the detail panel can show
 * everything rather than only the headline.
 *
 * The order is a triage order, not a technical severity order:
 *
 *   PANNE       Someone is affected right now — the cabin is down, or a
 *               customer has told us it is. This is the only level that
 *               describes a person waiting.
 *   MAINTENANCE The unit is telling us it needs repair: its own status has
 *               left OPERATIONAL, or telemetry raised an anomaly.
 *   ENTRETIEN   The contractual periodic visit is late or approaching. Nothing
 *               is broken yet; the obligation is what is unmet.
 *   ALERTE      Work is already in hand or an alarm is unread — a job is open,
 *               or an alarm nobody has acknowledged. Nothing to decide here,
 *               which is exactly why it ranks below the three above.
 *   NORMAL      Nothing outstanding.
 *
 * A delivered service visit is not the same as a repair, and the two are
 * separate levels on purpose: "entretien dépassé de 40 jours" is a contract
 * problem a manager solves with a calendar, whereas "entretien requis" is a
 * machine problem a technician solves with tools. Folding them together would
 * send one or the other to the wrong person.
 *
 * NOTHING HERE IS COMPUTED FROM A CLOCK OTHER THAN THE CALLER'S
 * `now` is a parameter rather than `new Date()` inside the function, so the
 * due-date arithmetic can be tested at a fixed instant instead of only on the
 * day the test happens to run.
 */

import type { AlertSeverity, ElevatorStatus } from "@/types";

// ─── Thresholds ─────────────────────────────────────────────

/**
 * How far ahead a service visit counts as "approaching".
 *
 * Thirty days because the interval that matters is the shortest contractual
 * one in `MaintenanceFrequency` — a monthly visit. A unit on a monthly contract
 * needs to appear on the map the moment its next visit is within the current
 * cycle, or the planner finds out about it after it is already late. For a
 * quarterly or annual contract this simply means more warning, which costs
 * nothing: the label says how many days, so an administrator can tell "dans
 * 28 jours" from "dans 3 jours".
 */
export const MAINTENANCE_DUE_SOON_DAYS = 30;

// ─── Levels ─────────────────────────────────────────────────

/**
 * Declared worst-first. `compareAttention` and every "pick the worst" reduction
 * in the application depend on this order, so it is not alphabetical and must
 * not be sorted.
 */
export const ATTENTION_LEVELS = [
  "PANNE",
  "MAINTENANCE",
  "ENTRETIEN",
  "ALERTE",
  "NORMAL",
] as const;

export type AttentionLevel = (typeof ATTENTION_LEVELS)[number];

/**
 * Rank, lowest number = most urgent. Built from `ATTENTION_LEVELS` rather than
 * written out, so adding a level in the right place cannot leave the ranks
 * describing a different order than the array.
 */
const RANK: Record<AttentionLevel, number> = Object.fromEntries(
  ATTENTION_LEVELS.map((level, index) => [level, index])
) as Record<AttentionLevel, number>;

/** Negative when `a` is the more urgent of the two. */
export function compareAttention(a: AttentionLevel, b: AttentionLevel): number {
  return RANK[a] - RANK[b];
}

/** The more urgent of two levels. */
export function worstAttention(
  a: AttentionLevel,
  b: AttentionLevel
): AttentionLevel {
  return RANK[a] <= RANK[b] ? a : b;
}

// ─── Presentation ───────────────────────────────────────────

/**
 * One place that decides what each level looks like.
 *
 * The hex values are chosen to stay distinguishable *on a map tile*, which is a
 * busier background than a dashboard card: a pale or low-saturation colour
 * disappears into beige streets and green parks. Violet carries ALERTE rather
 * than a fourth shade of orange specifically because four warm hues in a row
 * are not separable at pin size, and because ALERTE is a different kind of
 * thing — administrative rather than technical.
 */
export const ATTENTION_STYLES: Record<
  AttentionLevel,
  {
    label: string;
    /** Marker fill. Also the swatch in every legend. */
    color: string;
    /** True for the one level that animates. See `fleet-map.tsx`. */
    pulse: boolean;
    /** Badge classes for panels, where Tailwind's palette is in use. */
    badge: string;
    description: string;
  }
> = {
  PANNE: {
    label: "Panne",
    color: "#dc2626",
    pulse: true,
    badge: "bg-red-100 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-900",
    description: "Un client a signalé une panne, ou l'unité est à l'arrêt.",
  },
  MAINTENANCE: {
    label: "Maintenance",
    color: "#ea580c",
    pulse: false,
    badge: "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-950 dark:text-orange-300 dark:border-orange-900",
    description: "L'unité signale elle-même qu'elle a besoin d'une réparation.",
  },
  ENTRETIEN: {
    label: "Entretien",
    color: "#ca8a04",
    pulse: false,
    badge: "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-950 dark:text-yellow-300 dark:border-yellow-900",
    description: "La visite d'entretien périodique est dépassée ou imminente.",
  },
  ALERTE: {
    label: "À suivre",
    color: "#7c3aed",
    pulse: false,
    badge: "bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:border-violet-900",
    description: "Un bon de travail est ouvert ou une alarme n'a pas été lue.",
  },
  NORMAL: {
    label: "Normal",
    color: "#16a34a",
    pulse: false,
    badge: "bg-green-100 text-green-800 border-green-200 dark:bg-green-950 dark:text-green-300 dark:border-green-900",
    description: "Rien en attente sur cette unité.",
  },
};

// ─── Input and output ───────────────────────────────────────

/** Everything the verdict is derived from. Assembled by the calling route. */
export interface AttentionInput {
  status: ElevatorStatus;
  /** The next contractual service visit, if one is scheduled. */
  nextMaintenance: Date | null;
  /** Open work orders — OPEN, ASSIGNED, IN_PROGRESS or ON_HOLD. */
  openWorkOrders: number;
  /** Incidents the customer raised that are not closed. */
  openIncidents: number;
  /** Unresolved, unacknowledged alarms. */
  activeAlerts: number;
  /** The most severe of those alarms, or null when there are none. */
  worstAlertSeverity: AlertSeverity | null;
}

/** One thing true about a unit, and how urgent it is. */
export interface AttentionReason {
  level: AttentionLevel;
  /** Read by a human, French, with the figures filled in. */
  label: string;
}

export interface AttentionVerdict {
  /** The most urgent level found, or NORMAL. */
  level: AttentionLevel;
  /** The headline, always present — NORMAL has one too. */
  reason: string;
  /** Every finding, most urgent first. Never empty. */
  reasons: AttentionReason[];
}

// ─── Dates ──────────────────────────────────────────────────

/**
 * Whole days from `now` to `date`. Negative when the date has passed.
 *
 * Counted on calendar days rather than milliseconds so that a visit due
 * tomorrow at 09:00 reads as "dans 1 jour" whether the caller looks at it at
 * 08:00 or at 23:00. A millisecond difference would make the same overdue
 * service read as due today or overdue yesterday depending on the hour.
 */
export function daysUntil(date: Date | null, now: Date): number | null {
  if (!date) return null;
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfDay = (d: Date) =>
    Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / dayMs);
  return startOfDay(date) - startOfDay(now);
}

/** « 12 jours », « 1 jour », « aujourd'hui ». */
export function formatDays(count: number): string {
  if (count === 0) return "aujourd'hui";
  const abs = Math.abs(count);
  return `${abs} ${abs > 1 ? "jours" : "jour"}`;
}

// ─── The verdict ────────────────────────────────────────────

/** Elevator statuses that mean the unit itself is out of service. */
const DOWN_STATUSES: readonly ElevatorStatus[] = [
  "CRITICAL_SHUTDOWN",
  "OFFLINE",
];

/** Elevator statuses that mean the unit is running but reporting a problem. */
const DEGRADED_STATUSES: readonly ElevatorStatus[] = [
  "SERVICE_REQUIRED",
  "ANOMALY_DETECTED",
];

/** Alert severities that describe something already going wrong. */
const ALARMING_SEVERITIES: readonly AlertSeverity[] = ["CRITICAL", "EMERGENCY"];

/**
 * Everything true about an elevator, worst first.
 *
 * Every branch that fires contributes a reason, so the detail panel can list a
 * unit that is simultaneously overdue, degraded and complained about. The
 * caller reads `level` for the pin colour and `reasons` for the panel.
 */
export function evaluateAttention(
  input: AttentionInput,
  now: Date = new Date()
): AttentionVerdict {
  const reasons: AttentionReason[] = [];

  // ── PANNE ───────────────────────────────────────────────
  // A customer reporting a fault outranks the machine's own status. The status
  // column is only as current as the last telemetry message, whereas an
  // incident is a person standing in a lobby saying the lift does not come.
  if (input.openIncidents > 0) {
    reasons.push({
      level: "PANNE",
      label:
        input.openIncidents > 1
          ? `${input.openIncidents} pannes signalées par des clients`
          : "Panne signalée par le client",
    });
  }

  if (input.status === "CRITICAL_SHUTDOWN") {
    reasons.push({ level: "PANNE", label: "Arrêt critique" });
  } else if (input.status === "OFFLINE") {
    reasons.push({ level: "PANNE", label: "Hors ligne — ne répond plus" });
  }

  if (
    input.worstAlertSeverity &&
    ALARMING_SEVERITIES.includes(input.worstAlertSeverity)
  ) {
    reasons.push({
      level: "PANNE",
      label:
        input.worstAlertSeverity === "EMERGENCY"
          ? "Alarme d'urgence non résolue"
          : "Alarme critique non résolue",
    });
  }

  // ── MAINTENANCE ─────────────────────────────────────────
  if (input.status === "SERVICE_REQUIRED") {
    reasons.push({ level: "MAINTENANCE", label: "Entretien requis" });
  } else if (input.status === "ANOMALY_DETECTED") {
    reasons.push({ level: "MAINTENANCE", label: "Anomalie détectée" });
  }

  if (input.worstAlertSeverity === "ANOMALY") {
    reasons.push({ level: "MAINTENANCE", label: "Anomalie de télémétrie" });
  }

  // ── ENTRETIEN ───────────────────────────────────────────
  const due = daysUntil(input.nextMaintenance, now);

  if (due !== null && due < 0) {
    reasons.push({
      level: "ENTRETIEN",
      label: `Entretien dépassé de ${formatDays(due)}`,
    });
  } else if (due !== null && due <= MAINTENANCE_DUE_SOON_DAYS) {
    reasons.push({
      level: "ENTRETIEN",
      label:
        due === 0
          ? "Entretien prévu aujourd'hui"
          : `Entretien dans ${formatDays(due)}`,
    });
  }

  // ── ALERTE ──────────────────────────────────────────────
  if (input.openWorkOrders > 0) {
    reasons.push({
      level: "ALERTE",
      label:
        input.openWorkOrders > 1
          ? `${input.openWorkOrders} bons de travail ouverts`
          : "Bon de travail ouvert",
    });
  }

  if (input.activeAlerts > 0) {
    reasons.push({
      level: "ALERTE",
      label:
        input.activeAlerts > 1
          ? `${input.activeAlerts} alarmes non lues`
          : "Alarme non lue",
    });
  }

  // ── The verdict ─────────────────────────────────────────
  if (reasons.length === 0) {
    return {
      level: "NORMAL",
      reason: "Rien en attente sur cette unité.",
      reasons: [],
    };
  }

  // Sorted in place: `Array.prototype.sort` is stable, so findings of equal
  // urgency keep the order they were pushed in above — customer reports before
  // machine statuses, which is the reading order a person expects.
  reasons.sort((a, b) => compareAttention(a.level, b.level));

  return {
    level: reasons[0].level,
    reason: reasons[0].label,
    reasons,
  };
}

// ─── Aggregation ────────────────────────────────────────────

/** Counts per level, for a legend that shows what is actually on the map. */
export type AttentionCounts = Record<AttentionLevel, number>;

export function emptyAttentionCounts(): AttentionCounts {
  return { PANNE: 0, MAINTENANCE: 0, ENTRETIEN: 0, ALERTE: 0, NORMAL: 0 };
}

export function countAttention(
  levels: readonly AttentionLevel[]
): AttentionCounts {
  const counts = emptyAttentionCounts();
  for (const level of levels) counts[level] += 1;
  return counts;
}
