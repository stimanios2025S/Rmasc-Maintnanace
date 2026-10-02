/**
 * Maintenance RMASC – Modifier un programme d'entretien
 *
 * PATCH /api/maintenance-schedules/[id]
 *
 * Edits the terms of a contract and switches the programme on or off. There is
 * deliberately no DELETE — see the note at the top of `../route.ts`: removing
 * the row would null out `scheduleId` on every visit it produced, and the link
 * between a visit and the obligation it discharged is the only answer to "has
 * this lift actually been maintained?".
 *
 * THE PERIODICITY AND THE CYCLE COUNT ARE CHECKED TOGETHER, ON THE RESULT
 * A partial update can carry either one alone, so the rule cannot live in the
 * request schema: changing only the frequency while a stale threshold sits in
 * the row is the common case, and it is exactly the one a per-field check would
 * miss. Both values are therefore composed here — the request where it says
 * something, the stored row where it does not — and the *result* is what gets
 * validated. `cyclesRuleViolation` is the same function the creation route
 * calls, so the two cannot drift.
 *
 * CHANGING THE PERIODICITY DOES NOT MOVE THE CURRENT DUE DATE
 * A programme switched from monthly to quarterly keeps the échéance it already
 * carries; the new period applies from the next completed visit onwards. That
 * is stated rather than silently recomputed because the alternative is worse in
 * both directions: recomputing from the last visit would move a date the office
 * may have already agreed with the customer by phone, and recomputing from
 * today would erase a lateness that is real. A caller that wants the date moved
 * sends `nextDueDate`, and the form always shows it.
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import {
  badRequest,
  handleRouteError,
  jsonOk,
  notFound,
  readJson,
} from "@/lib/api/http";
import { requireRole, MANAGEMENT_ROLES } from "@/lib/api/guard";
import {
  UpdateScheduleSchema,
  cyclesRuleViolation,
} from "@/lib/maintenance/validation";
import { parseDateInput } from "@/lib/maintenance/schedule";

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireRole(...MANAGEMENT_ROLES);
    const body = UpdateScheduleSchema.parse(await readJson(request));

    const existing = await prisma.maintenanceSchedule.findFirst({
      where: {
        id: params.id,
        elevator: { isActive: true, building: { isActive: true } },
      },
      select: {
        id: true,
        frequency: true,
        cycleThreshold: true,
      },
    });
    if (!existing) throw notFound(`Programme introuvable : ${params.id}`);

    const frequency = body.frequency ?? existing.frequency;
    const cycleThreshold =
      body.cycleThreshold !== undefined
        ? body.cycleThreshold
        : existing.cycleThreshold;

    const violation = cyclesRuleViolation(frequency, cycleThreshold);
    if (violation) throw badRequest(violation);

    let nextDueDate: Date | undefined;
    if (body.nextDueDate !== undefined) {
      const parsed = parseDateInput(body.nextDueDate);
      if (!parsed) {
        throw badRequest(
          `Date d'échéance illisible : « ${body.nextDueDate} ». ` +
            "Attendu : AAAA-MM-JJ ou un instant ISO."
        );
      }
      nextDueDate = parsed;
    }

    /**
     * Only the fields the caller actually sent are written.
     *
     * An explicit spread of `undefined` would be ignored by Prisma anyway, but
     * building the object field by field keeps `description` honest: it is
     * nullable, so `null` means "clear it" and an absent key means "leave it" —
     * two different intentions that a `??` chain would collapse into one.
     */
    const data = {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined
        ? { description: body.description || null }
        : {}),
      ...(body.frequency !== undefined ? { frequency: body.frequency } : {}),
      ...(body.cycleThreshold !== undefined
        ? { cycleThreshold: body.cycleThreshold }
        : {}),
      ...(nextDueDate !== undefined ? { nextDueDate } : {}),
      ...(body.checklistItems !== undefined
        ? { checklistItems: body.checklistItems }
        : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    };

    const updated = await prisma.maintenanceSchedule.update({
      where: { id: existing.id },
      data,
      select: {
        id: true,
        title: true,
        frequency: true,
        cycleThreshold: true,
        nextDueDate: true,
        isActive: true,
        checklistItems: true,
      },
    });

    return jsonOk({
      id: updated.id,
      title: updated.title,
      frequency: updated.frequency,
      cycleThreshold: updated.cycleThreshold,
      nextDueDate: updated.nextDueDate,
      isActive: updated.isActive,
      checklistCount: Array.isArray(updated.checklistItems)
        ? updated.checklistItems.length
        : 0,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
