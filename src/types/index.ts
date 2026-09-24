// ─── Core Domain Types ──────────────────────────────────────
// Local definitions mirroring the Prisma enums, so the frontend and the
// runtime validators type-check even before `prisma generate` has run.
//
// Each enum is declared once as an `as const` tuple and the union type is
// derived from it. This gives a single source of truth that can be used both
// as a TypeScript type and as a Zod `z.enum(...)` argument at runtime —
// previously the string unions existed only at compile time and every route
// hand-copied the same list of literals into its own schema, so the two could
// (and did) drift.

export const USER_ROLES = [
  "ADMIN",
  "MAINTENANCE_MANAGER",
  "FIELD_TECHNICIAN",
  "BUILDING_OWNER",
] as const;
export type UserRole = (typeof USER_ROLES)[number];

// Role groupings. These live here rather than in `lib/api/guard.ts` because
// the guard module is server-only (it pulls in NextAuth and Prisma), while the
// sidebar needs the same lists *inside a client component*. Importing them from
// the guard would have dragged the Prisma client into the browser bundle.
// `guard.ts` re-exports these, so server-side call sites are unchanged.

/** Roles that operate on the fleet. A BUILDING_OWNER is view-only. */
export const OPS_ROLES: readonly UserRole[] = [
  "ADMIN",
  "MAINTENANCE_MANAGER",
  "FIELD_TECHNICIAN",
];

/** Roles allowed to approve, schedule and run fleet-wide analysis. */
export const MANAGEMENT_ROLES: readonly UserRole[] = [
  "ADMIN",
  "MAINTENANCE_MANAGER",
];

/**
 * Roles that may be recorded as the owner of a building.
 *
 * Ownership is not cosmetic: it is the column every BUILDING_OWNER read scope
 * filters on (see `buildingScopeFor` in `lib/api/guard.ts`). ADMIN is included
 * so a single-tenant deployment can hold a portfolio without a second
 * account.
 */
export const OWNER_ELIGIBLE_ROLES: readonly UserRole[] = [
  "BUILDING_OWNER",
  "ADMIN",
];

export const SLA_TIERS = [
  "BASIC",
  "STANDARD",
  "PREMIUM",
  "ENTERPRISE",
] as const;
export type SLATier = (typeof SLA_TIERS)[number];

export const ELEVATOR_STATUSES = [
  "OPERATIONAL",
  "SERVICE_REQUIRED",
  "ANOMALY_DETECTED",
  "CRITICAL_SHUTDOWN",
  "OFFLINE",
] as const;
export type ElevatorStatus = (typeof ELEVATOR_STATUSES)[number];

export const ELEVATOR_BRANDS = [
  "OTIS",
  "SCHINDLER",
  "THYSSENKRUPP",
  "MITSUBISHI",
  "HITACHI",
  "KONE",
  "OTHER",
] as const;
export type ElevatorBrand = (typeof ELEVATOR_BRANDS)[number];

export const MOTOR_TYPES = [
  "AC_GEARED",
  "AC_GEARDLESS",
  "DC_GEARED",
  "HYDRAULIC",
  "OTHER",
] as const;
export type MotorType = (typeof MOTOR_TYPES)[number];

export const CONTROLLER_TYPES = [
  "MICROPROCESSOR",
  "PLC",
  "RELAY_LOGIC",
  "FULLY_DIGITAL",
  "OTHER",
] as const;
export type ControllerType = (typeof CONTROLLER_TYPES)[number];

export const MAINTENANCE_FREQUENCIES = [
  "WEEKLY",
  "BIWEEKLY",
  "MONTHLY",
  "QUARTERLY",
  "SEMI_ANNUAL",
  "ANNUAL",
  "BY_USAGE_CYCLES",
] as const;
export type MaintenanceFrequency = (typeof MAINTENANCE_FREQUENCIES)[number];

export const WORK_ORDER_STATUSES = [
  "OPEN",
  "ASSIGNED",
  "IN_PROGRESS",
  "ON_HOLD",
  "COMPLETED",
  "CANCELLED",
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

/**
 * Declared in ascending severity — this order is relied upon by the
 * `orderBy: { priority: "desc" }` sort in the work-orders API, because
 * PostgreSQL orders enums by declaration order.
 */
export const WORK_ORDER_PRIORITIES = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "EMERGENCY",
  "CRITICAL",
] as const;
export type WorkOrderPriority = (typeof WORK_ORDER_PRIORITIES)[number];

export const WORK_ORDER_TYPES = [
  "PREVENTIVE",
  "PREDICTIVE",
  "CORRECTIVE",
  "EMERGENCY",
  "INSPECTION",
] as const;
export type WorkOrderType = (typeof WORK_ORDER_TYPES)[number];

export const ALERT_SEVERITIES = [
  "INFO",
  "WARNING",
  "ANOMALY",
  "CRITICAL",
  "EMERGENCY",
] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const COMPONENT_TYPES = [
  "TRACTION_MOTOR",
  "BRAKE_ASSEMBLY",
  "DOOR_OPERATOR",
  "STEEL_ROPES",
  "GUIDE_SHOES",
  "CONTROLLER_BOARD",
  "COUNTERWEIGHT",
  "CABIN",
  "HYDRAULIC_UNIT",
  "SAFETY_GEAR",
  "BUFFER",
  "OTHER",
] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

export const INSPECTION_CHECK_RESULTS = [
  "PASS",
  "FAIL",
  "NEEDS_ATTENTION",
  "NOT_APPLICABLE",
] as const;
export type InspectionCheckResult = (typeof INSPECTION_CHECK_RESULTS)[number];

export const TECHNICIAN_STATUSES = [
  "AVAILABLE",
  "ON_JOB",
  "OFF_DUTY",
  "ON_LEAVE",
] as const;
export type TechnicianStatus = (typeof TECHNICIAN_STATUSES)[number];

/**
 * The statuses a dispatcher may hand work to.
 *
 * `ON_JOB` is included deliberately: a technician already on a job is still
 * queued behind it, which is what dispatching to them means. `OFF_DUTY` and
 * `ON_LEAVE` are not — those are people who are not at work, and a roster that
 * offers them produces a dispatch nobody answers.
 *
 * Exported from here rather than written inline at each call site so the
 * roster route, the demo fixture and the dispatch modal cannot disagree about
 * who is reachable.
 */
export const DISPATCHABLE_TECHNICIAN_STATUSES: readonly TechnicianStatus[] = [
  "AVAILABLE",
  "ON_JOB",
];

export const PREDICTIVE_RISK_LEVELS = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
] as const;
export type PredictiveRiskLevel = (typeof PREDICTIVE_RISK_LEVELS)[number];

/**
 * Declared in *pipeline order*, matching the Prisma enum so that
 * `orderBy: { status: "asc" }` sorts by how far along a fault is rather than
 * alphabetically. `RESOLVED_BY_CLIENT` is last because it is a terminal state
 * reached outside the pipeline entirely — the customer fixed it themselves.
 */
export const INCIDENT_STATUSES = [
  "ESCALATED",
  "TECHNICIAN_ASSIGNED",
  "IN_PROGRESS",
  "CLOSED",
  "RESOLVED_BY_CLIENT",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/**
 * Statuses that mean the fault is still someone's outstanding problem.
 * Escalated and assigned incidents are *open*; a self-resolved one is not.
 */
export const OPEN_INCIDENT_STATUSES: readonly IncidentStatus[] = [
  "ESCALATED",
  "TECHNICIAN_ASSIGNED",
  "IN_PROGRESS",
];

// ─── Dashboard Types ────────────────────────────────────────

export interface FleetOverview {
  totalBuildings: number;
  totalElevators: number;
  operationalCount: number;
  serviceRequiredCount: number;
  anomalyCount: number;
  criticalCount: number;
  offlineCount: number;
  openWorkOrders: number;
  emergencyWorkOrders: number;
  avgHealth: number;
}

export interface BuildingWithElevators {
  id: string;
  name: string;
  address: string;
  slaTier: string;
  elevatorCount: number;
  avgHealth: number;
  statusBreakdown: Record<string, number>;
}

// ─── Telemetry Types ────────────────────────────────────────

export interface TelemetryDataPoint {
  timestamp: string;
  motorVibrationMmS: number | null;
  motorTemperatureC: number | null;
  doorCycleCount: number | null;
  doorSpeedMs: number | null;
  cabinLoadKg: number | null;
  levelingOffsetMm: number | null;
  operatingHours: number | null;
  brakeActuations: number | null;
  supplyVoltageV: number | null;
  currentDrawA: number | null;
}

export interface TelemetryIngestionPayload {
  elevatorCode: string;
  timestamp?: string;
  data: Partial<TelemetryDataPoint>;
}

export interface ThresholdAlert {
  elevatorId: string;
  elevatorCode: string;
  metricName: string;
  metricValue: number;
  severity: "INFO" | "WARNING" | "ANOMALY" | "CRITICAL" | "EMERGENCY";
  threshold: { min?: number; max?: number };
  message: string;
}

// ─── Predictive Types ───────────────────────────────────────

/**
 * How this analysis compares with the previous one for the same component.
 *
 * `new` means no prior score existed, which is not the same as `stable` — a
 * first-ever CRITICAL on a part nobody has scored before is news, and folding
 * it into "unchanged" would hide exactly that.
 */
export type RiskTrend = "new" | "improving" | "stable" | "worsening";

export interface RULResult {
  /** `ElevatorComponent.id` when the score came from a tracked component. */
  componentId: string | null;
  componentType: string;
  remainingUsefulLifePercent: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  riskScore: number;
  predictedFailureDate: Date | null;
  confidence: number;
  recommendations: string[];
  /**
   * The risk level this component carried at the previous analysis, or null
   * when it has never been scored before.
   */
  previousRiskLevel: PredictiveRiskLevel | null;
  /**
   * Direction of travel since that analysis. A component that is already HIGH
   * and rises to CRITICAL is the case this exists to surface: it holds an open
   * predictive work order already, so nothing new is raised for it and without
   * this it degrades in silence.
   */
  riskTrend: RiskTrend;
}

export interface PredictiveAnalysis {
  elevatorId: string;
  elevatorCode: string;
  overallHealth: number;
  overallRisk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  components: RULResult[];
  analyzedAt: Date;
}

// ─── Work Order Types ───────────────────────────────────────

export interface WorkOrderCreateInput {
  title: string;
  description?: string;
  type: "PREVENTIVE" | "PREDICTIVE" | "CORRECTIVE" | "EMERGENCY" | "INSPECTION";
  priority: "LOW" | "MEDIUM" | "HIGH" | "EMERGENCY" | "CRITICAL";
  elevatorId: string;
  componentId?: string;
  assignedToId?: string;
  scheduledDate?: string;
  estimatedHours?: number;
}

export interface TechnicianDispatch {
  workOrderId: string;
  technicianId: string;
  scheduledDate: Date;
}

// ─── IoT Simulator Types ────────────────────────────────────

export interface SimulatedElevator {
  id: string;
  code: string;
  brand: string;
  model: string;
  motorAge: number; // hours
  ropeAge: number;
  doorAge: number;
  vibrationBaseline: number;
  temperatureBaseline: number;
  isHealthy: boolean;
  degradationRate: number;
}
