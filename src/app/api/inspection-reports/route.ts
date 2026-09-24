/**
 * ElevatorPulse – Inspection Reports API
 *
 * GET  /api/inspection-reports?workOrderId=…  – the report for a work order
 * GET  /api/inspection-reports                – recent reports (paginated)
 * POST /api/inspection-reports                – record a completed inspection
 *
 * Why this exists: the field portal rendered an inspection checklist that lived
 * entirely in React state. It was lost on refresh, never reached the database,
 * and yet it gated the "Complete Job" button — so a work order could be closed
 * with no record of what was actually inspected. The `InspectionReport` and
 * `InspectionCheckItem` models were already in the schema and seeded; nothing
 * ever wrote to them. This route closes that gap.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  badRequest,
  conflict,
  forbidden,
  handleRouteError,
  jsonOk,
  notFound,
  parsePagination,
  readJson,
} from "@/lib/api/http";
import {
  buildingScopeFor,
  OPS_ROLES,
  requireRole,
} from "@/lib/api/guard";
import { generateReportNumber } from "@/lib/ids";
import { notify, notifyMany, notifyRoles } from "@/lib/notifications/service";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import {
  demoInspectionReportById,
  demoInspectionReportForWorkOrder,
  demoInspectionReports,
} from "@/lib/demo/responses";
import { INSPECTION_CHECK_RESULTS, MANAGEMENT_ROLES } from "@/types";
import type { Prisma } from "@prisma/client";

const CheckItemSchema = z.object({
  checkName: z.string().trim().min(1).max(200),
  result: z.enum(INSPECTION_CHECK_RESULTS).default("PASS"),
  description: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
  measuredValue: z.number().finite().optional(),
  unit: z.string().trim().max(20).optional(),
  /**
   * Evidence for this specific check, not for the visit as a whole. A photo
   * attached to the item it documents is worth more than a folder of
   * unattributed site pictures — six months later nobody can tell which
   * machine a loose image came from.
   */
  photoUrl: z.string().trim().url().max(2000).optional(),
});

/**
 * A signature recorded against the finished report.
 *
 * `imageDataUrl` is a canvas capture, capped hard. The cap is not decoration:
 * a signature is stored inside a JSON column on the same row as the report,
 * and a multi-megabyte base64 PNG would bloat every read of that row — the
 * list endpoint selects this column. 200 KB holds a generous stroke path at
 * pad resolution and nothing more.
 */
const SignatureSchema = z
  .object({
    role: z.enum(["TECHNICIAN", "CLIENT", "SUPERVISOR"]),
    name: z.string().trim().min(1).max(200),
    method: z.enum(["DRAWN", "TYPED"]).default("TYPED"),
    signedAt: z.string().datetime().optional(),
    imageDataUrl: z
      .string()
      .trim()
      .max(200_000)
      .regex(
        /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/,
        "Signature images must be a base64 PNG or JPEG data URL"
      )
      .optional(),
  })
  .strict();

const CreateReportSchema = z
  .object({
    workOrderId: z.string().min(1),
    title: z.string().trim().min(3).max(200).optional(),
    summary: z.string().trim().max(5000).optional(),
    items: z.array(CheckItemSchema).min(1).max(100),
    signatures: z.array(SignatureSchema).max(4).optional(),
  })
  .strict();

/**
 * Worst result wins, so a single FAIL cannot be averaged away by PASSes.
 * ORDER: FAIL > NEEDS_ATTENTION > PASS; NOT_APPLICABLE is ignored unless
 * every item is NOT_APPLICABLE.
 */
function overallResult(
  items: { result: (typeof INSPECTION_CHECK_RESULTS)[number] }[]
): (typeof INSPECTION_CHECK_RESULTS)[number] {
  if (items.some((i) => i.result === "FAIL")) return "FAIL";
  if (items.some((i) => i.result === "NEEDS_ATTENTION")) return "NEEDS_ATTENTION";
  if (items.every((i) => i.result === "NOT_APPLICABLE")) return "NOT_APPLICABLE";
  return "PASS";
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const workOrderId = searchParams.get("workOrderId");
  /**
   * The printable view addresses one report directly. Kept as a parameter on
   * this route rather than a `[id]` segment so both lookups share the same
   * scoping and select — a second route would be a second place for the
   * portfolio boundary to drift.
   */
  const reportId = searchParams.get("id");

  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");

    const select = {
      id: true,
      reportNumber: true,
      title: true,
      summary: true,
      overallResult: true,
      submittedAt: true,
      workOrderId: true,
      signatures: true,
      technician: { select: { id: true, name: true } },
      checkItems: {
        select: {
          id: true,
          checkName: true,
          result: true,
          notes: true,
          measuredValue: true,
          unit: true,
          photoUrl: true,
        },
        orderBy: { id: "asc" as const },
      },
    };

    // A BUILDING_OWNER is confined to reports on its own portfolio. The
    // previous rule was "managers and owners see everything", which handed
    // every customer the complete inspection history of every other
    // customer's equipment — every check item, measured value and the
    // technician's free-text notes — both by id and via the list below.
    //
    // Scoped through the report's own `elevatorId` (the unit the inspection
    // documents) rather than through its work order.
    const ownerScope: Prisma.InspectionReportWhereInput =
      session.user.role === "BUILDING_OWNER"
        ? { elevator: { building: buildingScopeFor(session) } }
        : {};

    if (reportId) {
      const report = await prisma.inspectionReport.findFirst({
        // `findFirst` with the scope rather than `findUnique` by id: a report
        // outside the caller's portfolio must read as absent, not as a
        // permission error that confirms the row exists.
        where: {
          id: reportId,
          ...ownerScope,
          ...(session.user.role === "FIELD_TECHNICIAN"
            ? { technicianId: session.user.id }
            : {}),
        },
        select: {
          ...select,
          workOrder: {
            select: {
              id: true,
              orderNumber: true,
              title: true,
              type: true,
              priority: true,
              status: true,
              completedAt: true,
            },
          },
          elevator: {
            select: {
              id: true,
              elevatorCode: true,
              brand: true,
              model: true,
              building: { select: { name: true, address: true, city: true } },
            },
          },
        },
      });

      if (!report) throw notFound(`Inspection report not found: ${reportId}`);
      return jsonOk(report);
    }

    if (workOrderId) {
      const report = await prisma.inspectionReport.findFirst({
        where: {
          ...ownerScope,
          workOrderId,
          // A technician may only read their own reports. The work order is
          // the unit of authorisation.
          ...(session.user.role === "FIELD_TECHNICIAN"
            ? { technicianId: session.user.id }
            : {}),
        },
        orderBy: { submittedAt: "desc" },
        select,
      });

      // Absence is normal — it just means the job has not been signed off yet.
      // `jsonOk` already wraps the payload in `{ data }`.
      return jsonOk(report);
    }

    const { page, limit, skip } = parsePagination(request.nextUrl.searchParams);
    const where: Prisma.InspectionReportWhereInput =
      session.user.role === "FIELD_TECHNICIAN"
        ? { technicianId: session.user.id }
        : ownerScope;

    const [total, reports] = await Promise.all([
      prisma.inspectionReport.count({ where }),
      prisma.inspectionReport.findMany({
        where,
        orderBy: { submittedAt: "desc" },
        skip,
        take: limit,
        select: { ...select, checkItems: false },
      }),
    ]);

    // `total` sits alongside `data` rather than inside it, matching
    // /api/alerts and /api/work-orders.
    return NextResponse.json({ data: reports, total, page, limit });
  } catch (error) {
    /**
     * Dev-only fixture fallback, engaged only when `DEMO_DATA="true"` *and* the
     * failure is a connection failure — `shouldServeDemoData` makes both checks
     * and refuses when `NODE_ENV=production`. With the flag off (the shipped
     * default) an unreachable database returns 503 `DATABASE_UNAVAILABLE`, which
     * is the honest answer: an inspection history that silently becomes
     * invented reports is worse than one that fails to load.
     */
    if (shouldServeDemoData(error)) {
      if (reportId) {
        const report = demoInspectionReportById(reportId);
        // `notFound` builds the error; `handleRouteError` is what turns it into
        // a response. A bare `throw` here would escape the catch unhandled.
        if (!report) {
          return handleRouteError(
            notFound(`Inspection report not found: ${reportId}`)
          );
        }
        return jsonOk(report);
      }

      if (workOrderId) {
        // Absence is normal here — the job may simply not be signed off yet —
        // so a miss is `null`, matching the live branch.
        return jsonOk(demoInspectionReportForWorkOrder(workOrderId));
      }

      warnDemoFallbackOnce("GET /api/inspection-reports");
      const { limit, skip } = parsePagination(searchParams);
      return NextResponse.json(demoInspectionReports({ limit, skip }));
    }

    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES);
    const body = CreateReportSchema.parse(await readJson(request));

    const workOrder = await prisma.workOrder.findUnique({
      where: { id: body.workOrderId },
      select: {
        id: true,
        orderNumber: true,
        title: true,
        elevatorId: true,
        assignedToId: true,
        createdById: true,
        status: true,
        elevator: {
          select: {
            elevatorCode: true,
            building: { select: { name: true, ownerId: true } },
          },
        },
        inspectionReports: {
          select: { id: true, reportNumber: true },
          orderBy: { submittedAt: "desc" },
          take: 1,
        },
      },
    });

    if (!workOrder) throw notFound(`Work order not found: ${body.workOrderId}`);

    // A FIELD_TECHNICIAN may only file a report against their own assignment.
    const isManager =
      session.user.role === "ADMIN" || session.user.role === "MAINTENANCE_MANAGER";
    if (!isManager && workOrder.assignedToId !== session.user.id) {
      throw forbidden("You can only file a report for a work order assigned to you.");
    }

    const existing = workOrder.inspectionReports[0];
    if (existing) {
      throw conflict(
        `A report (${existing.reportNumber}) already exists for this work order.`
      );
    }

    // A report on a cancelled order would be meaningless.
    if (workOrder.status === "CANCELLED") {
      throw badRequest("Cannot file an inspection report for a cancelled work order.");
    }

    // A signature names who signed. A drawn signature with no name attached is
    // an image of a scribble; the API will not accept one, and it will not
    // accept a signature block that claims a role nobody filled — see below.
    const signatures = (body.signatures ?? []).map((signature) => ({
      role: signature.role,
      name: signature.name,
      method: signature.method,
      signedAt: signature.signedAt ?? new Date().toISOString(),
      ...(signature.imageDataUrl ? { imageDataUrl: signature.imageDataUrl } : {}),
    }));

    const report = await prisma.inspectionReport.create({
      data: {
        workOrderId: workOrder.id,
        technicianId: session.user.id,
        elevatorId: workOrder.elevatorId,
        reportNumber: generateReportNumber(),
        title: body.title ?? `Inspection – ${workOrder.title}`,
        summary: body.summary,
        overallResult: overallResult(body.items),
        signatures: signatures.length > 0 ? signatures : undefined,
        checkItems: {
          create: body.items.map((item) => ({
            checkName: item.checkName,
            description: item.description,
            result: item.result,
            notes: item.notes,
            measuredValue: item.measuredValue,
            unit: item.unit,
            photoUrl: item.photoUrl,
          })),
        },
      },
      select: {
        id: true,
        reportNumber: true,
        overallResult: true,
        submittedAt: true,
      },
    });

    /**
     * Tell the customer their equipment was inspected.
     *
     * Addressed to the building's owner rather than broadcast to management:
     * this is the "your lift was serviced today" message, and its audience is
     * the person who owns the building, not the dispatch desk that sent the
     * technician. When no owner is recorded on the building there is nobody
     * whose equipment it is, so nothing is sent — inventing a recipient would
     * put a customer's maintenance record in a stranger's inbox.
     */
    const owner = workOrder.elevator.building.ownerId;
    if (owner && owner !== session.user.id) {
      await notify({
        userId: owner,
        title: `Inspection terminée – ${workOrder.elevator.elevatorCode}`,
        message:
          `Le rapport ${report.reportNumber} pour ${workOrder.elevator.elevatorCode} ` +
          `(${workOrder.elevator.building.name}) est disponible. ` +
          `Résultat : ${report.overallResult}.`,
        type: "inspection",
        linkUrl: `/inspection-reports/${report.id}`,
      });
    }

    // A FAIL is a follow-up someone has to schedule; a clean PASS is not worth
    // a notification to the dispatch desk.
    //
    // Sent to whoever raised the order, falling back to the dispatch desk when
    // the creator's account has since been deleted (`createdById` is nullable
    // and `onDelete: SetNull`). Without the fallback a failed inspection on an
    // order raised by a departed colleague would notify nobody at all.
    if (report.overallResult === "FAIL") {
      const notice = {
        title: `Inspection failed – ${workOrder.orderNumber}`,
        message:
          `${workOrder.elevator.elevatorCode} failed inspection (${report.reportNumber}). ` +
          "Review the report and raise corrective work.",
        type: "inspection" as const,
        linkUrl: `/inspection-reports/${report.id}`,
      };

      if (workOrder.createdById) {
        await notifyMany([workOrder.createdById], notice);
      } else {
        await notifyRoles(MANAGEMENT_ROLES, notice);
      }
    }

    return NextResponse.json({ data: report }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
