/**
 * ElevatorPulse – Dashboard Overview API
 *
 * GET /api/dashboard – Fleet KPIs, status breakdown, building health and
 *                      recent alerts, scoped to the caller's access.
 *
 * A BUILDING_OWNER sees only the buildings they own. Previously the endpoint
 * had no authorisation at all beyond the middleware gate and returned the
 * entire fleet to every role, including other owners' buildings.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError } from "@/lib/api/http";
import { requireRole, OPS_ROLES } from "@/lib/api/guard";
import type { Prisma } from "@prisma/client";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoDashboard } from "@/lib/demo/responses";

// Reads the session and the database on every request; it must never be
// statically prerendered at build time.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");

    // Scope every query in this handler through one filter.
    const buildingScope: Prisma.BuildingWhereInput =
      session.user.role === "BUILDING_OWNER"
        ? { isActive: true, ownerId: session.user.id }
        : { isActive: true };

    const elevatorScope: Prisma.ElevatorWhereInput = {
      isActive: true,
      building: buildingScope,
    };
    const workOrderScope: Prisma.WorkOrderWhereInput = {
      elevator: { building: buildingScope },
    };

    const [totalBuildings, elevators, openWorkOrders, emergencyWorkOrders, recentAlerts] =
      await Promise.all([
        prisma.building.count({ where: buildingScope }),
        prisma.elevator.findMany({
          where: elevatorScope,
          select: { id: true, status: true, overallHealth: true },
        }),
        prisma.workOrder.count({
          where: {
            ...workOrderScope,
            status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS", "ON_HOLD"] },
          },
        }),
        prisma.workOrder.count({
          where: {
            ...workOrderScope,
            priority: { in: ["EMERGENCY", "CRITICAL"] },
            status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS", "ON_HOLD"] },
          },
        }),
        prisma.alert.findMany({
          where: { resolvedAt: null, elevator: elevatorScope },
          orderBy: { createdAt: "desc" },
          take: 8,
          include: { elevator: { select: { elevatorCode: true } } },
        }),
      ]);

    const countByStatus = (status: string) =>
      elevators.filter((e) => e.status === status).length;

    const avgHealth =
      elevators.length > 0
        ? Math.round(
            (elevators.reduce((sum, e) => sum + e.overallHealth, 0) /
              elevators.length) *
              10
          ) / 10
        : 0;

    const buildings = await prisma.building.findMany({
      where: buildingScope,
      select: {
        id: true,
        name: true,
        elevators: {
          where: { isActive: true },
          select: { overallHealth: true },
        },
      },
      orderBy: { name: "asc" },
    });

    const buildingHealth = buildings.map((b) => ({
      id: b.id,
      name: b.name,
      elevators: b.elevators.length,
      health:
        b.elevators.length > 0
          ? Math.round(
              b.elevators.reduce((sum, e) => sum + e.overallHealth, 0) /
                b.elevators.length
            )
          : 0,
    }));

    // Real telemetry for the chart on the overview screen.
    //
    // The screen previously rendered client-side sine waves under a green
    // "LIVE" badge and the caption "Real-time sensor data streams". The series
    // is now the genuine readings from whichever elevator reported most
    // recently, and the caller is told which unit it is looking at and when it
    // last reported, so a stale feed cannot masquerade as live.
    const latestReading = await prisma.telemetryStream.findFirst({
      where: { elevator: elevatorScope },
      orderBy: { timestamp: "desc" },
      select: {
        elevatorId: true,
        timestamp: true,
        elevator: { select: { elevatorCode: true } },
      },
    });

    let telemetryFeed: {
      elevatorId: string;
      elevatorCode: string;
      lastReadingAt: Date;
      points: {
        timestamp: Date;
        motorVibrationMmS: number | null;
        motorTemperatureC: number | null;
        cabinLoadKg: number | null;
      }[];
    } | null = null;

    if (latestReading) {
      const recent = await prisma.telemetryStream.findMany({
        where: { elevatorId: latestReading.elevatorId },
        orderBy: { timestamp: "desc" },
        take: 30,
        select: {
          timestamp: true,
          motorVibrationMmS: true,
          motorTemperatureC: true,
          cabinLoadKg: true,
        },
      });

      telemetryFeed = {
        elevatorId: latestReading.elevatorId,
        elevatorCode: latestReading.elevator.elevatorCode,
        lastReadingAt: latestReading.timestamp,
        // Oldest first so the chart reads left-to-right in time order.
        points: recent.reverse(),
      };
    }

    return NextResponse.json({
      data: {
        telemetryFeed,
        stats: {
          totalBuildings,
          totalElevators: elevators.length,
          operationalCount: countByStatus("OPERATIONAL"),
          serviceRequiredCount: countByStatus("SERVICE_REQUIRED"),
          anomalyCount: countByStatus("ANOMALY_DETECTED"),
          criticalCount: countByStatus("CRITICAL_SHUTDOWN"),
          offlineCount: countByStatus("OFFLINE"),
          openWorkOrders,
          emergencyWorkOrders,
          avgHealth,
        },
        statusBreakdown: [
          { name: "Operational", value: countByStatus("OPERATIONAL"), color: "#22c55e" },
          { name: "Service Required", value: countByStatus("SERVICE_REQUIRED"), color: "#eab308" },
          { name: "Anomaly", value: countByStatus("ANOMALY_DETECTED"), color: "#f97316" },
          { name: "Critical", value: countByStatus("CRITICAL_SHUTDOWN"), color: "#ef4444" },
          { name: "Offline", value: countByStatus("OFFLINE"), color: "#6b7280" },
        ],
        buildingHealth,
        recentAlerts: recentAlerts.map((a) => ({
          id: a.id,
          elevator: a.elevator.elevatorCode,
          message: a.message,
          severity: a.severity,
          createdAt: a.createdAt,
          acknowledged: a.isAcknowledged,
        })),
      },
    });
  } catch (error) {
    // Development convenience: with no PostgreSQL running, serve the fixture
    // so the dashboard renders. Real data is unaffected — this branch is only
    // reached when the query itself could not connect. See src/lib/demo/mode.ts.
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/dashboard");
      return NextResponse.json({ data: demoDashboard() });
    }
    return handleRouteError(error);
  }
}
