/**
 * Maintenance RMASC – Planifier une visite d'entretien
 *
 * POST /api/maintenance-schedules/[id]/plan
 *
 * Turns one due programme into a work order the board can schedule and hand to
 * a technician. This is the join that `WorkOrder.scheduleId` was added for and
 * that nothing has ever written: a planned visit is the only kind of order that
 * knows *which* contractual obligation it discharges, and without that link the
 * programme can never be advanced when the visit is done.
 *
 * THE OFFICE DECIDES, ONE PROGRAMME AT A TIME
 * Nothing is generated in bulk and nothing is generated on a timer. The date is
 * the one agreed with the customer on the phone, and an order created without
 * one is precisely the undated `OPEN` row that already accumulates on the work
 * order board. So the caller supplies the date, and it is required: a button
 * that produced an order without a date would be a button that produces exactly
 * the mess this screen exists to clear.
 *
 * ONE OUTSTANDING ORDER PER PROGRAMME
 * A programme whose visit is already planned and not yet done reports an error
 * naming the order, rather than creating a second one. Two identical visits on
 * the board are worse than one: the office plans the first, the second
 * resurfaces weeks later as an overdue job nobody raised. `GET
 * /api/maintenance-schedules` reports the same outstanding order so the button
 * is not offered, but the check lives here too — a dialog holds its state from
 * when it opened, and a request can be made by hand.
 *
 * Like the analogous guard on `POST /api/preventive-visits`, this is a read
 * followed by a write rather than a constraint, so two requests in the same
 * instant could both pass. The database cannot express "at most one open order
 * per programme" as a unique index. The consequence is a visible duplicate the
 * office can cancel, which is the cheapest of the available failures.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  badRequest,
  conflict,
  handleRouteError,
  jsonOk,
  notFound,
  readJson,
} from "@/lib/api/http";
import { assignableUserWhere, requireRole, MANAGEMENT_ROLES } from "@/lib/api/guard";
import { createWorkOrderWithUniqueNumber, OPEN_WORK_ORDER_STATUSES } from "@/lib/work-orders/service";
import { notifyTechnicianOfWorkOrderInBackground } from "@/lib/notifications/assignment";
import { checklistAsText, parseChecklistItems } from "@/lib/maintenance/schedule";

const PlanVisitSchema = z
  .object({
    /**
     * The day the visit is booked for, as an ISO string.
     *
     * Required, and deliberately not defaulted to "now": the whole point of the
     * screen is that a human agreed a date with a customer.
     */
    scheduledDate: z.string().min(1),
    /** Optional — a visit can be planned before it is handed to anyone. */
    assignedToId: z.string().min(1).optional(),
  })
  .strict();

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireRole(...MANAGEMENT_ROLES);
    const body = PlanVisitSchema.parse(await readJson(request));

    const scheduledDate = new Date(body.scheduledDate);
    if (Number.isNaN(scheduledDate.getTime())) {
      throw badRequest(
        `Date de planification illisible : « ${body.scheduledDate} ». ` +
          "Attendu : une date au format ISO."
      );
    }

    const schedule = await prisma.maintenanceSchedule.findFirst({
      where: {
        id: params.id,
        elevator: { isActive: true, building: { isActive: true } },
      },
      select: {
        id: true,
        title: true,
        description: true,
        isActive: true,
        checklistItems: true,
        elevatorId: true,
        elevator: { select: { elevatorCode: true } },
      },
    });
    if (!schedule) throw notFound(`Programme introuvable : ${params.id}`);

    if (!schedule.isActive) {
      throw conflict(
        `Le programme « ${schedule.title} » est désactivé : aucun bon ne peut en être tiré. ` +
          "Réactivez-le d'abord si l'entretien doit reprendre."
      );
    }

    const outstanding = await prisma.workOrder.findFirst({
      where: {
        scheduleId: schedule.id,
        status: { in: [...OPEN_WORK_ORDER_STATUSES] },
      },
      select: { orderNumber: true },
    });
    if (outstanding) {
      throw conflict(
        `Une visite est déjà planifiée pour ${schedule.elevator.elevatorCode} ` +
          `(bon ${outstanding.orderNumber}). Il doit être terminé ou annulé avant d'en planifier une autre.`
      );
    }

    /**
     * An assignment is checked against the same predicate the dispatch board
     * uses, so a visit cannot be booked onto someone on leave — the write-side
     * rule, not a UI convenience. See `assignableUserWhere`.
     */
    if (body.assignedToId) {
      const assignee = await prisma.user.findFirst({
        where: assignableUserWhere(body.assignedToId),
        select: { id: true, name: true },
      });
      if (!assignee) {
        throw badRequest(
          `Technicien non affectable : ${body.assignedToId}. ` +
            "Le compte doit être actif, de rôle technique, et disponible."
        );
      }
    }

    const checklist = parseChecklistItems(schedule.checklistItems);

    const workOrder = await createWorkOrderWithUniqueNumber(
      {
        title: `${schedule.title} – ${schedule.elevator.elevatorCode}`,
        description: buildDescription(schedule, checklist),
        type: "PREVENTIVE",
        // A routine visit is not an emergency. Priority is what the technician's
        // portal sorts by, and a planned visit must never outrank a lift with
        // someone trapped in it.
        priority: "MEDIUM",
        // ASSIGNED only when a technician was named; otherwise OPEN, for the
        // office to place later. `ASSIGNED` without an assignee is refused by
        // PATCH /api/work-orders, so the two states cannot disagree.
        status: body.assignedToId ? "ASSIGNED" : "OPEN",
        scheduledDate,
        elevatorId: schedule.elevatorId,
        // The link the whole module rests on: it is what advances the programme
        // when this order is completed.
        scheduleId: schedule.id,
        assignedToId: body.assignedToId ?? null,
        createdById: session.user.id,
      },
      "ENT"
    );

    // After the commit, and never fatal — the order is real either way. See the
    // rule at the top of `src/lib/notifications/service.ts`.
    if (body.assignedToId) {
      notifyTechnicianOfWorkOrderInBackground(workOrder.id);
    }

    return jsonOk(
      {
        id: workOrder.id,
        orderNumber: workOrder.orderNumber,
        elevatorCode: schedule.elevator.elevatorCode,
        scheduledDate: workOrder.scheduledDate,
      },
      201
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * What the technician reads on the order.
 *
 * The programme's own description first — it says what the visit is for — then
 * the numbered points, so the order is self-contained when printed. The same
 * lines travel structurally through `GET /api/technician` so the portal can
 * tick them one by one; this is the copy that survives on the record if the
 * programme is later edited or deactivated.
 */
function buildDescription(
  schedule: {
    title: string;
    description: string | null;
  },
  checklist: readonly { name: string }[]
): string {
  const lines = [`Visite d'entretien programmée – ${schedule.title}.`];

  if (schedule.description) {
    lines.push("", schedule.description);
  }

  const points = checklistAsText(checklist);
  if (points) {
    lines.push("", "Points de contrôle :", points);
  }

  return lines.join("\n");
}
