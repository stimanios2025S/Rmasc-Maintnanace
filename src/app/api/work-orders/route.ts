/**
 * ElevatorPulse – Work Orders API
 *
 * GET    /api/work-orders          – List work orders (with filters)
 * POST   /api/work-orders          – Create a work order
 * PATCH  /api/work-orders?id=xxx   – Update a work order
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { z } from "zod";
import {
  badRequest,
  conflict,
  forbidden,
  handleRouteError,
  notFound,
  parseEnumParam,
  parsePagination,
  readJson,
} from "@/lib/api/http";
import {
  assignableUserWhere,
  buildingScopeFor,
  isSelfOrManager,
  OPS_ROLES,
  requireRole,
} from "@/lib/api/guard";
import { createWorkOrderWithUniqueNumber } from "@/lib/work-orders/service";
import {
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_STATUSES,
  WORK_ORDER_TYPES,
} from "@/types";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoWorkOrders } from "@/lib/demo/responses";

const CreateWorkOrderSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(5000).optional(),
    type: z.enum(WORK_ORDER_TYPES),
    priority: z.enum(WORK_ORDER_PRIORITIES),
    elevatorId: z.string().min(1),
    componentId: z.string().min(1).optional(),
    assignedToId: z.string().min(1).optional(),
    scheduledDate: z.string().datetime().optional(),
    estimatedHours: z.number().positive().max(1000).optional(),
  })
  .strict();

const UpdateWorkOrderSchema = z
  .object({
    status: z.enum(WORK_ORDER_STATUSES).optional(),
    assignedToId: z.string().min(1).nullable().optional(),
    actualHours: z.number().min(0).max(1000).optional(),
    scheduledDate: z.string().datetime().nullable().optional(),
    partsReplaced: z
      .array(
        z.object({
          name: z.string().min(1),
          partNumber: z.string().optional(),
          qty: z.number().positive(),
        })
      )
      .max(200)
      .optional(),
    notes: z.string().max(10000).nullable().optional(),
    photoUrls: z.array(z.string().url()).max(50).optional(),
    signatureUrl: z.string().url().nullable().optional(),
  })
  .strict();

const WORK_ORDER_INCLUDE = {
  elevator: {
    select: {
      id: true,
      elevatorCode: true,
      building: { select: { name: true } },
    },
  },
  assignedTo: { select: { id: true, name: true, email: true } },
  component: { select: { name: true, componentType: true } },
  /**
   * The incident this order was raised from, when there was one.
   *
   * Read-only context for the board, and the reason it is on the include
   * rather than left to the incident endpoint: a dispatcher looking at a
   * corrective order needs to know it came from a customer escalation, and
   * which fault code, *before* deciding who to send. Most orders have none —
   * the relation is nullable and the field reads as absent.
   */
  incident: {
    select: {
      id: true,
      incidentNumber: true,
      status: true,
      isDirectTransfer: true,
      errorCode: { select: { code: true, title: true } },
    },
  },
} as const;

/**
 * Permitted status transitions. Terminal states are genuinely terminal —
 * the previous implementation let an update walk a COMPLETED order back to
 * ASSIGNED simply by setting `assignedToId`, silently discarding the
 * completion timestamp.
 */
const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  OPEN: ["ASSIGNED", "IN_PROGRESS", "ON_HOLD", "CANCELLED"],
  ASSIGNED: ["OPEN", "IN_PROGRESS", "ON_HOLD", "CANCELLED"],
  IN_PROGRESS: ["ASSIGNED", "ON_HOLD", "COMPLETED", "CANCELLED"],
  ON_HOLD: ["ASSIGNED", "IN_PROGRESS", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

// ─── GET: list work orders ──────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");

    const { searchParams } = new URL(request.url);
    const { page, limit, skip } = parsePagination(searchParams);

    const where: Record<string, unknown> = {};

    // A building owner sees only work orders for the buildings they own.
    // Without this they received the entire fleet's maintenance history.
    // Uses the shared scope so this filter cannot drift from the other
    // owner-scoped routes.
    if (session.user.role === "BUILDING_OWNER") {
      where.elevator = { building: buildingScopeFor(session) };
    }
    const status = parseEnumParam(searchParams, "status", WORK_ORDER_STATUSES);
    const priority = parseEnumParam(
      searchParams,
      "priority",
      WORK_ORDER_PRIORITIES
    );
    const type = parseEnumParam(searchParams, "type", WORK_ORDER_TYPES);
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (type) where.type = type;

    for (const key of ["elevatorId", "assignedToId"] as const) {
      const value = searchParams.get(key);
      if (value) where[key] = value;
    }

    const [workOrders, total] = await Promise.all([
      prisma.workOrder.findMany({
        where,
        // `WorkOrderPriority` is declared LOW -> CRITICAL, and Postgres sorts
        // enums by declaration order, so `desc` puts the most urgent first.
        // (Reordering the enum in schema.prisma changes this silently.)
        orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
        take: limit,
        skip,
        include: WORK_ORDER_INCLUDE,
      }),
      prisma.workOrder.count({ where }),
    ]);

    return NextResponse.json({
      data: workOrders,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/work-orders");
      // Re-read the query string: the parsed values live in the `try` scope.
      const { searchParams } = new URL(request.url);
      const { limit, skip } = parsePagination(searchParams);
      return NextResponse.json(
        demoWorkOrders({
          status: searchParams.get("status"),
          priority: searchParams.get("priority"),
          type: searchParams.get("type"),
          elevatorId: searchParams.get("elevatorId"),
          assignedToId: searchParams.get("assignedToId"),
          limit,
          skip,
        })
      );
    }
    return handleRouteError(error);
  }
}

// ─── POST: create a work order ──────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES);
    const parsed = CreateWorkOrderSchema.parse(await readJson(request));

    const elevator = await prisma.elevator.findFirst({
      where: { id: parsed.elevatorId, isActive: true },
      select: { id: true },
    });
    if (!elevator) {
      throw notFound(`Ascenseur introuvable : ${parsed.elevatorId}`);
    }

    if (parsed.componentId) {
      const component = await prisma.elevatorComponent.findFirst({
        where: { id: parsed.componentId, elevatorId: parsed.elevatorId },
        select: { id: true },
      });
      if (!component) {
        throw notFound(
          `Composant introuvable sur cet ascenseur : ${parsed.componentId}`
        );
      }
    }

    if (parsed.assignedToId) {
      const tech = await prisma.user.findFirst({
        where: assignableUserWhere(parsed.assignedToId),
        select: { id: true },
      });
      if (!tech) {
        throw notFound(
          `Personne à affecter introuvable ou non affectable : ${parsed.assignedToId}`
        );
      }
    }

    // Attribute the order to the caller. The previous implementation always
    // wrote the earliest admin/manager as `createdBy`, so every order in the
    // system appeared to have been raised by the same seeded account and the
    // audit trail was worthless.
    const workOrder = await createWorkOrderWithUniqueNumber({
      title: parsed.title,
      description: parsed.description ?? null,
      type: parsed.type,
      priority: parsed.priority,
      elevatorId: parsed.elevatorId,
      componentId: parsed.componentId ?? null,
      assignedToId: parsed.assignedToId ?? null,
      createdById: session.user.id,
      scheduledDate: parsed.scheduledDate ? new Date(parsed.scheduledDate) : null,
      estimatedHours: parsed.estimatedHours ?? null,
      status: parsed.assignedToId ? "ASSIGNED" : "OPEN",
    });

    const enriched = await prisma.workOrder.findUniqueOrThrow({
      where: { id: workOrder.id },
      include: WORK_ORDER_INCLUDE,
    });

    return NextResponse.json({ data: enriched }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}

// ─── PATCH: update a work order ─────────────────────────────

export async function PATCH(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES);

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) throw badRequest("L'identifiant du bon de travail est requis");

    const parsed = UpdateWorkOrderSchema.parse(await readJson(request));

    const current = await prisma.workOrder.findUnique({
      where: { id },
      select: { id: true, status: true, assignedToId: true, startedAt: true },
    });
    if (!current) throw notFound(`Bon de travail introuvable : ${id}`);

    // A field technician may only touch work assigned to them, and may not
    // reassign it. Without this, any authenticated user — including a
    // building owner — could reassign or close any order in the system.
    if (!isSelfOrManager(session, current.assignedToId)) {
      throw forbidden("Ce bon de travail ne vous est pas affecté");
    }

    const updateData: Record<string, unknown> = {};

    if (parsed.status && parsed.status !== current.status) {
      const allowed = ALLOWED_TRANSITIONS[current.status] ?? [];
      if (!allowed.includes(parsed.status)) {
        throw conflict(
          `Impossible de faire passer le bon de travail de ${current.status} à ${parsed.status}`
        );
      }
      updateData.status = parsed.status;

      if (parsed.status === "IN_PROGRESS" && !current.startedAt) {
        updateData.startedAt = new Date();
      }
      if (parsed.status === "COMPLETED") {
        updateData.completedAt = new Date();
      }
      if (parsed.status === "OPEN" || parsed.status === "CANCELLED") {
        updateData.startedAt = null;
        updateData.completedAt = null;
      }
    }

    if (parsed.assignedToId !== undefined) {
      // Only managers and admins may reassign work.
      if (session.user.role === "FIELD_TECHNICIAN") {
        throw badRequest("Seuls les responsables peuvent réaffecter des bons de travail");
      }

      if (parsed.assignedToId) {
        const tech = await prisma.user.findFirst({
          where: assignableUserWhere(parsed.assignedToId),
          select: { id: true },
        });
        if (!tech) {
          throw notFound(
            `Personne à affecter introuvable ou non affectable : ${parsed.assignedToId}`
          );
        }
      }
      updateData.assignedToId = parsed.assignedToId;

      // Assigning an unassigned order advances it — but never resurrect a
      // closed order into ASSIGNED.
      if (
        parsed.assignedToId &&
        !parsed.status &&
        current.status === "OPEN"
      ) {
        updateData.status = "ASSIGNED";
      }
    }

    if (parsed.scheduledDate !== undefined) {
      updateData.scheduledDate = parsed.scheduledDate
        ? new Date(parsed.scheduledDate)
        : null;
    }
    if (parsed.actualHours !== undefined) updateData.actualHours = parsed.actualHours;
    if (parsed.partsReplaced !== undefined) updateData.partsReplaced = parsed.partsReplaced;
    if (parsed.notes !== undefined) updateData.notes = parsed.notes;
    if (parsed.photoUrls !== undefined) updateData.photoUrls = parsed.photoUrls;
    if (parsed.signatureUrl !== undefined) updateData.signatureUrl = parsed.signatureUrl;

    // An ASSIGNED order with no assignee is a dead end: it shows in the
    // "Assigned" column, is invisible to every technician's queue (which is
    // filtered by `assignedToId`), and cannot be dispatched. The kanban's
    // "Move to Assigned" button used to create exactly that.
    const nextStatus = String(updateData.status ?? current.status);
    const nextAssignee =
      parsed.assignedToId !== undefined ? parsed.assignedToId : current.assignedToId;
    if (nextStatus === "ASSIGNED" && !nextAssignee) {
      throw badRequest(
        "Un bon de travail ne peut pas être marqué ASSIGNED sans personne affectée. " +
          "Renseignez `assignedToId`, ou utilisez POST /api/work-orders/dispatch."
      );
    }

    const workOrder = await prisma.workOrder.update({
      where: { id },
      data: updateData,
      include: WORK_ORDER_INCLUDE,
    });

    return NextResponse.json({ data: workOrder });
  } catch (error) {
    return handleRouteError(error);
  }
}
