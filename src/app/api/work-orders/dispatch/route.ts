/**
 * ElevatorPulse – Technician Dispatch API
 *
 * POST /api/work-orders/dispatch – Assign a work order to an idle technician
 * GET  /api/work-orders/dispatch – List technicians and their current load
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  badRequest,
  conflict,
  handleRouteError,
  notFound,
  readJson,
} from "@/lib/api/http";
import {
  assignableUserWhere,
  MANAGEMENT_ROLES,
  requireRole,
} from "@/lib/api/guard";
import {
  isOpenStatus,
  OPEN_WORK_ORDER_STATUSES,
} from "@/lib/work-orders/service";
import { DISPATCHABLE_TECHNICIAN_STATUSES } from "@/types";

type Tx = Prisma.TransactionClient;

const DispatchSchema = z
  .object({
    workOrderId: z.string().min(1),
    /** Optional pinned technician; falls back to auto-selection. */
    technicianId: z.string().min(1).optional(),
  })
  .strict();

/** Statuses that mean a technician is already occupied. */
const ACTIVE_ASSIGNMENT_STATUSES = ["ASSIGNED", "IN_PROGRESS"] as const;

const DISPATCH_INCLUDE = {
  assignedTo: { select: { id: true, name: true, email: true, phone: true } },
  elevator: {
    select: {
      elevatorCode: true,
      building: { select: { name: true, address: true } },
    },
  },
} as const;

// ─── POST: dispatch ─────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    await requireRole(...MANAGEMENT_ROLES);
    const { workOrderId, technicianId } = DispatchSchema.parse(
      await readJson(request)
    );

    const workOrder = await prisma.workOrder.findUnique({
      where: { id: workOrderId },
      include: {
        elevator: { include: { building: { select: { name: true } } } },
      },
    });
    if (!workOrder) throw notFound(`Work order not found: ${workOrderId}`);

    if (!isOpenStatus(workOrder.status)) {
      throw conflict(
        `Work order ${workOrder.orderNumber} is ${workOrder.status} and cannot be dispatched`
      );
    }

    /**
     * Selecting a technician and writing the assignment must be atomic.
     * Previously they were two independent queries, so two concurrent
     * dispatches could both observe the same technician as idle and assign
     * them both jobs. Serializable isolation plus a retry on write conflict
     * closes that window.
     */
    const claimed = await withSerializableRetry(async (tx) => {
      /**
       * A pinned technician is validated, not trusted. Without this the id was
       * written straight onto the order, so a request could assign work to a
       * user on leave, to a deactivated account, or to an id that is not a user
       * at all. Inside the transaction so the check and the write see the same
       * roster.
       */
      if (technicianId) {
        const eligible = await tx.user.findFirst({
          where: assignableUserWhere(technicianId),
          select: { id: true },
        });
        if (!eligible) {
          throw badRequest(
            `Technician ${technicianId} is not available for dispatch.`
          );
        }
      }

      const assignedToId = technicianId ?? (await pickIdleTechnician(tx));

      if (!assignedToId) {
        throw conflict(
          "No available technicians — all field technicians are currently assigned to jobs."
        );
      }

      // Guard against a lost update: only claim the order if it is still
      // unassigned and still open when the write lands.
      const result = await tx.workOrder.updateMany({
        where: {
          id: workOrderId,
          status: { in: [...OPEN_WORK_ORDER_STATUSES] },
        },
        data: {
          assignedToId,
          status: "ASSIGNED",
          scheduledDate: workOrder.scheduledDate ?? new Date(),
        },
      });

      if (result.count === 0) {
        throw conflict(
          `Work order ${workOrder.orderNumber} was modified by another request`
        );
      }

      return assignedToId;
    });

    const updated = await prisma.workOrder.findUniqueOrThrow({
      where: { id: workOrderId },
      include: DISPATCH_INCLUDE,
    });

    // The assignment is already committed. A notification is a courtesy
    // side effect, so a failure here must not be reported as a failed
    // dispatch — the caller would retry and hit "was modified by another
    // request" on an order that is in fact assigned correctly.
    try {
      await prisma.notification.create({
        data: {
          userId: claimed,
          title: `New Work Order: ${workOrder.orderNumber}`,
          message: `${workOrder.title} — ${workOrder.elevator.elevatorCode} at ${workOrder.elevator.building.name}`,
          type: "work_order",
          linkUrl: `/work-orders`,
        },
      });
    } catch (error) {
      console.error("[dispatch] notification failed after assignment", error);
    }

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Returns the id of an idle field technician, or null when none is free. */
async function pickIdleTechnician(tx: Tx): Promise<string | null> {
  const technicians = await tx.user.findMany({
    // A technician on leave or off duty is not idle, they are unavailable —
    // the auto-picker must not hand them the emergency nobody chose.
    where: {
      role: "FIELD_TECHNICIAN",
      isActive: true,
      status: { in: [...DISPATCHABLE_TECHNICIAN_STATUSES] },
    },
    select: {
      id: true,
      _count: {
        select: {
          assignedWorkOrders: {
            where: { status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } },
          },
        },
      },
    },
  });

  const idle = technicians
    .filter((t) => t._count.assignedWorkOrders === 0)
    .sort((a, b) => a.id.localeCompare(b.id));

  return idle[0]?.id ?? null;
}

/**
 * Runs `fn` in a serializable transaction, retrying once on a serialization
 * failure (Prisma P2034).
 */
async function withSerializableRetry<T>(
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      const isSerializationFailure =
        (error as { code?: string })?.code === "P2034";
      if (!isSerializationFailure || attempt >= 1) throw error;
      console.warn("[dispatch] serialization conflict, retrying");
    }
  }
}

// ─── GET: technician roster ─────────────────────────────────

export async function GET() {
  try {
    await requireRole(...MANAGEMENT_ROLES);

    const technicians = await prisma.user.findMany({
      where: {
        role: "FIELD_TECHNICIAN",
        isActive: true,
        status: { in: [...DISPATCHABLE_TECHNICIAN_STATUSES] },
      },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        status: true,
        assignedWorkOrders: {
          where: { status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } },
          select: {
            id: true,
            orderNumber: true,
            title: true,
            status: true,
            elevator: { select: { elevatorCode: true } },
          },
        },
      },
    });

    const data = technicians.map((tech) => ({
      id: tech.id,
      name: tech.name,
      email: tech.email,
      phone: tech.phone,
      activeJobs: tech.assignedWorkOrders.length,
      status: tech.assignedWorkOrders.length > 0 ? "ON_JOB" : "AVAILABLE",
      assignedWorkOrders: tech.assignedWorkOrders,
    }));

    return NextResponse.json({ data });
  } catch (error) {
    return handleRouteError(error);
  }
}
