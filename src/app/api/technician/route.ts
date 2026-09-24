/**
 * ElevatorPulse – Technician Portal API
 *
 * GET /api/technician – Active assignments plus work completed today.
 *
 * A field technician always sees *their own* queue — the `technicianId`
 * query parameter is ignored for that role. Managers and admins may request
 * any technician's queue, and when they omit the parameter the roster's
 * first technician is used as a convenience default for the demo portal.
 *
 * Previously the endpoint accepted any `technicianId` from any authenticated
 * caller and fell back to "the first FIELD_TECHNICIAN in the database", so
 * every technician who opened the portal was shown a colleague's jobs.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError, notFound } from "@/lib/api/http";
import { requireRole, OPS_ROLES } from "@/lib/api/guard";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoTechnician } from "@/lib/demo/responses";

// Session- and database-dependent; never statically prerendered.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES);
    const { searchParams } = new URL(request.url);

    let technicianId: string | null = null;

    if (session.user.role === "FIELD_TECHNICIAN") {
      technicianId = session.user.id;
    } else {
      technicianId = searchParams.get("technicianId");
      if (!technicianId) {
        const first = await prisma.user.findFirst({
          where: { role: "FIELD_TECHNICIAN", isActive: true },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        });
        technicianId = first?.id ?? null;
      }
    }

    if (!technicianId) {
      return NextResponse.json({
        data: { technician: null, active: [], completedToday: [] },
      });
    }

    const technician = await prisma.user.findUnique({
      where: { id: technicianId },
      select: { id: true, name: true, email: true, phone: true, role: true },
    });
    if (!technician) throw notFound("Technicien introuvable");

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [active, completedToday] = await Promise.all([
      prisma.workOrder.findMany({
        where: {
          assignedToId: technician.id,
          status: { in: ["ASSIGNED", "IN_PROGRESS", "ON_HOLD"] },
        },
        orderBy: [{ priority: "desc" }, { scheduledDate: "asc" }],
        include: {
          elevator: {
            select: {
              elevatorCode: true,
              building: { select: { name: true, address: true } },
            },
          },
          component: { select: { name: true, componentType: true } },
          // Lets the portal restore an in-progress checklist after a refresh
          // instead of silently resetting it to all-unchecked.
          inspectionReports: {
            orderBy: { submittedAt: "desc" },
            take: 1,
            select: {
              id: true,
              reportNumber: true,
              summary: true,
              submittedAt: true,
              // `photoUrl` travels with the restore for the same reason the
              // result does: a technician who attached site evidence and then
              // refreshed the page should not lose the link to it.
              checkItems: {
                select: { checkName: true, result: true, notes: true, photoUrl: true },
              },
            },
          },
        },
      }),
      prisma.workOrder.findMany({
        where: {
          assignedToId: technician.id,
          status: "COMPLETED",
          completedAt: { gte: startOfToday },
        },
        orderBy: { completedAt: "desc" },
        include: { elevator: { select: { elevatorCode: true } } },
      }),
    ]);

    return NextResponse.json({
      data: {
        technician,
        active: active.map((wo) => ({
          id: wo.id,
          orderNumber: wo.orderNumber,
          title: wo.title,
          description: wo.description,
          type: wo.type,
          priority: wo.priority,
          status: wo.status,
          scheduledDate: wo.scheduledDate,
          estimatedHours: wo.estimatedHours,
          actualHours: wo.actualHours,
          notes: wo.notes,
          partsReplaced: wo.partsReplaced,
          photoUrls: wo.photoUrls,
          elevator: wo.elevator.elevatorCode,
          building: wo.elevator.building.name,
          address: wo.elevator.building.address,
          component: wo.component?.name ?? null,
          inspection: wo.inspectionReports[0] ?? null,
        })),
        completedToday: completedToday.map((wo) => ({
          id: wo.id,
          orderNumber: wo.orderNumber,
          title: wo.title,
          elevator: wo.elevator.elevatorCode,
          completedAt: wo.completedAt,
          actualHours: wo.actualHours,
        })),
      },
    });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/technician");
      const { searchParams } = new URL(request.url);
      return NextResponse.json({
        data: demoTechnician(searchParams.get("technicianId")),
      });
    }
    return handleRouteError(error);
  }
}
