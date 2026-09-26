/**
 * ElevatorPulse – In-memory demo dataset.
 *
 * WHAT THIS IS
 * A small, internally-consistent world (buildings, elevators, components,
 * telemetry, alerts, work orders, predictive scores) that lets the UI render
 * populated screens on a machine with no PostgreSQL. It is a development
 * convenience, not a feature: see `src/lib/demo/mode.ts` for the switch that
 * decides whether it is used at all.
 *
 * WHY IT IS TYPED AGAINST `@prisma/client`
 * Every entity here is declared as the generated Prisma model type. If the
 * schema moves, this file stops compiling — which is the point. Hand-rolled
 * interfaces would drift silently, and the first symptom would be a chart
 * reading `undefined` in the UI rather than a build error.
 *
 * DETERMINISM
 * Telemetry is generated from a seeded PRNG rather than `Math.random()`, so
 * reloading produces the same series instead of a chart that redraws itself
 * differently on every poll. Timestamps *are* relative to now (a fixed clock
 * would make every unit look stale an hour after the server started), and the
 * whole world is memoised for a few seconds so one page load — which fans out
 * into several API calls — sees one coherent snapshot.
 */

import type {
  Alert,
  Building,
  ControllerType,
  Elevator,
  ElevatorBrand,
  ElevatorComponent,
  ElevatorStatus,
  ErrorCode,
  IncidentReport,
  MotorType,
  Notification,
  PredictiveScore,
  TelemetrySnapshot,
  TelemetryStream,
  User,
  WorkOrder,
} from "@prisma/client";
import { ELEVATOR_ERROR_CODES } from "@/lib/incidents/error-code-catalogue";

// ─── Tunables ───────────────────────────────────────────────

const MINUTE = 60_000;

/** Points in each elevator's telemetry history, oldest to newest. */
const TELEMETRY_POINTS = 60;
/** Gap between consecutive readings. */
const TELEMETRY_INTERVAL_MINUTES = 5;
/** How long one generated world stays valid before it is rebuilt. */
const CACHE_TTL_MS = 5_000;

// ─── Seeded PRNG (mulberry32) ───────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Blueprints ─────────────────────────────────────────────

type SensorProfile = {
  vibration: number;
  temperature: number;
  load: number;
  /** Minutes before "now" of the newest reading. */
  stalenessMinutes: number;
  /** `false` = a unit that has stopped reporting (OFFLINE). */
  reporting: boolean;
};

// Enum fields are typed with the generated Prisma enums rather than
// re-spelled string unions. The hand-written versions of these had
// `AC_GEARLESS` against the schema's `AC_GEARDLESS` and omitted `RELAY_LOGIC`;
// only the generated types catch that at compile time.
type ElevatorBlueprint = {
  id: string;
  code: string;
  buildingId: string;
  brand: ElevatorBrand;
  model: string;
  motorType: MotorType;
  controllerType: ControllerType;
  status: ElevatorStatus;
  health: number;
  floors: number;
  payload: number;
  commissionedYearsAgo: number;
  profile: SensorProfile;
};

const ELEVATOR_BLUEPRINTS: readonly ElevatorBlueprint[] = [
  {
    id: "elv_1",
    code: "MPT-01",
    buildingId: "bld_1",
    brand: "OTIS",
    model: "Gen3 Nova",
    motorType: "AC_GEARDLESS",
    controllerType: "FULLY_DIGITAL",
    status: "OPERATIONAL",
    health: 94.2,
    floors: 22,
    payload: 1150,
    commissionedYearsAgo: 4,
    profile: { vibration: 2.1, temperature: 64, load: 320, stalenessMinutes: 2, reporting: true },
  },
  {
    id: "elv_2",
    code: "MPT-02",
    buildingId: "bld_1",
    brand: "SCHINDLER",
    model: "5500",
    motorType: "AC_GEARED",
    controllerType: "MICROPROCESSOR",
    status: "SERVICE_REQUIRED",
    health: 71.4,
    floors: 22,
    payload: 1000,
    commissionedYearsAgo: 9,
    profile: { vibration: 4.3, temperature: 78, load: 280, stalenessMinutes: 4, reporting: true },
  },
  {
    id: "elv_3",
    code: "MPT-03",
    buildingId: "bld_1",
    brand: "KONE",
    model: "MonoSpace 500",
    motorType: "AC_GEARDLESS",
    controllerType: "FULLY_DIGITAL",
    status: "ANOMALY_DETECTED",
    health: 58.1,
    floors: 18,
    payload: 800,
    commissionedYearsAgo: 12,
    profile: { vibration: 6.4, temperature: 84, load: 240, stalenessMinutes: 3, reporting: true },
  },
  {
    id: "elv_4",
    code: "RBC-01",
    buildingId: "bld_2",
    brand: "THYSSENKRUPP",
    model: "evolution 200",
    motorType: "AC_GEARDLESS",
    controllerType: "FULLY_DIGITAL",
    status: "OPERATIONAL",
    health: 97.6,
    floors: 14,
    payload: 1275,
    commissionedYearsAgo: 2,
    profile: { vibration: 1.8, temperature: 61, load: 410, stalenessMinutes: 1, reporting: true },
  },
  {
    id: "elv_5",
    code: "RBC-02",
    buildingId: "bld_2",
    brand: "MITSUBISHI",
    model: "NEXIEZ-MRL",
    motorType: "AC_GEARDLESS",
    controllerType: "MICROPROCESSOR",
    status: "OPERATIONAL",
    health: 88.3,
    floors: 14,
    payload: 1050,
    commissionedYearsAgo: 6,
    profile: { vibration: 2.6, temperature: 67, load: 300, stalenessMinutes: 6, reporting: true },
  },
  {
    id: "elv_6",
    code: "RBC-03",
    buildingId: "bld_2",
    brand: "OTIS",
    model: "GeN2 Core",
    motorType: "AC_GEARED",
    controllerType: "PLC",
    status: "CRITICAL_SHUTDOWN",
    health: 34.7,
    floors: 12,
    payload: 900,
    commissionedYearsAgo: 15,
    profile: { vibration: 9.6, temperature: 97, load: 180, stalenessMinutes: 9, reporting: true },
  },
  {
    id: "elv_7",
    code: "NGM-01",
    buildingId: "bld_3",
    brand: "KONE",
    model: "MonoSpace 300",
    motorType: "HYDRAULIC",
    controllerType: "MICROPROCESSOR",
    status: "OPERATIONAL",
    health: 91.5,
    floors: 6,
    payload: 1600,
    commissionedYearsAgo: 5,
    profile: { vibration: 2.3, temperature: 66, load: 520, stalenessMinutes: 5, reporting: true },
  },
  {
    id: "elv_8",
    code: "NGM-02",
    buildingId: "bld_3",
    brand: "SCHINDLER",
    model: "3300",
    motorType: "AC_GEARED",
    controllerType: "RELAY_LOGIC",
    status: "OFFLINE",
    health: 62.9,
    floors: 6,
    payload: 1000,
    commissionedYearsAgo: 17,
    // Stopped reporting two days ago — the realistic shape of an OFFLINE unit,
    // and a deliberate exercise of the null-metric paths in the charts.
    profile: { vibration: 0, temperature: 0, load: 0, stalenessMinutes: 2880, reporting: false },
  },
];

const COMPONENT_BLUEPRINTS: ReadonlyArray<{
  type:
    | "TRACTION_MOTOR"
    | "BRAKE_ASSEMBLY"
    | "DOOR_OPERATOR"
    | "STEEL_ROPES"
    | "GUIDE_SHOES"
    | "CONTROLLER_BOARD";
  name: string;
  life: number;
  /** Fraction of rated life consumed purely by component-specific wear. */
  wear: number;
  manufacturer: string;
}> = [
  { type: "TRACTION_MOTOR", name: "Moteur de traction", life: 60000, wear: 0.0, manufacturer: "Otis" },
  { type: "BRAKE_ASSEMBLY", name: "Ensemble de frein", life: 45000, wear: 0.08, manufacturer: "Mayr" },
  { type: "DOOR_OPERATOR", name: "Opérateur de porte", life: 40000, wear: 0.14, manufacturer: "Selcom" },
  { type: "STEEL_ROPES", name: "Câbles en acier", life: 50000, wear: 0.06, manufacturer: "Gustav Wolf" },
  { type: "GUIDE_SHOES", name: "Patins de guidage", life: 35000, wear: 0.18, manufacturer: "Wittur" },
  { type: "CONTROLLER_BOARD", name: "Carte de commande", life: 80000, wear: 0.03, manufacturer: "Kone" },
];

// ─── World ──────────────────────────────────────────────────

export interface DemoWorld {
  users: User[];
  buildings: Building[];
  elevators: Elevator[];
  components: ElevatorComponent[];
  telemetry: TelemetryStream[];
  snapshots: TelemetrySnapshot[];
  alerts: Alert[];
  workOrders: WorkOrder[];
  scores: PredictiveScore[];
  errorCodes: ErrorCode[];
  incidents: IncidentReport[];
  notifications: Notification[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function build(): DemoWorld {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo);
  const rng = mulberry32(0x5eed_1234);

  // ── Users ─────────────────────────────────────────────────
  // `passwordHash` is a real bcrypt hash of "password123" (cost 12) so that
  // these rows are also valid if they are ever loaded into a real database.
  const DEMO_HASH = "$2a$12$K8JrE0mHq3fQ5oJm6vP4UeYQ0qK1yWQ7mWJ8Yq3xN5zT2bV1cL0u";

  // `status` is the dispatch availability carried by `User.status`. It is
  // only meaningful for technicians; the other roles hold the default. One of
  // the three technicians is deliberately ON_LEAVE so the roster's filter is
  // visible in the fixtures rather than merely asserted — a demo where nobody
  // is ever unavailable cannot show that the filter works.
  // `clientType` is a required property of the `User` type — the column is
  // nullable in the schema, but a nullable field is still a *present* key on
  // the generated model type, and this array is typed against that model
  // rather than against a create input. Staff hold null: the distinction only
  // means anything for a client account. Both demo owners are contracted,
  // because both own buildings in the fixtures and a non-contracted owner with
  // a portfolio is the contradiction the admin screen warns about.
  const userSeed: Array<Omit<User, "createdAt" | "updatedAt">> = [
    { id: "usr_admin", email: "admin@elevatorpulse.com", name: "Dana Whitfield", passwordHash: DEMO_HASH, role: "ADMIN", clientType: null, phone: "+1 415 555 0101", avatarUrl: null, isActive: true, status: "AVAILABLE" },
    { id: "usr_mgr", email: "manager@elevatorpulse.com", name: "Marco Reyes", passwordHash: DEMO_HASH, role: "MAINTENANCE_MANAGER", clientType: null, phone: "+1 415 555 0102", avatarUrl: null, isActive: true, status: "AVAILABLE" },
    { id: "usr_tech1", email: "tech1@elevatorpulse.com", name: "Priya Nair", passwordHash: DEMO_HASH, role: "FIELD_TECHNICIAN", clientType: null, phone: "+1 415 555 0103", avatarUrl: null, isActive: true, status: "AVAILABLE" },
    { id: "usr_tech2", email: "tech2@elevatorpulse.com", name: "Sam Okafor", passwordHash: DEMO_HASH, role: "FIELD_TECHNICIAN", clientType: null, phone: "+1 415 555 0104", avatarUrl: null, isActive: true, status: "ON_JOB" },
    { id: "usr_tech3", email: "tech3@elevatorpulse.com", name: "Ilse Fontaine", passwordHash: DEMO_HASH, role: "FIELD_TECHNICIAN", clientType: null, phone: "+1 415 555 0107", avatarUrl: null, isActive: true, status: "ON_LEAVE" },
    { id: "usr_owner1", email: "owner@metroplaza.com", name: "Helena Voss", passwordHash: DEMO_HASH, role: "BUILDING_OWNER", clientType: "CONTRACTED", phone: "+1 415 555 0105", avatarUrl: null, isActive: true, status: "AVAILABLE" },
    { id: "usr_owner2", email: "owner@riverside.com", name: "Tomas Bergman", passwordHash: DEMO_HASH, role: "BUILDING_OWNER", clientType: "CONTRACTED", phone: "+1 415 555 0106", avatarUrl: null, isActive: true, status: "AVAILABLE" },
  ];

  const users: User[] = userSeed.map((u, i) => ({
    ...u,
    createdAt: iso(400 * 24 * 60 * MINUTE - i * 60 * MINUTE),
    updatedAt: iso(3 * 24 * 60 * MINUTE),
  }));

  // ── Buildings ─────────────────────────────────────────────
  const buildingSeed: Array<Omit<Building, "createdAt" | "updatedAt">> = [
    {
      id: "bld_1", name: "Metro Plaza Tower", address: "410 Market Street", city: "San Francisco",
      state: "CA", zipCode: "94105", country: "US", contactPerson: "Helena Voss",
      contactEmail: "owner@metroplaza.com", contactPhone: "+1 415 555 0105", slaTier: "PREMIUM",
      latitude: 37.7908, longitude: -122.4014, isActive: true, ownerId: "usr_owner1",
    },
    {
      id: "bld_2", name: "Riverside Business Center", address: "88 Embarcadero", city: "Oakland",
      state: "CA", zipCode: "94607", country: "US", contactPerson: "Tomas Bergman",
      contactEmail: "owner@riverside.com", contactPhone: "+1 415 555 0106", slaTier: "STANDARD",
      latitude: 37.7955, longitude: -122.2793, isActive: true, ownerId: "usr_owner2",
    },
    {
      id: "bld_3", name: "Northgate Medical Center", address: "1200 Northgate Drive", city: "Berkeley",
      state: "CA", zipCode: "94702", country: "US", contactPerson: "Dr. Amara Idowu",
      contactEmail: "facilities@northgate.example.org", contactPhone: "+1 415 555 0110",
      slaTier: "ENTERPRISE", latitude: 37.8715, longitude: -122.2730, isActive: true, ownerId: null,
    },
  ];

  const buildings: Building[] = buildingSeed.map((b, i) => ({
    ...b,
    createdAt: iso((900 - i * 30) * 24 * 60 * MINUTE),
    updatedAt: iso(12 * 60 * MINUTE),
  }));

  // ── Elevators ─────────────────────────────────────────────
  const elevators: Elevator[] = ELEVATOR_BLUEPRINTS.map((bp) => {
    const ageMs = bp.commissionedYearsAgo * 365 * 24 * 60 * MINUTE;
    const operatingHours = round1(bp.commissionedYearsAgo * 2600 + rng() * 400);
    return {
      id: bp.id,
      elevatorCode: bp.code,
      buildingId: bp.buildingId,
      brand: bp.brand,
      model: bp.model,
      serialNumber: `SN-${bp.code}-${1000 + Math.floor(rng() * 8999)}`,
      installationDate: iso(ageMs),
      motorType: bp.motorType,
      controllerType: bp.controllerType,
      maxPayloadKg: bp.payload,
      floorsServed: bp.floors,
      status: bp.status,
      operatingHours,
      doorCycleCount: Math.floor(operatingHours * 42),
      brakeActuations: Math.floor(operatingHours * 38),
      lastMaintenance: iso((30 + Math.floor(rng() * 40)) * 24 * 60 * MINUTE),
      nextMaintenance: new Date(now + (7 + Math.floor(rng() * 40)) * 24 * 60 * MINUTE),
      overallHealth: bp.health,
      isActive: true,
      createdAt: iso(ageMs),
      updatedAt: iso(20 * MINUTE),
    };
  });

  // ── Components ────────────────────────────────────────────
  const components: ElevatorComponent[] = [];
  for (const bp of ELEVATOR_BLUEPRINTS) {
    for (const cb of COMPONENT_BLUEPRINTS) {
      const rul = round1(clamp(bp.health - cb.wear * 110, 3, 99));
      components.push({
        id: `cmp_${bp.id}_${cb.type}`,
        elevatorId: bp.id,
        componentType: cb.type,
        name: cb.name,
        manufacturer: cb.manufacturer,
        partNumber: `${cb.type.slice(0, 3)}-${1000 + Math.floor(rng() * 8999)}`,
        installedDate: iso(bp.commissionedYearsAgo * 365 * 24 * 60 * MINUTE),
        expectedLifeHours: cb.life,
        currentLifeHours: round1(cb.life * (1 - rul / 100)),
        remainingUsefulLife: rul,
        isActive: true,
        createdAt: iso(bp.commissionedYearsAgo * 365 * 24 * 60 * MINUTE),
        updatedAt: iso(45 * MINUTE),
      });
    }
  }

  // ── Telemetry ─────────────────────────────────────────────
  const telemetry: TelemetryStream[] = [];
  const snapshots: TelemetrySnapshot[] = [];

  for (const bp of ELEVATOR_BLUEPRINTS) {
    const p = bp.profile;
    const newest = now - p.stalenessMinutes * MINUTE;
    let last: TelemetryStream | null = null;

    for (let i = 0; i < TELEMETRY_POINTS; i += 1) {
      // Oldest first; index 0 sits (POINTS-1) intervals before the newest.
      const offset = (TELEMETRY_POINTS - 1 - i) * TELEMETRY_INTERVAL_MINUTES * MINUTE;
      const timestamp = new Date(newest - offset);

      // A gentle upward drift toward "now" reads as a degrading unit rather
      // than noise, and gives the line chart a visible trend.
      const drift = (i / TELEMETRY_POINTS - 1) * 0.12;
      const jitter = () => (rng() - 0.5) * 0.14;

      const stream: TelemetryStream = {
        id: `tlm_${bp.id}_${i}`,
        elevatorId: bp.id,
        timestamp,
        motorVibrationMmS: p.reporting
          ? round1(Math.max(0.2, p.vibration * (1 + drift + jitter())))
          : null,
        motorTemperatureC: p.reporting
          ? round1(p.temperature * (1 + drift * 0.5 + jitter() * 0.4))
          : null,
        doorCycleCount: null,
        doorSpeedMs: p.reporting ? round1(1.6 + jitter() * 0.2) : null,
        cabinLoadKg: p.reporting ? round1(Math.max(0, p.load * (1 + jitter() * 1.6))) : null,
        levelingOffsetMm: p.reporting ? round1(jitter() * 4) : null,
        operatingHours: null,
        brakeActuations: null,
        supplyVoltageV: p.reporting ? round1(400 + jitter() * 12) : null,
        currentDrawA: p.reporting ? round1(18 + p.vibration * 1.4 + jitter() * 3) : null,
        metadata: null,
      };
      telemetry.push(stream);
      last = stream;
    }

    snapshots.push({
      id: `snp_${bp.id}`,
      elevatorId: bp.id,
      motorVibrationMmS: last?.motorVibrationMmS ?? null,
      motorTemperatureC: last?.motorTemperatureC ?? null,
      doorCycleCount: null,
      doorSpeedMs: last?.doorSpeedMs ?? null,
      cabinLoadKg: last?.cabinLoadKg ?? null,
      levelingOffsetMm: last?.levelingOffsetMm ?? null,
      operatingHours: null,
      brakeActuations: null,
      supplyVoltageV: last?.supplyVoltageV ?? null,
      currentDrawA: last?.currentDrawA ?? null,
      lastUpdated: last?.timestamp ?? iso(p.stalenessMinutes * MINUTE),
    });
  }

  // ── Alerts ────────────────────────────────────────────────
  const alertSeed: Array<{
    elevatorId: string;
    severity: "INFO" | "WARNING" | "ANOMALY" | "CRITICAL" | "EMERGENCY";
    title: string;
    message: string;
    metricName: string | null;
    metricValue: number | null;
    isAcknowledged: boolean;
    resolvedAt: Date | null;
    minutesAgo: number;
  }> = [
    { elevatorId: "elv_6", severity: "EMERGENCY", title: "Température moteur critique : RBC-03", message: "Température moteur 97,0 °C au-delà de la limite critique de 90 °C. Appareil arrêté.", metricName: "motor_temperature_c", metricValue: 97, isAcknowledged: false, resolvedAt: null, minutesAgo: 22 },
    { elevatorId: "elv_6", severity: "CRITICAL", title: "Vibration moteur critique : RBC-03", message: "Vibration moteur 9,6 mm/s au-delà de la limite critique de 8,0 mm/s.", metricName: "motor_vibration_mm_s", metricValue: 9.6, isAcknowledged: false, resolvedAt: null, minutesAgo: 26 },
    { elevatorId: "elv_3", severity: "ANOMALY", title: "Vibration moteur anormale : MPT-03", message: "Vibration en hausse à 6,4 mm/s, soit 156 % au-dessus de la référence sur 90 jours de l'appareil.", metricName: "motor_vibration_mm_s", metricValue: 6.4, isAcknowledged: false, resolvedAt: null, minutesAgo: 48 },
    { elevatorId: "elv_3", severity: "WARNING", title: "Température moteur élevée : MPT-03", message: "Température moteur 84,0 °C au-dessus du seuil d'avertissement de 80 °C.", metricName: "motor_temperature_c", metricValue: 84, isAcknowledged: false, resolvedAt: null, minutesAgo: 51 },
    { elevatorId: "elv_2", severity: "WARNING", title: "Écart de vitesse de porte : MPT-02", message: "Vitesse de porte 1,42 m/s en dessous du minimum de 1,50 m/s pour cette commande.", metricName: "door_speed_ms", metricValue: 1.42, isAcknowledged: false, resolvedAt: null, minutesAgo: 96 },
    { elevatorId: "elv_2", severity: "WARNING", title: "Vibration moteur élevée : MPT-02", message: "Vibration moteur 4,3 mm/s au-dessus du seuil d'avertissement de 4,0 mm/s.", metricName: "motor_vibration_mm_s", metricValue: 4.3, isAcknowledged: true, resolvedAt: null, minutesAgo: 180 },
    { elevatorId: "elv_8", severity: "CRITICAL", title: "Télémétrie perdue : NGM-02", message: "Aucun relevé reçu depuis 48 heures sur un appareil sous contrat ENTERPRISE.", metricName: null, metricValue: null, isAcknowledged: false, resolvedAt: null, minutesAgo: 2900 },
    { elevatorId: "elv_5", severity: "INFO", title: "Entretien à prévoir : RBC-02", message: "L'entretien préventif planifié est dû dans les 7 jours.", metricName: null, metricValue: null, isAcknowledged: true, resolvedAt: null, minutesAgo: 420 },
    { elevatorId: "elv_7", severity: "WARNING", title: "Charge cabine proche de la capacité : NGM-01", message: "Charge cabine maximale de 1 510 kg, soit 94 % de la capacité nominale.", metricName: "cabin_load_kg", metricValue: 1510, isAcknowledged: true, resolvedAt: iso(300 * MINUTE), minutesAgo: 540 },
    { elevatorId: "elv_1", severity: "INFO", title: "Cycles de porte normaux : MPT-01", message: "Nombre de cycles de porte dans la plage attendue sur les 30 derniers jours.", metricName: "door_cycle_count", metricValue: 41200, isAcknowledged: true, resolvedAt: iso(900 * MINUTE), minutesAgo: 1000 },
    { elevatorId: "elv_4", severity: "INFO", title: "Mise en service terminée : RBC-01", message: "Télémétrie de référence collectée ; le modèle prédictif est désormais calibré.", metricName: null, metricValue: null, isAcknowledged: true, resolvedAt: iso(1400 * MINUTE), minutesAgo: 1500 },
    { elevatorId: "elv_3", severity: "WARNING", title: "Dérive du nivellement : MPT-03", message: "Écart de nivellement moyen de 4,1 mm pour une tolérance de 3,0 mm.", metricName: "leveling_offset_mm", metricValue: 4.1, isAcknowledged: true, resolvedAt: iso(2000 * MINUTE), minutesAgo: 2100 },
  ];

  const alerts: Alert[] = alertSeed.map((a, i) => ({
    id: `alr_${i + 1}`,
    elevatorId: a.elevatorId,
    thresholdRuleId: null,
    severity: a.severity,
    title: a.title,
    message: a.message,
    metricName: a.metricName,
    metricValue: a.metricValue,
    isAcknowledged: a.isAcknowledged,
    acknowledgedBy: a.isAcknowledged ? "usr_mgr" : null,
    acknowledgedAt: a.isAcknowledged ? iso(a.minutesAgo - 5) : null,
    createdAt: iso(a.minutesAgo * MINUTE),
    resolvedAt: a.resolvedAt,
  }));

  // ── Work orders ───────────────────────────────────────────
  const workOrderSeed: Array<{
    elevatorId: string;
    title: string;
    description: string;
    type: "PREVENTIVE" | "PREDICTIVE" | "CORRECTIVE" | "EMERGENCY" | "INSPECTION";
    priority: "LOW" | "MEDIUM" | "HIGH" | "EMERGENCY" | "CRITICAL";
    status: "OPEN" | "ASSIGNED" | "IN_PROGRESS" | "ON_HOLD" | "COMPLETED" | "CANCELLED";
    assignedToId: string | null;
    componentType: string | null;
    estimatedHours: number | null;
    actualHours: number | null;
    scheduledInDays: number | null;
    completedHoursAgo: number | null;
  }> = [
    { elevatorId: "elv_6", title: "URGENCE : arrêt sur surchauffe moteur", description: "Appareil arrêté sur une température moteur critique à 97 °C. Vérifier le refroidissement, la résistance des enroulements et les paramètres du variateur avant de remettre la cabine en service.", type: "EMERGENCY", priority: "EMERGENCY", status: "IN_PROGRESS", assignedToId: "usr_tech1", componentType: "TRACTION_MOTOR", estimatedHours: 6, actualHours: null, scheduledInDays: null, completedHoursAgo: null },
    { elevatorId: "elv_6", title: "Remplacer les roulements du moteur de traction", description: "Une vibration de 9,6 mm/s indique une usure avancée des roulements. Remplacer les deux roulements et réaligner la poulie.", type: "CORRECTIVE", priority: "CRITICAL", status: "ASSIGNED", assignedToId: "usr_tech2", componentType: "TRACTION_MOTOR", estimatedHours: 8, actualHours: null, scheduledInDays: 2, completedHoursAgo: null },
    { elevatorId: "elv_3", title: "Analyser la vibration croissante sur MPT-03", description: "La vibration a augmenté de 156 % par rapport à la référence en 30 jours. Contrôler le jeu des patins de guidage et la tension des câbles.", type: "PREDICTIVE", priority: "HIGH", status: "ASSIGNED", assignedToId: "usr_tech1", componentType: "GUIDE_SHOES", estimatedHours: 3.5, actualHours: null, scheduledInDays: 1, completedHoursAgo: null },
    { elevatorId: "elv_2", title: "Étalonner la vitesse de l'opérateur de porte", description: "Vitesse de porte mesurée à 1,42 m/s pour un minimum de 1,50 m/s. Réétalonner l'opérateur et vérifier la barrière de sécurité.", type: "CORRECTIVE", priority: "HIGH", status: "OPEN", assignedToId: null, componentType: "DOOR_OPERATOR", estimatedHours: 2, actualHours: null, scheduledInDays: 3, completedHoursAgo: null },
    { elevatorId: "elv_8", title: "Rétablir la télémétrie sur NGM-02", description: "Aucun relevé depuis 48 heures. Vérifier l'alimentation de la passerelle et la liaison cellulaire.", type: "CORRECTIVE", priority: "HIGH", status: "ON_HOLD", assignedToId: "usr_tech2", componentType: "CONTROLLER_BOARD", estimatedHours: 2.5, actualHours: 1, scheduledInDays: null, completedHoursAgo: null },
    { elevatorId: "elv_1", title: "Entretien préventif trimestriel", description: "Entretien trimestriel standard : lubrification, contrôle du jeu de frein, inspection des câbles, diagnostics de la commande.", type: "PREVENTIVE", priority: "MEDIUM", status: "OPEN", assignedToId: null, componentType: null, estimatedHours: 4, actualHours: null, scheduledInDays: 9, completedHoursAgo: null },
    { elevatorId: "elv_4", title: "Inspection annuelle du parachute", description: "Inspection annuelle réglementaire du parachute et du limiteur de vitesse, avec essai de déclenchement.", type: "INSPECTION", priority: "MEDIUM", status: "ASSIGNED", assignedToId: "usr_tech1", componentType: "SAFETY_GEAR", estimatedHours: 5, actualHours: null, scheduledInDays: 6, completedHoursAgo: null },
    { elevatorId: "elv_5", title: "Remplacer les câbles en acier", description: "L'usure des câbles a atteint le seuil de remplacement. Remplacer les six câbles et remettre en tension.", type: "PREDICTIVE", priority: "HIGH", status: "ASSIGNED", assignedToId: "usr_tech2", componentType: "STEEL_ROPES", estimatedHours: 10, actualHours: null, scheduledInDays: 12, completedHoursAgo: null },
    { elevatorId: "elv_7", title: "Analyse du fluide hydraulique", description: "Prélever et analyser le fluide hydraulique : contamination et dégradation de la viscosité.", type: "PREVENTIVE", priority: "LOW", status: "OPEN", assignedToId: null, componentType: "HYDRAULIC_UNIT", estimatedHours: 2, actualHours: null, scheduledInDays: 20, completedHoursAgo: null },
    { elevatorId: "elv_1", title: "Remplacer la courroie de l'opérateur de porte", description: "Courroie remplacée et tension réglée ; cadencement des cycles de porte vérifié selon les spécifications du constructeur.", type: "CORRECTIVE", priority: "MEDIUM", status: "COMPLETED", assignedToId: "usr_tech1", componentType: "DOOR_OPERATOR", estimatedHours: 2, actualHours: 1.75, scheduledInDays: null, completedHoursAgo: 2 },
    { elevatorId: "elv_5", title: "Inspection de l'ensemble de frein", description: "Jeu de frein mesuré dans la tolérance ; garnitures à 40 % de durée de vie restante.", type: "PREVENTIVE", priority: "MEDIUM", status: "COMPLETED", assignedToId: "usr_tech2", componentType: "BRAKE_ASSEMBLY", estimatedHours: 3, actualHours: 2.5, scheduledInDays: null, completedHoursAgo: 4 },
    { elevatorId: "elv_7", title: "Mise à jour du micrologiciel de la carte de commande", description: "Micrologiciel mis à jour vers la version courante ; paramètres revérifiés après le flashage.", type: "CORRECTIVE", priority: "LOW", status: "COMPLETED", assignedToId: "usr_tech1", componentType: "CONTROLLER_BOARD", estimatedHours: 1.5, actualHours: 1.25, scheduledInDays: null, completedHoursAgo: 26 },
    { elevatorId: "elv_2", title: "Remplacement des patins de guidage", description: "Annulé à la demande du client ; replanifié sur le prochain arrêt programmé.", type: "CORRECTIVE", priority: "LOW", status: "CANCELLED", assignedToId: null, componentType: "GUIDE_SHOES", estimatedHours: 4, actualHours: null, scheduledInDays: null, completedHoursAgo: null },
    { elevatorId: "elv_4", title: "Vérification de la télémétrie de référence", description: "Contrôle après mise en service confirmant que tous les capteurs relèvent dans les plages attendues.", type: "INSPECTION", priority: "LOW", status: "COMPLETED", assignedToId: "usr_tech2", componentType: null, estimatedHours: 1, actualHours: 0.75, scheduledInDays: null, completedHoursAgo: 52 },
  ];

  const workOrders: WorkOrder[] = workOrderSeed.map((w, i) => {
    const component = w.componentType
      ? components.find(
          (c) => c.elevatorId === w.elevatorId && c.componentType === w.componentType
        )
      : undefined;
    return {
      id: `wo_${i + 1}`,
      orderNumber: `WO-${new Date(now).getUTCFullYear()}-${String(1041 + i).padStart(4, "0")}`,
      title: w.title,
      description: w.description,
      type: w.type,
      priority: w.priority,
      status: w.status,
      elevatorId: w.elevatorId,
      componentId: component?.id ?? null,
      scheduleId: null,
      alertId: null,
      assignedToId: w.assignedToId,
      createdById: "usr_mgr",
      estimatedHours: w.estimatedHours,
      actualHours: w.actualHours,
      partsReplaced: null,
      notes: null,
      photoUrls: [],
      signatureUrl: null,
      scheduledDate:
        w.scheduledInDays === null ? null : new Date(now + w.scheduledInDays * 24 * 60 * MINUTE),
      startedAt: w.status === "IN_PROGRESS" ? iso(3 * 60 * MINUTE) : null,
      /**
       * Check-in is a property of being on site, so only the demo's single
       * in-progress order carries one — the technician is standing at that
       * machine. Stamped an hour before work began rather than at the same
       * instant, which is the ordering the real endpoint produces: arrival,
       * then a spell of unloading and access before the job is started.
       *
       * `iso` counts *backwards* from now, so the larger value is the earlier
       * timestamp.
       */
      arrivedAt: w.status === "IN_PROGRESS" ? iso(4 * 60 * MINUTE) : null,
      checkInNotes:
        w.status === "IN_PROGRESS"
          ? "Accès par la loge ; le gardien a remis les clés de la machinerie."
          : null,
      completedAt:
        w.completedHoursAgo === null ? null : iso(w.completedHoursAgo * 60 * MINUTE),
      createdAt: iso((i + 1) * 190 * MINUTE),
      updatedAt: iso(60 * MINUTE),
    };
  });

  // ── Predictive scores ─────────────────────────────────────
  const scores: PredictiveScore[] = components.map((c) => {
    const rul = c.remainingUsefulLife;
    const riskLevel =
      rul <= 10 ? "CRITICAL" : rul <= 25 ? "HIGH" : rul <= 50 ? "MEDIUM" : "LOW";
    const riskScore = round1(clamp(100 - rul, 0, 100));
    const daysToFailure = Math.max(3, Math.round((rul / 100) * 365));
    return {
      id: `scr_${c.id}`,
      elevatorId: c.elevatorId,
      componentId: c.id,
      componentType: c.componentType,
      riskLevel,
      riskScore,
      remainingUsefulLifePercent: rul,
      predictedFailureDate: new Date(now + daysToFailure * 24 * 60 * MINUTE),
      // Degradation scores run 0-1 and are capped at 0.95, matching the real
      // engine in `src/lib/ai/predictive-engine.ts` — a confidence of 1.0 would
      // imply a certainty the model never claims.
      confidence: Math.min(
        0.95,
        Math.round((0.62 + (100 - rul) / 400) * 100) / 100
      ),
      modelVersion: "demo-fixture",
      features: {
        currentLifeHours: c.currentLifeHours,
        expectedLifeHours: c.expectedLifeHours,
        source: "demo-dataset",
      },
      recommendations:
        riskLevel === "CRITICAL"
          ? [
              `URGENT : planifier sans délai l'inspection du composant « ${c.name.toLowerCase()} »`,
              "Préparer les pièces de rechange et ouvrir une fenêtre de maintenance d'urgence",
            ]
          : riskLevel === "HIGH"
            ? [
                `Planifier le remplacement préventif du composant « ${c.name.toLowerCase()} » sous deux semaines`,
                "Passer à un contrôle quotidien de la télémétrie",
              ]
            : [
                "Composant dans les paramètres normaux — poursuivre la surveillance de routine",
              ],
      createdAt: iso(90 * MINUTE),
      updatedAt: iso(45 * MINUTE),
    };
  });

  // ── Error codes ───────────────────────────────────────────
  //
  // The catalogue is imported rather than repeated: the wizard's guidance on a
  // real deployment comes from the seeded rows, and a demo that showed
  // different instructions would be demonstrating something the product does
  // not do. See `src/lib/incidents/error-code-catalogue.ts`.
  const errorCodeSeed = ELEVATOR_ERROR_CODES;

  const errorCodes: ErrorCode[] = errorCodeSeed.map((e, i) => ({
    id: `err_${i + 1}`,
    code: e.code,
    title: e.title,
    description: e.description,
    solution: e.solution,
    audioUrl: null,
    isActive: true,
    createdAt: iso((300 - i) * 24 * 60 * MINUTE),
    updatedAt: iso(30 * 24 * 60 * MINUTE),
  }));

  const codeId = (code: string) =>
    errorCodes.find((e) => e.code === code)?.id ?? null;

  // ── Client incidents ──────────────────────────────────────
  //
  // Every incident sits on a unit inside its reporter's own portfolio, and
  // each escalated one points at the work order its escalation raised — the
  // link the API creates in `POST /api/incidents`. A fixture that paired
  // owner1 with a Riverside unit would quietly defeat the scoping tests.
  const incidentSeed: Array<{
    id: string;
    elevatorId: string;
    clientId: string;
    code: string | null;
    status:
      | "ESCALATED"
      | "TECHNICIAN_ASSIGNED"
      | "IN_PROGRESS"
      | "CLOSED"
      | "RESOLVED_BY_CLIENT";
    isDirectTransfer: boolean;
    workOrderId: string | null;
    technicianId: string | null;
    notes: string | null;
    minutesAgo: number;
    resolvedMinutesAgo: number | null;
  }> = [
    {
      id: "inc_1", elevatorId: "elv_1", clientId: "usr_owner1", code: "E-402",
      status: "RESOLVED_BY_CLIENT", isDirectTransfer: false, workOrderId: null,
      technicianId: null,
      notes: "Alarme incendie déclenchée par un exercice. L'ascenseur est revenu au rez-de-chaussée normalement.",
      minutesAgo: 3 * 24 * 60, resolvedMinutesAgo: 3 * 24 * 60 - 12,
    },
    {
      id: "inc_2", elevatorId: "elv_6", clientId: "usr_owner2", code: "E-201",
      status: "IN_PROGRESS", isDirectTransfer: true, workOrderId: "wo_1",
      technicianId: "usr_tech1",
      notes: "Deux personnes bloquées entre le 4e et le 5e étage, évacuées par le technicien.",
      minutesAgo: 5 * 60, resolvedMinutesAgo: null,
    },
    {
      id: "inc_3", elevatorId: "elv_3", clientId: "usr_owner1", code: "E-301",
      status: "TECHNICIAN_ASSIGNED", isDirectTransfer: false, workOrderId: "wo_3",
      technicianId: "usr_tech1",
      notes: "Alarme de surcharge permanente, cabine vide. Le capteur de charge semble déréglé.",
      minutesAgo: 24 * 60, resolvedMinutesAgo: null,
    },
    {
      id: "inc_4", elevatorId: "elv_2", clientId: "usr_owner1", code: "E-101",
      status: "ESCALATED", isDirectTransfer: false, workOrderId: "wo_4",
      technicianId: null,
      notes: "Les portes restent ouvertes au rez-de-chaussée malgré le nettoyage de la cellule.",
      minutesAgo: 2 * 60, resolvedMinutesAgo: null,
    },
    {
      id: "inc_5", elevatorId: "elv_5", clientId: "usr_owner2", code: "E-302",
      status: "CLOSED", isDirectTransfer: false, workOrderId: "wo_11",
      technicianId: "usr_tech2",
      notes: "Variateur remis en service après remplacement du module de puissance.",
      minutesAgo: 2 * 24 * 60, resolvedMinutesAgo: 4 * 60,
    },
    {
      id: "inc_6", elevatorId: "elv_4", clientId: "usr_owner2", code: "E-102",
      status: "TECHNICIAN_ASSIGNED", isDirectTransfer: false, workOrderId: "wo_7",
      technicianId: "usr_tech1",
      notes: null,
      minutesAgo: 2 * 24 * 60, resolvedMinutesAgo: null,
    },
  ];

  const incidents: IncidentReport[] = incidentSeed.map((s) => ({
    id: s.id,
    incidentNumber: `INC-${new Date(now).getUTCFullYear()}-${String(2001 + incidentSeed.indexOf(s)).padStart(4, "0")}`,
    elevatorId: s.elevatorId,
    clientId: s.clientId,
    errorCodeId: s.code ? codeId(s.code) : null,
    status: s.status,
    isDirectTransfer: s.isDirectTransfer,
    workOrderId: s.workOrderId,
    technicianId: s.technicianId,
    notes: s.notes,
    audioNoteUrl: null,
    resolvedAt:
      s.resolvedMinutesAgo === null ? null : iso(s.resolvedMinutesAgo * MINUTE),
    createdAt: iso(s.minutesAgo * MINUTE),
    updatedAt: iso(Math.max(1, s.resolvedMinutesAgo ?? s.minutesAgo - 30) * MINUTE),
  }));

  // ── Notifications ─────────────────────────────────────────
  //
  // Addressed to the roles the real pipeline notifies: escalations go to
  // management, dispatches to the assigned technician, closures back to the
  // reporter. Nothing here is written to a user who would not receive it.
  const notificationSeed: Array<{
    userId: string;
    title: string;
    message: string;
    type: string;
    isRead: boolean;
    linkUrl: string | null;
    minutesAgo: number;
  }> = [
    {
      userId: "usr_mgr", title: "Urgence – RBC-03",
      message: "Assistance d'urgence demandée pour RBC-03 à Riverside Business Center. Le signalant n'a pas pu décrire la panne — intervenez ou rappelez-le.",
      type: "incident", isRead: false, linkUrl: "/administration/incidents", minutesAgo: 5 * 60,
    },
    {
      userId: "usr_admin", title: "Urgence – RBC-03",
      message: "Assistance d'urgence demandée pour RBC-03 à Riverside Business Center. Le signalant n'a pas pu décrire la panne — intervenez ou rappelez-le.",
      type: "incident", isRead: false, linkUrl: "/administration/incidents", minutesAgo: 5 * 60,
    },
    {
      userId: "usr_mgr", title: "Incident escaladé – MPT-02",
      message: "Une panne signalée pour MPT-02 à Metro Plaza Tower n'a pas pu être résolue par le client et nécessite un technicien.",
      type: "incident", isRead: false, linkUrl: "/administration/incidents", minutesAgo: 2 * 60,
    },
    {
      userId: "usr_tech1", title: "Nouvel incident assigné – RBC-03",
      message: "Incident INC-2026-2002 vous a été assigné.",
      type: "incident", isRead: false, linkUrl: "/technicien", minutesAgo: 4 * 60,
    },
    {
      userId: "usr_tech1", title: "Nouvel incident assigné – MPT-03",
      message: "Incident INC-2026-2003 vous a été assigné.",
      type: "incident", isRead: true, linkUrl: "/technicien", minutesAgo: 23 * 60,
    },
    {
      userId: "usr_owner2", title: "Incident INC-2026-2005 clôturé",
      message: "Votre signalement pour RBC-02 a été traité.",
      type: "incident", isRead: true, linkUrl: "/client", minutesAgo: 4 * 60,
    },
  ];

  const notifications: Notification[] = notificationSeed.map((n, i) => ({
    id: `ntf_${i + 1}`,
    userId: n.userId,
    title: n.title,
    message: n.message,
    type: n.type,
    isRead: n.isRead,
    linkUrl: n.linkUrl,
    createdAt: iso(n.minutesAgo * MINUTE),
  }));

  return {
    users, buildings, elevators, components, telemetry, snapshots, alerts,
    workOrders, scores, errorCodes, incidents, notifications,
  };
}

// ─── Memoised access ────────────────────────────────────────

let cached: DemoWorld | null = null;
let cachedAt = 0;

/**
 * One coherent snapshot of the demo world, rebuilt at most every
 * `CACHE_TTL_MS`. Rebuilding per request would be cheap but would let a single
 * page's parallel API calls see slightly different worlds.
 */
export function demoWorld(): DemoWorld {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) return cached;
  cached = build();
  cachedAt = now;
  return cached;
}

/** Test seam. */
export function resetDemoWorld(): void {
  cached = null;
  cachedAt = 0;
}
