/**
 * Demo-data response builders.
 *
 * One function per read endpoint, each returning exactly the JSON body that
 * endpoint's real implementation produces. Keeping them separate means the
 * fixtures are shaped to the *contract* the UI already depends on, rather than
 * to the database rows — which is what makes them drop-in.
 *
 * Filters mirror the query parameters the real routes honour, so the UI's
 * filtering controls behave the same against fixture data.
 */

import { demoWorld } from "./dataset";
import { presentErrorCode } from "@/lib/incidents/error-codes";
import { DISPATCHABLE_TECHNICIAN_STATUSES } from "@/types";
import type {
  Alert,
  Building,
  Elevator,
  ErrorCode,
  IncidentReport,
  TelemetrySnapshot,
  WorkOrder,
} from "@prisma/client";

// ─── Ordering tables ────────────────────────────────────────
//
// Postgres sorts enums by declaration order, which the real routes rely on
// (`orderBy: { status: "asc" }` listing healthy units first). Spelled out here
// so the fixtures sort the same way.

const ELEVATOR_STATUS_ORDER = [
  "OPERATIONAL",
  "SERVICE_REQUIRED",
  "ANOMALY_DETECTED",
  "CRITICAL_SHUTDOWN",
  "OFFLINE",
] as const;

const WORK_ORDER_PRIORITY_ORDER = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "EMERGENCY",
  "CRITICAL",
] as const;

const RISK_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

const statusRank = (s: string) =>
  ELEVATOR_STATUS_ORDER.indexOf(s as (typeof ELEVATOR_STATUS_ORDER)[number]);
const priorityRank = (p: string) =>
  WORK_ORDER_PRIORITY_ORDER.indexOf(
    p as (typeof WORK_ORDER_PRIORITY_ORDER)[number]
  );
const riskRank = (r: string) =>
  RISK_ORDER.indexOf(r as (typeof RISK_ORDER)[number]);

const byDesc = <T>(pick: (item: T) => number) =>
  (a: T, b: T) => pick(b) - pick(a);

// ─── Shared shapes ──────────────────────────────────────────

type ElevatorWithRelations = Elevator & {
  building: { id: string; name: string; address: string };
  latestTelemetry: TelemetrySnapshot | null;
  _count: { workOrders: number; alerts: number };
};

function buildingById(id: string): Building {
  const found = demoWorld().buildings.find((b) => b.id === id);
  if (!found) throw new Error(`[demo] unknown building ${id}`);
  return found;
}

// ─── GET /api/dashboard ─────────────────────────────────────

export function demoDashboard() {
  const { buildings, elevators, alerts, workOrders, telemetry } = demoWorld();
  const now = Date.now();

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

  const OPEN_STATUSES = ["OPEN", "ASSIGNED", "IN_PROGRESS", "ON_HOLD"];

  const openWorkOrders = workOrders.filter((w) =>
    OPEN_STATUSES.includes(w.status)
  ).length;
  const emergencyWorkOrders = workOrders.filter(
    (w) =>
      OPEN_STATUSES.includes(w.status) &&
      (w.priority === "EMERGENCY" || w.priority === "CRITICAL")
  ).length;

  const buildingHealth = buildings.map((b) => {
    const units = elevators.filter((e) => e.buildingId === b.id && e.isActive);
    return {
      id: b.id,
      name: b.name,
      elevators: units.length,
      health:
        units.length > 0
          ? Math.round(
              units.reduce((sum, e) => sum + e.overallHealth, 0) / units.length
            )
          : 0,
    };
  });

  // Newest reading anywhere in the fleet, and that unit's recent history —
  // the same selection the real handler makes.
  const newest = [...telemetry].sort(
    (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
  )[0];

  let telemetryFeed: {
    elevatorId: string;
    elevatorCode: string;
    lastReadingAt: Date;
    points: Array<{
      timestamp: Date;
      motorVibrationMmS: number | null;
      motorTemperatureC: number | null;
      cabinLoadKg: number | null;
    }>;
  } | null = null;

  if (newest) {
    const unit = elevators.find((e) => e.id === newest.elevatorId);
    if (unit) {
      const points = telemetry
        .filter((t) => t.elevatorId === unit.id)
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, 30)
        .map((t) => ({
          timestamp: t.timestamp,
          motorVibrationMmS: t.motorVibrationMmS,
          motorTemperatureC: t.motorTemperatureC,
          cabinLoadKg: t.cabinLoadKg,
        }))
        // Oldest first so the chart reads left-to-right in time order.
        .reverse();

      telemetryFeed = {
        elevatorId: unit.id,
        elevatorCode: unit.elevatorCode,
        lastReadingAt: newest.timestamp,
        points,
      };
    }
  }

  const recentAlerts = alerts
    .filter((a) => a.resolvedAt === null && a.createdAt.getTime() <= now)
    .sort(byDesc<Alert>((a) => a.createdAt.getTime()))
    .slice(0, 8)
    .map((a) => ({
      id: a.id,
      elevator: elevators.find((e) => e.id === a.elevatorId)?.elevatorCode ?? "—",
      message: a.message,
      severity: a.severity,
      createdAt: a.createdAt,
      acknowledged: a.isAcknowledged,
    }));

  return {
    telemetryFeed,
    stats: {
      totalBuildings: buildings.length,
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
    recentAlerts,
  };
}

// ─── GET /api/elevators ─────────────────────────────────────

export function demoElevatorList(): ElevatorWithRelations[] {
  const { elevators, snapshots, workOrders, alerts } = demoWorld();
  const OPEN_STATUSES = ["OPEN", "ASSIGNED", "IN_PROGRESS"];

  return elevators
    .filter((e) => e.isActive)
    .map((e) => {
      const b = buildingById(e.buildingId);
      return {
        ...e,
        building: { id: b.id, name: b.name, address: b.address },
        latestTelemetry:
          snapshots.find((s) => s.elevatorId === e.id) ?? null,
        _count: {
          workOrders: workOrders.filter(
            (w) => w.elevatorId === e.id && OPEN_STATUSES.includes(w.status)
          ).length,
          alerts: alerts.filter(
            (a) => a.elevatorId === e.id && !a.isAcknowledged && a.resolvedAt === null
          ).length,
        },
      };
    })
    .sort(
      (a, b) =>
        statusRank(a.status) - statusRank(b.status) ||
        a.elevatorCode.localeCompare(b.elevatorCode)
    );
}

// ─── GET /api/elevators/[id] ────────────────────────────────

export function demoElevatorDetail(id: string): unknown | null {
  const { elevators, components, snapshots, telemetry, scores, workOrders, alerts, users } =
    demoWorld();

  const elevator = elevators.find((e) => e.id === id && e.isActive);
  if (!elevator) return null;

  return {
    ...elevator,
    building: buildingById(elevator.buildingId),
    components: components
      .filter((c) => c.elevatorId === id && c.isActive)
      .sort((a, b) => a.remainingUsefulLife - b.remainingUsefulLife),
    latestTelemetry: snapshots.find((s) => s.elevatorId === id) ?? null,
    telemetryStreams: telemetry
      .filter((t) => t.elevatorId === id)
      .sort(byDesc((t) => t.timestamp.getTime()))
      .slice(0, 60),
    predictiveScores: scores
      .filter((s) => s.elevatorId === id)
      .sort(byDesc((s) => s.updatedAt.getTime())),
    workOrders: workOrders
      .filter((w) => w.elevatorId === id)
      .sort(byDesc((w) => w.createdAt.getTime()))
      .slice(0, 10)
      .map((w) => ({
        ...w,
        assignedTo: w.assignedToId
          ? { name: users.find((u) => u.id === w.assignedToId)?.name ?? null }
          : null,
      })),
    alerts: alerts
      .filter((a) => a.elevatorId === id)
      .sort(byDesc((a) => a.createdAt.getTime()))
      .slice(0, 10),
  };
}

// ─── GET /api/alerts ────────────────────────────────────────

export function demoAlerts(filters: {
  elevatorId?: string | null;
  severity?: string | null;
  acknowledged?: boolean | null;
  resolved?: boolean | null;
  limit: number;
  skip: number;
}) {
  const { alerts, elevators, buildings } = demoWorld();

  const filtered = alerts
    .filter((a) => (filters.elevatorId ? a.elevatorId === filters.elevatorId : true))
    .filter((a) => (filters.severity ? a.severity === filters.severity : true))
    .filter((a) =>
      filters.acknowledged !== null && filters.acknowledged !== undefined
        ? a.isAcknowledged === filters.acknowledged
        : true
    )
    .filter((a) =>
      filters.resolved !== null && filters.resolved !== undefined
        ? filters.resolved
          ? a.resolvedAt !== null
          : a.resolvedAt === null
        : true
    )
    .sort(byDesc<Alert>((a) => a.createdAt.getTime()));

  const page = filtered.slice(filters.skip, filters.skip + filters.limit);

  const data = page.map((a) => {
    const unit = elevators.find((e) => e.id === a.elevatorId);
    return {
      ...a,
      elevator: {
        id: a.elevatorId,
        elevatorCode: unit?.elevatorCode ?? "—",
        status: unit?.status ?? "OFFLINE",
        building: { name: unit ? buildingById(unit.buildingId).name : "—" },
      },
    };
  });

  const total = filtered.length;
  const limit = Math.max(1, filters.limit);

  return {
    data,
    // Kept at the top level for the sidebar's unread badge.
    total,
    pagination: {
      total,
      page: Math.floor(filters.skip / limit) + 1,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

// ─── GET /api/work-orders ───────────────────────────────────

/**
 * The escalation behind a work order, in the shape the route's include
 * produces. `workOrderId` is unique on `IncidentReport`, so at most one
 * incident can match a given order.
 */
function incidentForWorkOrder(
  incidents: IncidentReport[],
  errorCodes: ErrorCode[],
  workOrderId: string
) {
  const incident = incidents.find((i) => i.workOrderId === workOrderId);
  if (!incident) return null;

  const code = errorCodes.find((e) => e.id === incident.errorCodeId);
  return {
    id: incident.id,
    incidentNumber: incident.incidentNumber,
    status: incident.status,
    isDirectTransfer: incident.isDirectTransfer,
    errorCode: code ? { code: code.code, title: code.title } : null,
  };
}

const WORK_ORDER_INCLUDE = (wo: WorkOrder) => {
  const { elevators, buildings, users, components, incidents, errorCodes } =
    demoWorld();
  const unit = elevators.find((e) => e.id === wo.elevatorId);
  const component = wo.componentId
    ? components.find((c) => c.id === wo.componentId)
    : undefined;
  const assignee = wo.assignedToId
    ? users.find((u) => u.id === wo.assignedToId)
    : undefined;

  return {
    ...wo,
    elevator: {
      id: wo.elevatorId,
      elevatorCode: unit?.elevatorCode ?? "—",
      building: { name: unit ? buildingById(unit.buildingId).name : "—" },
    },
    assignedTo: assignee
      ? { id: assignee.id, name: assignee.name, email: assignee.email }
      : null,
    component: component
      ? { name: component.name, componentType: component.componentType }
      : null,
    // Mirrors the route's include: the escalation this order came from, if
    // any, so the board renders identically whether the data is live or
    // fixture-backed.
    incident: incidentForWorkOrder(incidents, errorCodes, wo.id),
  };
};

export function demoWorkOrders(filters: {
  status?: string | null;
  priority?: string | null;
  type?: string | null;
  elevatorId?: string | null;
  assignedToId?: string | null;
  limit: number;
  skip: number;
}) {
  const { workOrders } = demoWorld();

  const filtered = workOrders
    .filter((w) => (filters.status ? w.status === filters.status : true))
    .filter((w) => (filters.priority ? w.priority === filters.priority : true))
    .filter((w) => (filters.type ? w.type === filters.type : true))
    .filter((w) => (filters.elevatorId ? w.elevatorId === filters.elevatorId : true))
    .filter((w) =>
      filters.assignedToId ? w.assignedToId === filters.assignedToId : true
    )
    .sort(
      (a, b) =>
        priorityRank(b.priority) - priorityRank(a.priority) ||
        b.createdAt.getTime() - a.createdAt.getTime()
    );

  const limit = Math.max(1, filters.limit);
  const total = filtered.length;

  return {
    data: filtered.slice(filters.skip, filters.skip + limit).map(WORK_ORDER_INCLUDE),
    pagination: {
      total,
      page: Math.floor(filters.skip / limit) + 1,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

// ─── GET /api/technician ────────────────────────────────────

export function demoTechnician(requestedId: string | null) {
  const { users, workOrders, elevators, buildings, components } = demoWorld();

  const technician =
    (requestedId ? users.find((u) => u.id === requestedId) : undefined) ??
    users.find((u) => u.role === "FIELD_TECHNICIAN" && u.isActive);

  if (!technician) {
    return { technician: null, active: [], completedToday: [] };
  }

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const describe = (wo: WorkOrder) => {
    const unit = elevators.find((e) => e.id === wo.elevatorId);
    const building = unit ? buildingById(unit.buildingId) : null;
    return {
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
      elevator: unit?.elevatorCode ?? "—",
      building: building?.name ?? "—",
      address: building?.address ?? "—",
      component: wo.componentId
        ? (components.find((c) => c.id === wo.componentId)?.name ?? null)
        : null,
      inspection: null,
    };
  };

  const active = workOrders
    .filter(
      (w) =>
        w.assignedToId === technician.id &&
        ["ASSIGNED", "IN_PROGRESS", "ON_HOLD"].includes(w.status)
    )
    .sort(
      (a, b) =>
        priorityRank(b.priority) - priorityRank(a.priority) ||
        (a.scheduledDate?.getTime() ?? Infinity) -
          (b.scheduledDate?.getTime() ?? Infinity)
    )
    .map(describe);

  const completedToday = workOrders
    .filter(
      (w) =>
        w.assignedToId === technician.id &&
        w.status === "COMPLETED" &&
        w.completedAt !== null &&
        w.completedAt.getTime() >= startOfToday.getTime()
    )
    .sort(byDesc((w) => w.completedAt?.getTime() ?? 0))
    .map((wo) => ({
      id: wo.id,
      orderNumber: wo.orderNumber,
      title: wo.title,
      elevator: elevators.find((e) => e.id === wo.elevatorId)?.elevatorCode ?? "—",
      completedAt: wo.completedAt,
      actualHours: wo.actualHours,
    }));

  return {
    technician: {
      id: technician.id,
      name: technician.name,
      email: technician.email,
      phone: technician.phone,
      role: technician.role,
    },
    active,
    completedToday,
  };
}

// ─── GET /api/predictive ────────────────────────────────────

export function demoPredictiveScores(filters: {
  elevatorId?: string | null;
  riskLevel?: string | null;
}) {
  const { scores, elevators, components } = demoWorld();

  const filtered = scores
    .filter((s) => (filters.elevatorId ? s.elevatorId === filters.elevatorId : true))
    .filter((s) => (filters.riskLevel ? s.riskLevel === filters.riskLevel : true))
    .sort(byDesc((s) => s.riskScore));

  // `?elevatorId=` returns component-level rows; the fleet view returns one
  // row per elevator — its worst-scoring component.
  if (filters.elevatorId) {
    return filtered.map((s) => ({
      ...s,
      component: s.componentId
        ? (() => {
            const c = components.find((x) => x.id === s.componentId);
            return c
              ? { id: c.id, name: c.name, componentType: c.componentType }
              : null;
          })()
        : null,
    }));
  }

  const worstPerElevator = new Map<string, (typeof filtered)[number]>();
  for (const score of filtered) {
    // Sorted worst-first, so the first row seen for an elevator wins.
    if (!worstPerElevator.has(score.elevatorId)) {
      worstPerElevator.set(score.elevatorId, score);
    }
  }

  return [...worstPerElevator.values()]
    .map((s) => {
      const unit = elevators.find((e) => e.id === s.elevatorId);
      return {
        ...s,
        elevator: {
          id: s.elevatorId,
          elevatorCode: unit?.elevatorCode ?? "—",
          status: unit?.status ?? "OFFLINE",
          overallHealth: unit?.overallHealth ?? 0,
          building: { name: unit ? buildingById(unit.buildingId).name : "—" },
        },
      };
    })
    .sort((a, b) => riskRank(b.riskLevel) - riskRank(a.riskLevel));
}

// ─── GET /api/telemetry ─────────────────────────────────────

export function demoTelemetry(filters: {
  elevatorId?: string | null;
  limit: number;
}) {
  const { telemetry, snapshots, elevators } = demoWorld();

  if (filters.elevatorId) {
    return telemetry
      .filter((t) => t.elevatorId === filters.elevatorId)
      .sort(byDesc((t) => t.timestamp.getTime()))
      .slice(0, filters.limit);
  }

  return snapshots
    .map((s) => {
      const unit = elevators.find((e) => e.id === s.elevatorId);
      return {
        ...s,
        elevator: {
          id: s.elevatorId,
          elevatorCode: unit?.elevatorCode ?? "—",
          status: unit?.status ?? "OFFLINE",
          overallHealth: unit?.overallHealth ?? 0,
          building: { name: unit ? buildingById(unit.buildingId).name : "—" },
        },
      };
    })
    .sort(byDesc((s) => s.lastUpdated.getTime()));
}

// ─── GET /api/error-codes ───────────────────────────────────

/**
 * Mirrors the real lookup including the ranking: an exact code match sorts
 * ahead of the fuzzy ones, so typing "E-101" in the wizard puts the code the
 * occupant is actually staring at at the top of the list.
 */
export function demoErrorCodes(query?: string | null) {
  const { errorCodes } = demoWorld();
  const q = query?.trim().toLowerCase();

  const matched = errorCodes
    .filter((e) => e.isActive)
    .filter((e) =>
      q
        ? e.code.toLowerCase().includes(q) ||
          e.title.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q)
        : true
    )
    .sort((a, b) => {
      if (q) {
        const aExact = a.code.toLowerCase() === q ? 0 : 1;
        const bExact = b.code.toLowerCase() === q ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
      }
      return a.code.localeCompare(b.code);
    });

  return matched.map(presentErrorCode);
}

// ─── GET /api/incidents ─────────────────────────────────────

export function demoIncidents(filters: { status?: string | null }) {
  const { incidents, elevators, errorCodes, users, workOrders } = demoWorld();

  const rows = incidents
    .filter((i) => (filters.status ? i.status === filters.status : true))
    .sort(byDesc((i) => i.createdAt.getTime()))
    .map((incident) => {
      const unit = elevators.find((e) => e.id === incident.elevatorId);
      const building = unit ? buildingById(unit.buildingId) : null;
      const code = errorCodes.find((e) => e.id === incident.errorCodeId);
      const client = users.find((u) => u.id === incident.clientId);
      const technician = users.find((u) => u.id === incident.technicianId);
      const order = workOrders.find((w) => w.id === incident.workOrderId);

      return {
        id: incident.id,
        incidentNumber: incident.incidentNumber,
        status: incident.status,
        isDirectTransfer: incident.isDirectTransfer,
        notes: incident.notes,
        audioNoteUrl: incident.audioNoteUrl,
        resolvedAt: incident.resolvedAt,
        createdAt: incident.createdAt,
        updatedAt: incident.updatedAt,
        elevator: {
          id: unit?.id ?? "—",
          elevatorCode: unit?.elevatorCode ?? "—",
          model: unit?.model ?? "—",
          building: {
            id: building?.id ?? "—",
            name: building?.name ?? "—",
            address: building?.address ?? "—",
            city: building?.city ?? "—",
          },
        },
        errorCode: code ? { id: code.id, code: code.code, title: code.title } : null,
        client: client
          ? { id: client.id, name: client.name, email: client.email, phone: client.phone }
          : { id: incident.clientId, name: "—", email: "—", phone: null },
        technician: technician
          ? {
              id: technician.id,
              name: technician.name,
              email: technician.email,
              phone: technician.phone,
            }
          : null,
        workOrder: order
          ? {
              id: order.id,
              orderNumber: order.orderNumber,
              status: order.status,
              priority: order.priority,
            }
          : null,
      };
    });

  return { data: rows, total: rows.length, page: 1, limit: rows.length };
}

// ─── GET /api/technicians ───────────────────────────────────

/**
 * The dispatch roster: reachable field technicians with their current load.
 *
 * Mirrors the route exactly — same three filters (role, active, dispatchable
 * status) and the same least-loaded-first sort — so the dispatcher's list does
 * not reshuffle when the demo fallback engages. The status filter reads the
 * shared `DISPATCHABLE_TECHNICIAN_STATUSES` rather than repeating the pair.
 */
export function demoTechnicianRoster() {
  const { users, workOrders, incidents } = demoWorld();

  return users
    .filter(
      (u) =>
        u.role === "FIELD_TECHNICIAN" &&
        u.isActive &&
        DISPATCHABLE_TECHNICIAN_STATUSES.includes(u.status)
    )
    .map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      status: user.status,
      openWorkOrders: workOrders.filter(
        (w) =>
          w.assignedToId === user.id &&
          (w.status === "ASSIGNED" ||
            w.status === "IN_PROGRESS" ||
            w.status === "ON_HOLD")
      ).length,
      openIncidents: incidents.filter(
        (i) =>
          i.technicianId === user.id &&
          (i.status === "TECHNICIAN_ASSIGNED" || i.status === "IN_PROGRESS")
      ).length,
    }))
    .sort(
      (a, b) =>
        a.openWorkOrders + a.openIncidents - (b.openWorkOrders + b.openIncidents) ||
        a.name.localeCompare(b.name)
    );
}

// ─── GET /api/inspection-reports ────────────────────────────

/**
 * Inspection reports, derived from the demo world's completed work orders.
 *
 * WHY DERIVED RATHER THAN SEEDED
 * The demo world has no inspection-report rows — the model exists and the route
 * writes to it, but no fixture ever populated it. Rather than add a parallel
 * array of hand-written reports that could drift from the work orders they
 * claim to document, each completed order in the demo dataset is given the
 * report it would plausibly have produced. Every field then agrees with the
 * order, the elevator and the technician it belongs to, because they are read
 * from those rows.
 *
 * Deterministic: the outcome of a given line is a function of the order's
 * position in the list, so the same fixture renders identically on every
 * request. A demo that reshuffled its results on refresh would be showing a
 * bug the product does not have.
 */

const DEMO_CHECKLIST = [
  "Visual inspection of motor housing",
  "Temperature sensor calibration check",
  "Motor winding resistance test",
  "Cooling system inspection",
  "Brake assembly thermal check",
  "Controller error log extraction",
  "Test run after corrective action",
] as const;

type DemoCheckResult = "PASS" | "FAIL" | "NEEDS_ATTENTION" | "NOT_APPLICABLE";

/** Worst result wins, matching `overallResult` in the route. */
function worstResult(results: readonly DemoCheckResult[]): DemoCheckResult {
  if (results.some((r) => r === "FAIL")) return "FAIL";
  if (results.some((r) => r === "NEEDS_ATTENTION")) return "NEEDS_ATTENTION";
  if (results.every((r) => r === "NOT_APPLICABLE")) return "NOT_APPLICABLE";
  return "PASS";
}

/**
 * Built as `{ base, checkItems, workOrder, elevator }` rather than as one flat
 * object, because the three callers below need three different subsets of it —
 * the list drops the check items, the work-order lookup drops the relations,
 * and only the printable view needs all of it.
 */
function buildInspectionReports() {
  const { workOrders, elevators, users } = demoWorld();

  const completed = workOrders
    .filter((w) => w.status === "COMPLETED" && w.completedAt !== null)
    .sort((a, b) => b.completedAt!.getTime() - a.completedAt!.getTime());

  return completed.map((order, index) => {
    const unit = elevators.find((e) => e.id === order.elevatorId);
    const building = unit ? buildingById(unit.buildingId) : null;
    const technician = order.assignedToId
      ? users.find((u) => u.id === order.assignedToId)
      : undefined;

    // One order in three carries a finding — enough that the failure paths
    // (red badge, corrective follow-up) are visible without every report
    // looking like an incident.
    const finding: DemoCheckResult =
      index % 3 === 1 ? "NEEDS_ATTENTION" : index % 5 === 3 ? "FAIL" : "PASS";

    const checkItems = DEMO_CHECKLIST.map((checkName, i) => {
      const isFindingLine = i === 4;
      const isNaLine = i === 6 && index % 4 === 2;
      return {
        id: `inchi_${order.id}_${i + 1}`,
        checkName,
        result: (isNaLine
          ? "NOT_APPLICABLE"
          : isFindingLine
            ? finding
            : "PASS") as DemoCheckResult,
        notes:
          isFindingLine && finding !== "PASS"
            ? "Recorded during the visit — see the attached photo."
            : null,
        measuredValue: i === 2 ? 11.2 + (index % 5) * 0.35 : null,
        unit: i === 2 ? "Ω" : null,
        // The one line a finding was recorded on carries evidence. The host is
        // deliberately a placeholder: this is a fixture, and a URL that looked
        // like a real photograph's would imply a site that does not exist.
        photoUrl:
          isFindingLine && finding !== "PASS"
            ? `https://photos.example.com/${order.orderNumber}/check-${i + 1}.jpg`
            : null,
      };
    });

    const submittedAt = order.completedAt as Date;
    const reportNumber = `RPT-${submittedAt.getUTCFullYear()}-${String(
      1001 + index
    ).padStart(4, "0")}`;

    return {
      id: `insp_${order.id}`,
      workOrderId: order.id,
      checkItems,
      workOrder: {
        id: order.id,
        orderNumber: order.orderNumber,
        title: order.title,
        type: order.type,
        priority: order.priority,
        status: order.status,
        completedAt: order.completedAt,
      },
      elevator: {
        id: unit?.id ?? "—",
        elevatorCode: unit?.elevatorCode ?? "—",
        brand: unit?.brand ?? "—",
        model: unit?.model ?? "—",
        building: {
          name: building?.name ?? "—",
          address: building?.address ?? "—",
          city: building?.city ?? "—",
        },
      },
      base: {
        id: `insp_${order.id}`,
        reportNumber,
        title: `Inspection – ${order.title}`,
        summary:
          finding === "PASS"
            ? "All checks within tolerance. Unit returned to service."
            : finding === "FAIL"
              ? "A failed check was recorded and corrective work has been raised."
              : "One check needs attention; monitoring recommended at the next visit.",
        overallResult: worstResult(checkItems.map((c) => c.result)),
        submittedAt,
        workOrderId: order.id,
        // Typed, not drawn: a fixture cannot produce a stroke. The printable
        // view renders the name in place of an image, which is the same path a
        // real report takes when a technician typed rather than signed.
        signatures: technician
          ? [
              {
                role: "TECHNICIAN",
                name: technician.name,
                method: "TYPED",
                signedAt: submittedAt.toISOString(),
              },
            ]
          : null,
        technician: technician
          ? { id: technician.id, name: technician.name }
          : { id: "—", name: null },
      },
    };
  });
}

/** `GET /api/inspection-reports?id=` — one report, in the printable view's shape. */
export function demoInspectionReportById(id: string) {
  const report = buildInspectionReports().find((r) => r.base.id === id);
  if (!report) return null;

  return {
    ...report.base,
    checkItems: report.checkItems,
    workOrder: report.workOrder,
    elevator: report.elevator,
  };
}

/** `GET /api/inspection-reports?workOrderId=` — the report for one job. */
export function demoInspectionReportForWorkOrder(workOrderId: string) {
  const report = buildInspectionReports().find(
    (r) => r.workOrderId === workOrderId
  );
  if (!report) return null;

  // The route's select for this branch takes the report without its `workOrder`
  // and `elevator` relations, unlike the `?id=` lookup above.
  return { ...report.base, checkItems: report.checkItems };
}

/** `GET /api/inspection-reports` — the paginated list. */
export function demoInspectionReports(filters: { limit: number; skip: number }) {
  const all = buildInspectionReports();
  const limit = Math.max(1, filters.limit);

  return {
    // The list endpoint drops `checkItems` from its select — a row is
    // summarised, not rendered — so the fixture drops them too.
    data: all
      .slice(filters.skip, filters.skip + limit)
      .map((report) => ({ ...report.base, checkItems: [] })),
    total: all.length,
    page: Math.floor(filters.skip / limit) + 1,
    limit,
  };
}

// ─── GET /api/notifications ─────────────────────────────────

export function demoNotifications() {
  const { notifications } = demoWorld();

  // The real endpoint serves the caller's own rows. Fixtures cannot know who
  // is asking (open-access mode has no real session), so they serve the
  // manager's mailbox — the one that actually receives escalations — and
  // report the unread count over the same set.
  const mine = notifications
    .filter((n) => n.userId === "usr_mgr")
    .sort(byDesc((n) => n.createdAt.getTime()));

  return {
    data: mine,
    total: mine.length,
    unread: mine.filter((n) => !n.isRead).length,
    page: 1,
    limit: mine.length,
  };
}
