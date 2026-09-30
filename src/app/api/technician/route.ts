/**
 * Maintenance RMASC – Technician Portal API
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
              building: {
                select: {
                  name: true,
                  address: true,
                  // Sent to the technician's browser so the check-in button can
                  // be enabled or greyed out *before* the tap, using the same
                  // rule the server applies. Without them the interface would
                  // only find out from a refusal.
                  latitude: true,
                  longitude: true,
                  geofenceRadiusM: true,
                },
              },
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
      /**
       * Everything this technician has handed over today — completed orders
       * *and* reports still waiting in the office.
       *
       * The second half is not decoration. A report that lands in
       * PENDING_APPROVAL drops out of `active` by design (the job is off his
       * hands), so without this an order would disappear from the screen in the
       * same second he validated it, with no confirmation that anything was
       * saved. On a phone, in a lift shaft, that reads as a failed submission
       * and gets retyped.
       *
       * `ORDER BY completed_at DESC` puts the pending rows first on its own:
       * PostgreSQL's default for a descending sort is NULLS FIRST, and a
       * pending order has no `completedAt` yet. That is the order we want —
       * the newest hand-over at the top — but it is a consequence of the SQL
       * default rather than of anything written here, so it is spelled out.
       */
      prisma.workOrder.findMany({
        where: {
          assignedToId: technician.id,
          OR: [
            { status: "COMPLETED", completedAt: { gte: startOfToday } },
            {
              status: "PENDING_APPROVAL",
              reportSubmittedAt: { gte: startOfToday },
            },
          ],
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
          /**
           * Carried so the portal can show "Arrivée pointée à 09:14" instead of
           * the check-in button after a refresh. Without them the button came
           * back on every reload and a second tap would be refused by the
           * route's idempotency guard, which reads as the app losing the
           * technician's own action.
           */
          arrivedAt: wo.arrivedAt,
          checkInNotes: wo.checkInNotes,
          notes: wo.notes,
          partsReplaced: wo.partsReplaced,
          /**
           * Converted from `Decimal` to a plain number on the way out.
           *
           * Prisma hands back a `Decimal` object, which JSON-serialises to a
           * *string* ("18500.00"). The portal compares it against a number and
           * would put that string straight into a text field, so the conversion
           * belongs here, at the boundary, rather than in every reader of the
           * field. `toNumber()` is safe at this scale: `Decimal(12,2)` maxes
           * out well inside the range where doubles are exact to the centime.
           */
          isBillable: wo.isBillable,
          invoiceAmount: wo.invoiceAmount === null ? null : wo.invoiceAmount.toNumber(),
          photoUrls: wo.photoUrls,
          elevator: wo.elevator.elevatorCode,
          building: wo.elevator.building.name,
          address: wo.elevator.building.address,
          /**
           * The site's position and radius, so the portal can compute the same
           * distance the server will. Null latitude/longitude means the site
           * has never been geolocated: the button then stays enabled, because
           * refusing would strand a technician at a site we never mapped.
           */
          siteLatitude: wo.elevator.building.latitude,
          siteLongitude: wo.elevator.building.longitude,
          geofenceRadiusM: wo.elevator.building.geofenceRadiusM,
          component: wo.component?.name ?? null,
          inspection: wo.inspectionReports[0] ?? null,
        })),
        completedToday: completedToday.map((wo) => ({
          id: wo.id,
          orderNumber: wo.orderNumber,
          title: wo.title,
          elevator: wo.elevator.elevatorCode,
          /**
           * `status` travels so the portal can tell an order the office has
           * accepted from one still sitting in its queue. Both are shown; only
           * the wording differs.
           */
          status: wo.status,
          completedAt: wo.completedAt,
          reportSubmittedAt: wo.reportSubmittedAt,
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
