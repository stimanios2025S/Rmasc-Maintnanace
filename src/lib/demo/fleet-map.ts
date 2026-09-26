/**
 * Fixture for `GET /api/map/fleet`.
 *
 * WHY THIS ONE IS NOT IN `responses.ts`
 * Every other builder in that file reshapes rows the dataset already holds.
 * This one does not: it has to run the same `evaluateAttention` the real route
 * runs, against the demo's alerts, work orders and incidents, to produce the
 * levels the map colours itself by. Hard-coding "this one is red" would let the
 * fixture and the live endpoint disagree — and a demo that shows a different
 * number of red pins than the rule produces is worse than no demo, because the
 * map is the screen where a disagreement is least visible.
 *
 * So the rule is genuinely shared: the real route and this file both call
 * `evaluateAttention`, and neither owns the definition.
 *
 * The dataset refreshes itself on a TTL (see `demoWorld`), so the counts here
 * drift with `now` exactly as the real ones do — a unit whose next service is
 * twenty days out will become "Entretien dans 19 jours" tomorrow, in the demo
 * as in production.
 */

import { demoWorld } from "./dataset";
import { OPEN_WORK_ORDER_STATUSES } from "@/lib/work-orders/service";
import { effectiveRadiusM, readCoordinates } from "@/lib/geo/geofence";
import {
  countAttention,
  evaluateAttention,
  worstAttention,
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

/** Mirrors the real route's reduction, so the worst alarm is picked the same way. */
const severityRank = (severity: string): number =>
  ALERT_SEVERITIES.indexOf(severity as AlertSeverity);

export function demoFleetMap(): FleetMapPayload {
  const { buildings, elevators, alerts, workOrders, incidents } = demoWorld();
  const now = new Date();

  const sites: FleetMapSite[] = [];
  const unlocated: UnlocatedSite[] = [];
  const levels: AttentionLevel[] = [];
  let elevatorsUnlocated = 0;

  for (const building of buildings) {
    const units = elevators.filter(
      (e) => e.buildingId === building.id && e.isActive
    );

    const mapped: FleetMapElevator[] = units.map((elevator) => {
      const unitAlerts = alerts.filter(
        (a) =>
          a.elevatorId === elevator.id &&
          !a.isAcknowledged &&
          a.resolvedAt === null
      );

      const worstAlertSeverity = unitAlerts.reduce<AlertSeverity | null>(
        (worst, alert) => {
          const severity = alert.severity as AlertSeverity;
          return worst === null || severityRank(severity) > severityRank(worst)
            ? severity
            : worst;
        },
        null
      );

      const verdict = evaluateAttention(
        {
          status: elevator.status,
          nextMaintenance: elevator.nextMaintenance,
          openWorkOrders: workOrders.filter(
            (w) =>
              w.elevatorId === elevator.id &&
              (OPEN_WORK_ORDER_STATUSES as readonly string[]).includes(w.status)
          ).length,
          openIncidents: incidents.filter(
            (i) =>
              i.elevatorId === elevator.id &&
              (OPEN_INCIDENT_STATUSES as readonly string[]).includes(i.status)
          ).length,
          activeAlerts: unitAlerts.length,
          worstAlertSeverity,
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

    const position = readCoordinates(building);

    if (!position || mapped.length === 0) {
      unlocated.push({
        id: building.id,
        name: building.name,
        address: building.address,
        city: building.city,
        elevatorCount: mapped.length,
        reason: position ? "no-elevators" : "no-coordinates",
      });
      if (!position) elevatorsUnlocated += mapped.length;
      continue;
    }

    levels.push(...mapped.map((e) => e.level));

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
      level: mapped.reduce<AttentionLevel>(
        (worst, e) => worstAttention(worst, e.level),
        "NORMAL"
      ),
      elevatorCount: mapped.length,
      needsAttention: mapped.filter((e) => e.level !== "NORMAL").length,
      elevators: mapped,
    });
  }

  return {
    sites,
    unlocated,
    totals: {
      sites: buildings.length,
      sitesLocated: sites.length,
      sitesUnlocated: unlocated.length,
      elevators: elevators.filter((e) => e.isActive).length,
      elevatorsUnlocated,
      byLevel: countAttention(levels),
    },
    generatedAt: now.toISOString(),
  };
}
