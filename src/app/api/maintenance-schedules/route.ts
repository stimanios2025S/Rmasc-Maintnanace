/**
 * Maintenance RMASC – Le programme d'entretien
 *
 * GET  /api/maintenance-schedules – every planned-visit programme, with the
 *                                   outstanding order already attached to it
 * POST /api/maintenance-schedules – open a new programme on one elevator
 *
 * WHY THE OFFICE AND NOT THE TECHNICIANS
 * This is the planning board: it decides what gets scheduled, when, and by
 * whom. Booking a routine visit is the same kind of act as dispatching a fault
 * — a commitment of company time and a date agreed with a customer — so it is
 * gated to the same two roles as the incident board. A technician reads their
 * own programme through the portal, on the job they were given.
 *
 * THE OUTSTANDING ORDER TRAVELS WITH THE PROGRAMME
 * A programme whose visit has already been planned must not be planned twice.
 * The guard in `/[id]/plan` enforces that on the way in; this endpoint reports
 * it on the way out so the button is not offered in the first place. Both read
 * `OPEN_WORK_ORDER_STATUSES`, so the button and the refusal cannot disagree.
 *
 * Nothing here is "due" in a way a clock can decide alone — see
 * `src/lib/maintenance/schedule.ts` for why a cycle-counted programme is
 * reported as `by-usage` rather than as late.
 *
 * NO DELETE, ONLY DEACTIVATION
 * A programme is not removed, it is switched off (`isActive: false`, through
 * `PATCH /[id]`). Deleting the row would null out `WorkOrder.scheduleId` on
 * every visit it ever produced — the relation is `onDelete: SetNull` — and the
 * orders would survive with no record of which obligation they discharged.
 * That history is the only answer to "has this lift actually been maintained
 * under its contract?", which is the question the whole module exists for.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { badRequest, handleRouteError, jsonOk, readJson } from "@/lib/api/http";
import { requireRole, MANAGEMENT_ROLES } from "@/lib/api/guard";
import { OPEN_WORK_ORDER_STATUSES } from "@/lib/work-orders/service";
import { parseChecklistItems, parseDateInput } from "@/lib/maintenance/schedule";
import {
  CreateScheduleSchema,
  cyclesRuleViolation,
} from "@/lib/maintenance/validation";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoMaintenanceSchedules } from "@/lib/demo/responses";

// Reads the session and the database on every request.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  /**
   * Declared before the `try` so the demo fallback below can still see it. A
   * read filter is not a secret, and a fixture that ignored it would put every
   * programme of the fleet on every machine's sheet — a screen that lies more
   * convincingly than one that fails.
   */
  let elevatorId: string | null = null;

  try {
    await requireRole(...MANAGEMENT_ROLES);

    /**
     * `?elevatorId=` narrows the board to one machine, which is what the
     * elevator sheet asks for. It is a filter and not an authorisation: the
     * role gate above already decides who may read the programme at all, and
     * this only decides how much of it they asked to see.
     */
    elevatorId = request.nextUrl.searchParams.get("elevatorId");

    const schedules = await prisma.maintenanceSchedule.findMany({
      where: {
        // A programme on a decommissioned building is not work; it is a row
        // belonging to a site that no longer exists.
        elevator: { isActive: true, building: { isActive: true } },
        ...(elevatorId ? { elevatorId } : {}),
      },
      orderBy: [{ nextDueDate: "asc" }],
      select: {
        id: true,
        title: true,
        description: true,
        frequency: true,
        cycleThreshold: true,
        checklistItems: true,
        nextDueDate: true,
        lastCompleted: true,
        isActive: true,
        elevator: {
          select: {
            id: true,
            elevatorCode: true,
            building: { select: { id: true, name: true, address: true, city: true } },
          },
        },
      },
    });

    /**
     * The open orders for these programmes, fetched in one query.
     *
     * A per-schedule lookup would be one round trip per row on a board that
     * lists the whole fleet — the exact shape that turns a planning screen into
     * a slow one as a portfolio grows.
     */
    const openOrders =
      schedules.length === 0
        ? []
        : await prisma.workOrder.findMany({
            where: {
              scheduleId: { in: schedules.map((s) => s.id) },
              status: { in: [...OPEN_WORK_ORDER_STATUSES] },
            },
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              orderNumber: true,
              status: true,
              scheduledDate: true,
              assignedTo: { select: { id: true, name: true } },
              scheduleId: true,
            },
          });

    // Newest first, so the map keeps the most recent order when a programme has
    // more than one open — which the plan guard prevents, but a hand-edited
    // database or a future bulk import could still produce.
    const bySchedule = new Map<string, (typeof openOrders)[number]>();
    for (const order of openOrders) {
      if (order.scheduleId && !bySchedule.has(order.scheduleId)) {
        bySchedule.set(order.scheduleId, order);
      }
    }

    return NextResponse.json({
      data: schedules.map((schedule) => {
        const open = bySchedule.get(schedule.id);
        return {
          id: schedule.id,
          title: schedule.title,
          description: schedule.description,
          frequency: schedule.frequency,
          cycleThreshold: schedule.cycleThreshold,
          checklist: parseChecklistItems(schedule.checklistItems),
          nextDueDate: schedule.nextDueDate,
          lastCompleted: schedule.lastCompleted,
          isActive: schedule.isActive,
          elevator: schedule.elevator,
          activeWorkOrder: open
            ? {
                id: open.id,
                orderNumber: open.orderNumber,
                status: open.status,
                scheduledDate: open.scheduledDate,
                assignedTo: open.assignedTo,
              }
            : null,
        };
      }),
    });
  } catch (error) {
    // Development convenience only, and only on a connection failure: with no
    // PostgreSQL running the board renders its fixture instead of a 500. Real
    // data always wins, and a constraint violation still surfaces. See
    // `src/lib/demo/mode.ts`.
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/maintenance-schedules");
      return NextResponse.json({ data: demoMaintenanceSchedules({ elevatorId }) });
    }
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireRole(...MANAGEMENT_ROLES);
    const body = CreateScheduleSchema.parse(await readJson(request));

    const nextDueDate = parseDateInput(body.nextDueDate);
    if (!nextDueDate) {
      throw badRequest(
        `Date d'échéance illisible : « ${body.nextDueDate} ». ` +
          "Attendu : AAAA-MM-JJ ou un instant ISO."
      );
    }

    const violation = cyclesRuleViolation(body.frequency, body.cycleThreshold);
    if (violation) throw badRequest(violation);

    /**
     * The elevator is looked up rather than trusted.
     *
     * A schedule with an invented `elevatorId` would fail on the foreign key
     * anyway, but with a Prisma error the caller cannot read. Fetching first
     * lets the route answer with the one thing that is actually useful — which
     * elevator was not found — and it makes `isActive` part of the decision:
     * opening a maintenance programme on a decommissioned lift is not a typo
     * to be corrected later, it is a programme that would never be planned.
     */
    const elevator = await prisma.elevator.findFirst({
      where: { id: body.elevatorId, isActive: true, building: { isActive: true } },
      select: { id: true, elevatorCode: true },
    });
    if (!elevator) {
      throw badRequest(
        `Ascenseur introuvable ou hors service : ${body.elevatorId}.`
      );
    }

    const schedule = await prisma.maintenanceSchedule.create({
      data: {
        elevatorId: elevator.id,
        title: body.title,
        description: body.description || null,
        frequency: body.frequency,
        // `null` when the frequency is not counted in cycles — the rule above
        // guarantees the two agree in both directions.
        cycleThreshold: body.cycleThreshold,
        checklistItems: body.checklistItems,
        nextDueDate,
      },
      select: { id: true, title: true, frequency: true, nextDueDate: true },
    });

    return jsonOk(
      {
        id: schedule.id,
        title: schedule.title,
        frequency: schedule.frequency,
        nextDueDate: schedule.nextDueDate,
        elevatorCode: elevator.elevatorCode,
        checklistCount: body.checklistItems.length,
      },
      201
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
