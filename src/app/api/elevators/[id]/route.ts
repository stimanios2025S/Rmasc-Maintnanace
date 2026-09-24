/**
 * ElevatorPulse – Elevator Detail API
 *
 * GET /api/elevators/[id] – Specs, components, telemetry, predictive scores,
 *                          recent work orders and alerts for one unit.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError, notFound } from "@/lib/api/http";
import { elevatorScopeFor, OPS_ROLES, requireRole } from "@/lib/api/guard";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoElevatorDetail } from "@/lib/demo/responses";

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");

    // Scoped by id rather than looked up by id and then checked, so an
    // out-of-portfolio id is indistinguishable from a nonexistent one — the
    // previous `findUnique` let any BUILDING_OWNER read any unit in the
    // fleet, including its telemetry, work orders and alert history, simply
    // by walking the cuid space.
    const elevator = await prisma.elevator.findFirst({
      where: { id: params.id, ...elevatorScopeFor(session) },
      include: {
        building: true,
        components: {
          where: { isActive: true },
          orderBy: { remainingUsefulLife: "asc" },
        },
        latestTelemetry: true,
        telemetryStreams: {
          orderBy: { timestamp: "desc" },
          take: 60,
        },
        predictiveScores: {
          // `createdAt` is only set on the first score for a component;
          // subsequent analyses update the row in place.
          orderBy: { updatedAt: "desc" },
        },
        workOrders: {
          orderBy: { createdAt: "desc" },
          take: 10,
          include: { assignedTo: { select: { name: true } } },
        },
        alerts: {
          orderBy: { createdAt: "desc" },
          take: 10,
        },
      },
    });

    if (!elevator) throw notFound(`Elevator not found: ${params.id}`);

    return NextResponse.json({ data: elevator });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/elevators/[id]");
      const detail = demoElevatorDetail(params.id);
      // A real 404 for an id that is not in the fixture either, so the demo
      // data does not invent units the caller asked for by name.
      if (!detail) return handleRouteError(notFound(`Elevator not found: ${params.id}`));
      return NextResponse.json({ data: detail });
    }
    return handleRouteError(error);
  }
}
