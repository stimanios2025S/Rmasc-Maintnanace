/**
 * The arithmetic behind a maintenance contract.
 *
 * `MaintenanceSchedule` has been in the schema since the beginning and was read
 * by nothing: the frequency, the due date and the checklist were written by the
 * seed and then forgotten. This module is the missing half — it answers the two
 * questions a planned-visit programme is made of: *what is due?* and *when is it
 * due again?*
 *
 * WHY THE NEXT DATE IS COUNTED FROM THE COMPLETION, NOT FROM THE OLD DUE DATE
 * A monthly visit that runs two months late could be advanced from either
 * endpoint, and the two behave very differently. Counting from the old due date
 * puts the new date in the past by exactly the amount of the delay, so the unit
 * is instantly overdue again and stays overdue for good: the schedule accrues a
 * backlog of visits that were never planned, and the screen fills with phantom
 * arrears. Counting from the day the visit actually happened restates the
 * contract the way it is actually honoured — "one visit a month" means at most
 * a month between two visits — and a late visit simply shifts the cycle.
 *
 * BY_USAGE_CYCLES IS NOT A DATE, AND THIS MODULE DOES NOT PRETEND IT IS
 * A frequency counted in cycles produces no next date, and `nextDueDateAfter`
 * returns null rather than guessing. The stored `nextDueDate` is left where it
 * is and the callers label the programme "à l'usage". Inventing a date here
 * would be the same fault as inventing a distance to a technician whose phone
 * never answered.
 */

import type { MaintenanceFrequency } from "@prisma/client";

type Period =
  | { unit: "days"; amount: number }
  | { unit: "months"; amount: number };

/**
 * What one period of each frequency is worth in calendar time.
 *
 * `null` is the honest answer for `BY_USAGE_CYCLES` and is read by every
 * function below as "no date can be derived" — never as zero.
 */
const PERIODS: Record<MaintenanceFrequency, Period | null> = {
  WEEKLY: { unit: "days", amount: 7 },
  BIWEEKLY: { unit: "days", amount: 14 },
  MONTHLY: { unit: "months", amount: 1 },
  QUARTERLY: { unit: "months", amount: 3 },
  SEMI_ANNUAL: { unit: "months", amount: 6 },
  ANNUAL: { unit: "months", amount: 12 },
  BY_USAGE_CYCLES: null,
};

/**
 * Adds whole months, keeping the day of the month where that day exists.
 *
 * The naive `date.setMonth(date.getMonth() + 1)` is wrong four times a year:
 * 31 January becomes 3 March, because JavaScript rolls the overflow of a
 * non-existent 31 February forward instead of clamping it. A visit scheduled on
 * the 31st would therefore drift into the following month and never come back.
 * Clamping to the last day of the target month keeps "the 31st" meaning "the end
 * of the month" for the months that are shorter.
 */
export function addMonths(from: Date, months: number): Date {
  const result = new Date(from.getTime());
  const day = result.getDate();
  // Move to the 1st before shifting the month: on its own, a 31st would already
  // have rolled over during the `setMonth` below.
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, lastDay));
  return result;
}

/**
 * When the visit after the one completed at `from` falls due.
 *
 * Returns null when the frequency is counted in usage rather than in time — see
 * the note at the top of this file.
 */
export function nextDueDateAfter(
  from: Date,
  frequency: MaintenanceFrequency
): Date | null {
  const period = PERIODS[frequency];
  if (!period) return null;

  if (period.unit === "days") {
    const next = new Date(from.getTime());
    // `setDate` on a local Date crosses month and year boundaries correctly, and
    // daylight-saving shifts do not move a date carried this way.
    next.setDate(next.getDate() + period.amount);
    return next;
  }

  return addMonths(from, period.amount);
}

/** Midnight local time on the day an instant falls in. */
function startOfDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Whole calendar days from `now` to `date`; negative once the date has passed.
 *
 * Calendar days, not a division of elapsed milliseconds: an appointment at 08:00
 * tomorrow is "tomorrow" at 23:00 tonight, whereas the raw difference would call
 * it one hour and read as "today" on the screen.
 */
export function daysUntil(date: Date, now: Date = new Date()): number {
  return Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
}

/** How close to its date a programme has to be before the board calls it soon. */
export const DUE_SOON_DAYS = 30;

/**
 * The verdict the board prints for one schedule.
 *
 * `by-usage` is a state of its own and not a shade of "upcoming": a programme
 * counted in cycles is neither on time nor late, because nothing in the system
 * has counted its cycles. Collapsing it into either of the others would put a
 * claim on the screen that no query supports.
 */
export type ScheduleDue =
  | { kind: "by-usage" }
  | { kind: "overdue"; days: number }
  | { kind: "due-soon"; days: number }
  | { kind: "scheduled"; days: number };

export function dueFor(
  frequency: MaintenanceFrequency,
  nextDueDate: Date,
  now: Date = new Date()
): ScheduleDue {
  if (frequency === "BY_USAGE_CYCLES") return { kind: "by-usage" };

  const days = daysUntil(nextDueDate, now);
  if (days < 0) return { kind: "overdue", days: -days };
  if (days <= DUE_SOON_DAYS) return { kind: "due-soon", days };
  return { kind: "scheduled", days };
}

/** One line of a programme's checklist. */
export type ChecklistItem = { name: string; required: boolean };

/**
 * Reads `MaintenanceSchedule.checklistItems`, which is a `Json` column and
 * therefore arrives as `unknown`.
 *
 * The seed writes `{ name, required }` objects, but the column is unconstrained:
 * a value written by hand through Prisma Studio could be an array of plain
 * strings, or an object, or null. Each of those is answered with what can
 * actually be read from it rather than with a cast — a checklist that silently
 * became empty would send a technician to a lift with no list of what to check,
 * which is worse than a short one.
 */
export function parseChecklistItems(value: unknown): ChecklistItem[] {
  if (!Array.isArray(value)) return [];

  const items: ChecklistItem[] = [];
  for (const raw of value) {
    if (typeof raw === "string") {
      const name = raw.trim();
      if (name) items.push({ name, required: false });
      continue;
    }
    if (raw && typeof raw === "object") {
      const entry = raw as Record<string, unknown>;
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      if (!name) continue;
      items.push({ name, required: entry.required === true });
    }
  }
  return items;
}

/** The same checklist reduced to the labels, which is what a report stores. */
export function checklistNames(value: unknown): string[] {
  return parseChecklistItems(value).map((item) => item.name);
}

/**
 * The checklist written into a planned order's description.
 *
 * Numbered because it is read on a phone, in a shaft, by someone who will not
 * scroll back up to count. The same lines are also carried structurally by
 * `GET /api/technician` so the portal can tick them; this copy exists so that a
 * technician opening the printed order in six months reads what was planned,
 * even if the programme has since been edited.
 */
export function checklistAsText(items: readonly { name: string }[]): string {
  if (items.length === 0) return "";
  return items.map((item, i) => `${i + 1}. ${item.name}`).join("\n");
}

// ─── Dates de formulaire ────────────────────────────────────
//
// Deux écrans saisissent une échéance dans un `<input type="date">` et deux
// routes la relisent. Les helpers vivent ici plutôt qu'en trois exemplaires,
// parce que la seule erreur possible sur ce sujet — le décalage d'un jour —
// n'apparaît qu'à un endroit si l'aller et le retour passent par le même code.

/**
 * La valeur `yyyy-mm-dd` que réclame un `<input type="date">`, dans le fuseau
 * du navigateur.
 *
 * `toISOString().slice(0, 10)` donnerait le jour UTC : à Paris, un 15 octobre
 * à 00 h 30 s'afficherait « 2026-10-14 » dans le champ, et le bureau relirait
 * une date qui n'est pas celle qu'il vient de voir.
 */
export function toDateInput(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Lit un `<input type="date">` comme le jour *local* qu'il affiche, à 9 h.
 *
 * `new Date("2026-10-15")` est interprété comme minuit UTC, ce qui devient le
 * 14 octobre pour tout utilisateur à l'ouest de Greenwich. Construire la date
 * avec ses composants locaux supprime l'ambiguïté, et 9 h est une heure de
 * passage plausible : l'ordre porte une date, pas un créneau.
 *
 * Renvoie `null` sur une valeur qui n'est pas ce format — jamais une date
 * inventée à partir d'une chaîne approximative.
 */
export function fromDateInput(value: string): Date | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!parts) return null;
  const date = new Date(
    Number(parts[1]),
    Number(parts[2]) - 1,
    Number(parts[3]),
    9,
    0,
    0,
    0
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Relit une échéance venue d'une route : soit le `yyyy-mm-dd` d'un formulaire,
 * soit l'instant ISO complet qu'un appelant programmatique envoie.
 */
export function parseDateInput(value: string): Date | null {
  const dayOnly = fromDateInput(value);
  if (dayOnly) return dayOnly;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
