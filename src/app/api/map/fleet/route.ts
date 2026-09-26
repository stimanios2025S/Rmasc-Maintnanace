/**
 * ElevatorPulse – Fleet Map API
 *
 * GET /api/map/fleet – every located site, its elevators, and how urgent each
 *                      one is, in a single payload.
 *
 * WHY ONE ENDPOINT RATHER THAN FOUR
 * The map needs a building's coordinates, each of its elevators, that unit's
 * open work orders, its open incidents and its unread alarms. Assembling that
 * in the browser would mean four requests per site — a fleet of fifty buildings
 * would fire two hundred — and, worse, four snapshots taken at four different
 * moments, so a map could show a pin as healthy while the panel behind it
 * listed the incident that made it red. One query set, one `generatedAt`, one
 * consistent picture.
 *
 * WHY THE LEVEL IS COMPUTED HERE AND NOT IN THE BROWSER
 * `evaluateAttention` is a pure function and the browser could call it — the
 * technician portal does exactly that for the geofence. It is computed here
 * because the *inputs* are counts that only the database can produce cheaply:
 * sending raw rows so the client could count them would move the whole
 * work-order history of the fleet over the wire to save a few lines here.
 * `attention.ts` is still the single definition of the rule; this route only
 * gathers what it needs.
 *
 * FILTERING IS LEFT TO THE CALLER
 * A fleet is tens of sites, not thousands, so the whole picture fits in one
 * response and the page filters it in memory. That keeps the filter controls
 * instant and stops the endpoint growing a parameter for every control the map
 * screen grows.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError } from "@/lib/api/http";
import { buildingScopeFor, requireRole, OPS_ROLES } from "@/lib/api/guard";
import { OPEN_WORK_ORDER_STATUSES } from "@/lib/work-orders/service";
import { readCoordinates, effectiveRadiusM } from "@/lib/geo/geofence";
import {
  countAttention,
  worstAttention,
  evaluateAttention,
} from "@/lib/map/attention";
import type { AttentionLevel } from "@/lib/map/attention";
import type {
  FleetMapElevator,
  FleetMapPayload,
  FleetMapSite,
  UnlocatedSite,
} from "@/lib/map/types";
import { ALERT_SEVERITIES, OPEN_INCIDENT_STATUSES } from "@/types";
import type { AlertSeverity } from "@/types";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoFleetMap } from "@/lib/demo/fleet-map";

// Reads the session and the database on every request.
export const dynamic = "force-dynamic";

/** Rank a severity, so "the worst alarm on this unit" is a one-line reduction. */
const severityRank = (severity: string): number =>
  ALERT_SEVERITIES.indexOf(severity as AlertSeverity);

export async function GET() {
  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");

    /**
     * One query for the graph, deliberately *without* coordinates in the
     * filter.
     *
     * It would be cheaper to ask Prisma only for sites that have a position.
     * It would also make an ungeolocated building invisible — not greyed out on
     * the map, absent from the application entirely, with no screen anywhere
     * left to notice it on. The unlocated ones are fetched and reported
     * separately instead, which is what turns "the map is empty" into a
     * to-do list.
     */
    const buildings = await prisma.building.findMany({
      where: buildingScopeFor(session),
      select: {
        id: true,
        name: true,
        address: true,
        city: true,
        slaTier: true,
        contactPerson: true,
        contactPhone: true,
        latitude: true,
        longitude: true,
        geofenceRadiusM: true,
        elevators: {
          where: { isActive: true },
          select: {
            id: true,
            elevatorCode: true,
            brand: true,
            model: true,
            floorsServed: true,
            status: true,
            overallHealth: true,
            nextMaintenance: true,
            lastMaintenance: true,
          },
          orderBy: { elevatorCode: "asc" },
        },
      },
      orderBy: { name: "asc" },
    });

    const elevatorIds = buildings.flatMap((b) => b.elevators.map((e) => e.id));

    /**
     * Three aggregate queries, not three queries per elevator.
     *
     * `groupBy` rather than `count` per unit because the number of round trips
     * would otherwise scale with the fleet. An empty `in: []` matches nothing
     * and costs one round trip, which is cheaper than branching around it.
     */
    const [workOrderGroups, incidentGroups, alertGroups] = await Promise.all([
      prisma.workOrder.groupBy({
        by: ["elevatorId"],
        where: {
          elevatorId: { in: elevatorIds },
          status: { in: [...OPEN_WORK_ORDER_STATUSES] },
        },
        _count: { _all: true },
      }),
      prisma.incidentReport.groupBy({
        by: ["elevatorId"],
        where: {
          elevatorId: { in: elevatorIds },
          status: { in: [...OPEN_INCIDENT_STATUSES] },
        },
        _count: { _all: true },
      }),
      // Grouped by severity as well as elevator so the worst alarm can be
      // picked without fetching a single alert row. On a fleet with a long
      // unresolved-alarm backlog that is the difference between a few dozen
      // rows and a few thousand.
      prisma.alert.groupBy({
        by: ["elevatorId", "severity"],
        where: {
          elevatorId: { in: elevatorIds },
          resolvedAt: null,
          isAcknowledged: false,
        },
        _count: { _all: true },
      }),
    ]);

    const openWorkOrders = new Map(
      workOrderGroups.map((g) => [g.elevatorId, g._count._all])
    );
    const openIncidents = new Map(
      incidentGroups.map((g) => [g.elevatorId, g._count._all])
    );

    const alerts = new Map<
      string,
      { count: number; worst: AlertSeverity | null }
    >();
    for (const group of alertGroups) {
      const severity = group.severity as AlertSeverity;
      const entry = alerts.get(group.elevatorId) ?? { count: 0, worst: null };
      entry.count += group._count._all;
      if (entry.worst === null || severityRank(severity) > severityRank(entry.worst)) {
        entry.worst = severity;
      }
      alerts.set(group.elevatorId, entry);
    }

    const now = new Date();

    const sites: FleetMapSite[] = [];
    const unlocated: UnlocatedSite[] = [];
    const allLevels: AttentionLevel[] = [];
    let elevatorsUnlocated = 0;

    for (const building of buildings) {
      const elevators: FleetMapElevator[] = building.elevators.map((elevator) => {
        const alarm = alerts.get(elevator.id);
        const verdict = evaluateAttention(
          {
            status: elevator.status,
            nextMaintenance: elevator.nextMaintenance,
            openWorkOrders: openWorkOrders.get(elevator.id) ?? 0,
            openIncidents: openIncidents.get(elevator.id) ?? 0,
            activeAlerts: alarm?.count ?? 0,
            worstAlertSeverity: alarm?.worst ?? null,
          },
          now
        );

        return {
          id: elevator.id,
          elevatorCode: elevator.elevatorCode,
          brand: elevator.brand,
          model: elevator.model,
          floorsServed: elevator.floorsServed,
          status: elevator.status,
          overallHealth: elevator.overallHealth,
          nextMaintenance: elevator.nextMaintenance?.toISOString() ?? null,
          lastMaintenance: elevator.lastMaintenance?.toISOString() ?? null,
          level: verdict.level,
          reason: verdict.reason,
          reasons: verdict.reasons,
        };
      });

      const siteLevel = elevators.reduce<AttentionLevel>(
        (worst, e) => worstAttention(worst, e.level),
        "NORMAL"
      );

      const position = readCoordinates(building);

      /**
       * An empty site is not a located site.
       *
       * A building with coordinates but no elevators would draw a pin saying
       * "Normal" over a place where we maintain nothing — a reassuring green
       * dot about an unknown. Both cases therefore leave the map, but they are
       * labelled apart: one is a pin waiting to be placed, the other is a
       * record with nothing on it.
       */
      if (!position || elevators.length === 0) {
        unlocated.push({
          id: building.id,
          name: building.name,
          address: building.address,
          city: building.city,
          elevatorCount: elevators.length,
          reason: position ? "no-elevators" : "no-coordinates",
        });
        // Only a missing position hides units from the fleet-wide count. A
        // site with no elevators contributes nothing to it either way.
        if (!position) elevatorsUnlocated += elevators.length;
        continue;
      }

      allLevels.push(...elevators.map((e) => e.level));

      sites.push({
        id: building.id,
        name: building.name,
        address: building.address,
        city: building.city,
        slaTier: building.slaTier,
        contactPerson: building.contactPerson,
        contactPhone: building.contactPhone,
        latitude: position.latitude,
        longitude: position.longitude,
        geofenceRadiusM: effectiveRadiusM(building.geofenceRadiusM),
        level: siteLevel,
        elevatorCount: elevators.length,
        needsAttention: elevators.filter((e) => e.level !== "NORMAL").length,
        elevators,
      });
    }

    const payload: FleetMapPayload = {
      sites,
      unlocated,
      totals: {
        sites: buildings.length,
        sitesLocated: sites.length,
        sitesUnlocated: unlocated.length,
        elevators: elevatorIds.length,
        elevatorsUnlocated,
        byLevel: countAttention(allLevels),
      },
      generatedAt: now.toISOString(),
    };

    return NextResponse.json({ data: payload });
  } catch (error) {
    // Same development convenience as every other read: with no PostgreSQL
    // running, the map renders against the fixture rather than against an
    // error state. See src/lib/demo/mode.ts.
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/map/fleet");
      return NextResponse.json({ data: demoFleetMap() });
    }
    return handleRouteError(error);
  }
}
