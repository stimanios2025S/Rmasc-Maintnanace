/**
 * Incident progress and validation state.
 *
 * One module owns the mapping from `IncidentStatus` to a visual position, so
 * the client portal, the admin board and the technician queue cannot disagree
 * about how far along a fault is. Every consumer reads from here rather than
 * hard-coding percentages next to a status check.
 *
 * Bilingual by design: the client portal is French (its users are building
 * occupants), the staff screens are English. Stage *keys* are language-neutral
 * and each surface picks its own label set, so neither side has to parse the
 * other's strings.
 */

import type { IncidentStatus } from "@/types";

// ─── Stages ─────────────────────────────────────────────────

export const INCIDENT_STAGE_KEYS = [
  "reported",
  "assigned",
  "in_progress",
  "closed",
] as const;

export type IncidentStageKey = (typeof INCIDENT_STAGE_KEYS)[number];

/**
 * The four checkpoints of the bar, in order.
 *
 * There are four because there are four things that actually happen to a
 * reported fault: it is reported, someone is sent, someone is working, it is
 * finished. A fifth "validated" stage was tempting — the green badge is a
 * distinct outcome — but it is not a *position* in the pipeline: a
 * self-resolved incident reaches the end without passing through the middle,
 * which a five-stop bar would have shown as an empty gap.
 */
export const INCIDENT_STAGES: readonly {
  key: IncidentStageKey;
  percent: number;
}[] = [
  { key: "reported", percent: 25 },
  { key: "assigned", percent: 50 },
  { key: "in_progress", percent: 75 },
  { key: "closed", percent: 100 },
];

const STAGE_LABELS_FR: Record<IncidentStageKey, string> = {
  reported: "Signalé",
  assigned: "Technicien assigné",
  in_progress: "Intervention en cours",
  closed: "Résolu",
};

const STAGE_LABELS_EN: Record<IncidentStageKey, string> = {
  reported: "Reported",
  assigned: "Technician assigned",
  in_progress: "In progress",
  closed: "Resolved",
};

const STATUS_TO_STAGE: Record<IncidentStatus, IncidentStageKey> = {
  ESCALATED: "reported",
  TECHNICIAN_ASSIGNED: "assigned",
  IN_PROGRESS: "in_progress",
  CLOSED: "closed",
  // Reaches the end of the bar without the middle stops, because the customer
  // resolved it. The bar renders it as complete; the badge is what carries
  // the fact that no technician was involved.
  RESOLVED_BY_CLIENT: "closed",
};

// ─── Validation badge ───────────────────────────────────────

/**
 * The admin board's verdict on how a fault was closed.
 *
 * `validated` — the customer worked through the error code's guidance and the
 * fault cleared on its own. Nothing was dispatched and nothing needed to be,
 * which is the outcome the whole self-service portal exists to produce.
 *
 * `escalated` — the customer could not resolve it and asked for help, whether
 * by answering "non résolu" or by pressing the emergency button. Needs a
 * human.
 *
 * `resolved` — a technician attended and closed it.
 *
 * The third state was not in the original specification, which described only
 * the first two. It exists because those two are not exhaustive: a
 * technician-closed incident is neither self-resolved nor outstanding, and
 * rendering it with the red "non validé" badge would mark finished work as an
 * open failure. **Ratified** — all three are retained in the UI and the API.
 */
export type IncidentValidation = "validated" | "escalated" | "resolved";

export function incidentValidation(status: IncidentStatus): IncidentValidation {
  switch (status) {
    case "RESOLVED_BY_CLIENT":
      return "validated";
    case "CLOSED":
      return "resolved";
    default:
      return "escalated";
  }
}

/**
 * The three badges, and what each one asserts.
 *
 *   ok       Résolu par client       the occupant followed the guidance and it cleared
 *   alert    Non Validé / Escaladé   they could not, and asked for help
 *   neutral  Résolu par technicien   we attended and closed it
 *
 * The green label was previously "Opération Validée". It reads "Résolu par
 * client" now because the badge asserts *who* closed the fault, which is the
 * question a dispatcher is actually asking; the older phrasing is kept as the
 * badge's `title` so the change costs nothing for anyone who learned it.
 */
export const INCIDENT_VALIDATION_LABELS: Record<
  IncidentValidation,
  { fr: string; en: string; signal: "ok" | "alert" | "neutral"; title: string }
> = {
  validated: {
    fr: "Résolu par client",
    en: "Resolved by client",
    signal: "ok",
    title: "Opération Validée — the occupant resolved it without a visit",
  },
  escalated: {
    fr: "Non Validé / Escaladé",
    en: "Escalated",
    signal: "alert",
    title: "The occupant could not resolve it and asked for help",
  },
  resolved: {
    fr: "Résolu par technicien",
    en: "Resolved on site",
    signal: "neutral",
    title: "Attended and closed by a technician",
  },
};

// ─── Derived progress ───────────────────────────────────────

export interface IncidentProgress {
  /** 0–100. The value the bar fills to. */
  percent: number;
  /** Which checkpoint is current. */
  stage: IncidentStageKey;
  /** 1-based position of `stage`, for "step 2 of 4" copy. */
  stageNumber: number;
  /** True once no further work is expected. */
  isTerminal: boolean;
  validation: IncidentValidation;
}

export function incidentProgress(status: IncidentStatus): IncidentProgress {
  const stage = STATUS_TO_STAGE[status];
  const index = INCIDENT_STAGE_KEYS.indexOf(stage);

  return {
    percent: INCIDENT_STAGES[index]?.percent ?? 25,
    stage,
    stageNumber: index + 1,
    isTerminal: status === "CLOSED" || status === "RESOLVED_BY_CLIENT",
    validation: incidentValidation(status),
  };
}

/** The four stops to render, each marked reached or not. */
export function incidentStageTrack(status: IncidentStatus) {
  const { stage, isTerminal, validation } = incidentProgress(status);
  const currentIndex = INCIDENT_STAGE_KEYS.indexOf(stage);

  return INCIDENT_STAGES.map((stop, index) => ({
    ...stop,
    fr: STAGE_LABELS_FR[stop.key],
    en: STAGE_LABELS_EN[stop.key],
    isReached: index <= currentIndex,
    isCurrent: index === currentIndex && !isTerminal,
    // On a self-resolved incident the last stop is reached but nothing in the
    // middle was: the bar reads "finished, without us" rather than pretending
    // a technician visited.
    isSkipped: validation === "validated" && index < currentIndex,
  }));
}

// ─── Transition rules ───────────────────────────────────────

/**
 * Which statuses a caller may move an incident to.
 *
 * Encodes two rules the schema cannot express:
 *
 *  - `RESOLVED_BY_CLIENT` is only reachable *from* `ESCALATED`. It is what the
 *    customer submits after following the guidance, and it is meaningless once
 *    a technician has been dispatched — by then the fault is our problem, and
 *    letting a client mark it resolved would close a job out from under the
 *    person doing it.
 *  - `CLOSED` is only reachable once someone has actually been assigned. A
 *    direct escalation-to-closed jump would let a dispatcher close a fault
 *    that nobody ever attended.
 */
const ALLOWED_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  ESCALATED: ["RESOLVED_BY_CLIENT", "TECHNICIAN_ASSIGNED", "CLOSED"],
  TECHNICIAN_ASSIGNED: ["IN_PROGRESS", "CLOSED", "ESCALATED"],
  IN_PROGRESS: ["CLOSED", "TECHNICIAN_ASSIGNED"],
  CLOSED: [],
  RESOLVED_BY_CLIENT: [],
};

export function canTransition(
  from: IncidentStatus,
  to: IncidentStatus
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function allowedTransitions(
  from: IncidentStatus
): readonly IncidentStatus[] {
  return ALLOWED_TRANSITIONS[from];
}
