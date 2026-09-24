/**
 * ElevatorPulse – Database Seed Script
 *
 * Creates initial buildings, elevators, components, users, and threshold rules.
 *
 * Usage: npx tsx prisma/seed.ts
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
// Relative rather than `@/…`: this script runs under `tsx`, outside the
// Next.js build, where the path alias is not guaranteed to resolve.
import { ELEVATOR_ERROR_CODES } from "../src/lib/incidents/error-code-catalogue";

// String literals match the Prisma schema enums exactly.
// (Avoids a hard dependency on generated enum exports so `tsc`
// passes even before `prisma generate` has run.)
const UserRole = {
  ADMIN: "ADMIN",
  MAINTENANCE_MANAGER: "MAINTENANCE_MANAGER",
  FIELD_TECHNICIAN: "FIELD_TECHNICIAN",
  BUILDING_OWNER: "BUILDING_OWNER",
} as const;
const SLATier = {
  BASIC: "BASIC",
  STANDARD: "STANDARD",
  PREMIUM: "PREMIUM",
  ENTERPRISE: "ENTERPRISE",
} as const;
const ElevatorBrand = {
  OTIS: "OTIS",
  SCHINDLER: "SCHINDLER",
  THYSSENKRUPP: "THYSSENKRUPP",
  MITSUBISHI: "MITSUBISHI",
  HITACHI: "HITACHI",
  KONE: "KONE",
  OTHER: "OTHER",
} as const;
const MotorType = {
  AC_GEARED: "AC_GEARED",
  AC_GEARDLESS: "AC_GEARDLESS",
  DC_GEARED: "DC_GEARED",
  HYDRAULIC: "HYDRAULIC",
  OTHER: "OTHER",
} as const;
const ControllerType = {
  MICROPROCESSOR: "MICROPROCESSOR",
  PLC: "PLC",
  RELAY_LOGIC: "RELAY_LOGIC",
  FULLY_DIGITAL: "FULLY_DIGITAL",
  OTHER: "OTHER",
} as const;
const ElevatorStatus = {
  OPERATIONAL: "OPERATIONAL",
  SERVICE_REQUIRED: "SERVICE_REQUIRED",
  ANOMALY_DETECTED: "ANOMALY_DETECTED",
  CRITICAL_SHUTDOWN: "CRITICAL_SHUTDOWN",
  OFFLINE: "OFFLINE",
} as const;
const ComponentType = {
  TRACTION_MOTOR: "TRACTION_MOTOR",
  BRAKE_ASSEMBLY: "BRAKE_ASSEMBLY",
  DOOR_OPERATOR: "DOOR_OPERATOR",
  STEEL_ROPES: "STEEL_ROPES",
  GUIDE_SHOES: "GUIDE_SHOES",
  CONTROLLER_BOARD: "CONTROLLER_BOARD",
} as const;
const MaintenanceFrequency = {
  MONTHLY: "MONTHLY",
  QUARTERLY: "QUARTERLY",
} as const;
/**
 * Dispatchability, carried on `User.status` and meaningful only for field
 * technicians. `prisma/schema.prisma` declares it in availability order —
 * AVAILABLE and ON_JOB are dispatchable, OFF_DUTY and ON_LEAVE are not — and
 * the roster filters on that pair.
 */
const TechnicianStatus = {
  AVAILABLE: "AVAILABLE",
  ON_JOB: "ON_JOB",
  OFF_DUTY: "OFF_DUTY",
  ON_LEAVE: "ON_LEAVE",
} as const;

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding ElevatorPulse database...\n");

  // ─── Users ──────────────────────────────────────────────

  const password = await bcrypt.hash("password123", 12);

  const admin = await prisma.user.upsert({
    where: { email: "admin@elevatorpulse.com" },
    // Repair on re-seed: if the user already exists with a stale/wrong
    // hash (the #1 cause of "Invalid email or password"), fix it.
    update: {
      passwordHash: password,
      name: "System Admin",
      role: UserRole.ADMIN,
      isActive: true,
    },
    create: {
      email: "admin@elevatorpulse.com",
      name: "System Admin",
      passwordHash: password,
      role: UserRole.ADMIN,
      phone: "+1-555-0100",
    },
  });

  const manager = await prisma.user.upsert({
    where: { email: "manager@elevatorpulse.com" },
    update: {
      passwordHash: password,
      name: "Sarah Mitchell",
      role: UserRole.MAINTENANCE_MANAGER,
      isActive: true,
    },
    create: {
      email: "manager@elevatorpulse.com",
      name: "Sarah Mitchell",
      passwordHash: password,
      role: UserRole.MAINTENANCE_MANAGER,
      phone: "+1-555-0200",
    },
  });

  const tech1 = await prisma.user.upsert({
    where: { email: "tech1@elevatorpulse.com" },
    update: {
      passwordHash: password,
      name: "James Rodriguez",
      role: UserRole.FIELD_TECHNICIAN,
      isActive: true,
      status: TechnicianStatus.AVAILABLE,
    },
    create: {
      email: "tech1@elevatorpulse.com",
      name: "James Rodriguez",
      passwordHash: password,
      role: UserRole.FIELD_TECHNICIAN,
      phone: "+1-555-0301",
      status: TechnicianStatus.AVAILABLE,
    },
  });

  // Mid-shift and mid-job. Still dispatchable — work can be queued behind the
  // one he is on — which is why ON_JOB is not filtered out of the roster.
  const tech2 = await prisma.user.upsert({
    where: { email: "tech2@elevatorpulse.com" },
    update: {
      passwordHash: password,
      name: "Wei Chen",
      role: UserRole.FIELD_TECHNICIAN,
      isActive: true,
      status: TechnicianStatus.ON_JOB,
    },
    create: {
      email: "tech2@elevatorpulse.com",
      name: "Wei Chen",
      passwordHash: password,
      role: UserRole.FIELD_TECHNICIAN,
      phone: "+1-555-0302",
      status: TechnicianStatus.ON_JOB,
    },
  });

  // Active account, on leave. Seeded deliberately so the roster's status filter
  // is observable against a real database: Ilse must not appear in the dispatch
  // dialog, and the only reason is her status — her account is enabled and her
  // role is correct, so a regression that dropped the filter would show her.
  const tech3 = await prisma.user.upsert({
    where: { email: "tech3@elevatorpulse.com" },
    update: {
      passwordHash: password,
      name: "Ilse Fontaine",
      role: UserRole.FIELD_TECHNICIAN,
      isActive: true,
      status: TechnicianStatus.ON_LEAVE,
    },
    create: {
      email: "tech3@elevatorpulse.com",
      name: "Ilse Fontaine",
      passwordHash: password,
      role: UserRole.FIELD_TECHNICIAN,
      phone: "+1-555-0303",
      status: TechnicianStatus.ON_LEAVE,
    },
  });

  const owner = await prisma.user.upsert({
    where: { email: "owner@metroplaza.com" },
    update: {
      passwordHash: password,
      name: "Robert Anderson",
      role: UserRole.BUILDING_OWNER,
      isActive: true,
    },
    create: {
      email: "owner@metroplaza.com",
      name: "Robert Anderson",
      passwordHash: password,
      role: UserRole.BUILDING_OWNER,
      phone: "+1-555-0400",
    },
  });

  console.log("  ✅ Users created");

  // ─── Buildings (idempotent: delete-and-recreate keeps FK graph clean) ──

  await prisma.building.deleteMany({});

  const building1 = await prisma.building.create({
    data: {
      name: "Metro Plaza Tower",
      address: "100 Commerce Street",
      city: "Dallas",
      state: "TX",
      zipCode: "75201",
      contactPerson: "Robert Anderson",
      contactEmail: "owner@metroplaza.com",
      contactPhone: "+1-555-0400",
      slaTier: SLATier.PREMIUM,
      latitude: 32.7876,
      longitude: -96.7985,
      ownerId: owner.id,
    },
  });

  const building2 = await prisma.building.create({
    data: {
      name: "Riverside Office Complex",
      address: "250 River Road",
      city: "Austin",
      state: "TX",
      zipCode: "78701",
      contactPerson: "Maria Santos",
      contactEmail: "maria@riversideoffice.com",
      contactPhone: "+1-555-0500",
      slaTier: SLATier.STANDARD,
      latitude: 30.2672,
      longitude: -97.7431,
    },
  });

  const building3 = await prisma.building.create({
    data: {
      name: "Harborview Residences",
      address: "50 Harbor Drive",
      city: "San Diego",
      state: "CA",
      zipCode: "92101",
      contactPerson: "Tom Nakamura",
      contactEmail: "tom@harborview.com",
      contactPhone: "+1-555-0600",
      slaTier: SLATier.ENTERPRISE,
      latitude: 32.7157,
      longitude: -117.1611,
    },
  });

  console.log("  ✅ Buildings created");

  // ─── Elevators & Components ─────────────────────────────

  const elevatorSpecs = [
    {
      buildingId: building1.id,
      elevatorCode: "EP-BLD01-EL01",
      brand: ElevatorBrand.OTIS,
      model: "Gen2-100",
      motorType: MotorType.AC_GEARDLESS,
      controllerType: ControllerType.FULLY_DIGITAL,
      maxPayloadKg: 1600,
      floorsServed: 25,
      status: ElevatorStatus.OPERATIONAL,
      operatingHours: 12500,
      overallHealth: 92,
    },
    {
      buildingId: building1.id,
      elevatorCode: "EP-BLD01-EL02",
      brand: ElevatorBrand.SCHINDLER,
      model: "5500",
      motorType: MotorType.AC_GEARED,
      controllerType: ControllerType.MICROPROCESSOR,
      maxPayloadKg: 1350,
      floorsServed: 25,
      status: ElevatorStatus.SERVICE_REQUIRED,
      operatingHours: 28000,
      overallHealth: 68,
    },
    {
      buildingId: building2.id,
      elevatorCode: "EP-BLD02-EL01",
      brand: ElevatorBrand.THYSSENKRUPP,
      model: "ACE-MRL",
      motorType: MotorType.AC_GEARDLESS,
      controllerType: ControllerType.FULLY_DIGITAL,
      maxPayloadKg: 1200,
      floorsServed: 15,
      status: ElevatorStatus.ANOMALY_DETECTED,
      operatingHours: 45000,
      overallHealth: 41,
    },
    {
      buildingId: building2.id,
      elevatorCode: "EP-BLD02-EL02",
      brand: ElevatorBrand.KONE,
      model: "MonoSpace",
      motorType: MotorType.AC_GEARDLESS,
      controllerType: ControllerType.FULLY_DIGITAL,
      maxPayloadKg: 1000,
      floorsServed: 15,
      status: ElevatorStatus.OPERATIONAL,
      operatingHours: 5000,
      overallHealth: 97,
    },
    {
      buildingId: building3.id,
      elevatorCode: "EP-BLD03-EL01",
      brand: ElevatorBrand.MITSUBISHI,
      model: "NexieZ",
      motorType: MotorType.AC_GEARED,
      controllerType: ControllerType.MICROPROCESSOR,
      maxPayloadKg: 1800,
      floorsServed: 35,
      status: ElevatorStatus.CRITICAL_SHUTDOWN,
      operatingHours: 55000,
      overallHealth: 18,
    },
  ];

  for (const spec of elevatorSpecs) {
    const elevator = await prisma.elevator.create({
      data: {
        ...spec,
        installationDate: new Date(
          2018 + Math.floor(Math.random() * 5),
          Math.floor(Math.random() * 12),
          1
        ),
        lastMaintenance: new Date(
          Date.now() - Math.random() * 90 * 24 * 60 * 60 * 1000
        ),
        nextMaintenance: new Date(
          Date.now() + Math.random() * 30 * 24 * 60 * 60 * 1000
        ),
      },
    });

    // Create components for each elevator
    const components = [
      {
        componentType: ComponentType.TRACTION_MOTOR,
        name: `${spec.brand} Traction Motor`,
        manufacturer: spec.brand,
        expectedLifeHours: 60000,
        currentLifeHours: spec.operatingHours,
      },
      {
        componentType: ComponentType.BRAKE_ASSEMBLY,
        name: `${spec.brand} Brake Assembly`,
        manufacturer: spec.brand,
        expectedLifeHours: 45000,
        currentLifeHours: spec.operatingHours * 0.9,
      },
      {
        componentType: ComponentType.DOOR_OPERATOR,
        name: `${spec.brand} Door Operator`,
        manufacturer: spec.brand,
        expectedLifeHours: 40000,
        currentLifeHours: spec.operatingHours * 0.85,
      },
      {
        componentType: ComponentType.STEEL_ROPES,
        name: "Steel Hoist Ropes (4x)",
        manufacturer: "CERHA",
        expectedLifeHours: 50000,
        currentLifeHours: spec.operatingHours * 0.95,
      },
      {
        componentType: ComponentType.GUIDE_SHOES,
        name: "Guide Shoes (Teflon)",
        manufacturer: "CERHA",
        expectedLifeHours: 35000,
        currentLifeHours: spec.operatingHours * 0.7,
      },
      {
        componentType: ComponentType.CONTROLLER_BOARD,
        name: `${spec.brand} Controller Board`,
        manufacturer: spec.brand,
        expectedLifeHours: 80000,
        currentLifeHours: spec.operatingHours,
      },
    ];

    for (const comp of components) {
      const rul =
        comp.expectedLifeHours > 0
          ? Math.max(0, ((comp.expectedLifeHours - comp.currentLifeHours) / comp.expectedLifeHours) * 100)
          : 100;

      await prisma.elevatorComponent.create({
        data: {
          elevatorId: elevator.id,
          componentType: comp.componentType,
          name: comp.name,
          manufacturer: comp.manufacturer,
          expectedLifeHours: comp.expectedLifeHours,
          currentLifeHours: comp.currentLifeHours,
          remainingUsefulLife: Math.round(rul * 10) / 10,
          installedDate: elevator.installationDate,
        },
      });
    }

    // Create maintenance schedules
    await prisma.maintenanceSchedule.create({
      data: {
        elevatorId: elevator.id,
        title: "Monthly Safety Inspection",
        description:
          "Comprehensive safety inspection including rope tension, brake test, leveling check, and door operation verification.",
        frequency: MaintenanceFrequency.MONTHLY,
        nextDueDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
        checklistItems: [
          { name: "Rope tension check", required: true },
          { name: "Emergency brake test", required: true },
          { name: "Cabin leveling verification", required: true },
          { name: "Motor lubrication", required: true },
          { name: "Door sensor calibration", required: true },
          { name: "Emergency phone test", required: true },
          { name: "Pit inspection", required: true },
          { name: "Governor speed test", required: true },
        ],
      },
    });

    await prisma.maintenanceSchedule.create({
      data: {
        elevatorId: elevator.id,
        title: "Quarterly Full Service",
        description:
          "Deep maintenance including controller diagnostics, rope replacement assessment, and motor vibration analysis.",
        frequency: MaintenanceFrequency.QUARTERLY,
        nextDueDate: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000),
        checklistItems: [
          { name: "Controller diagnostics", required: true },
          { name: "Rope inspection & replacement assessment", required: true },
          { name: "Motor vibration spectral analysis", required: true },
          { name: "Guide rail lubrication", required: true },
          { name: "Counterweight guide shoe inspection", required: true },
          { name: "Buffer spring inspection", required: true },
          { name: "Safety gear test", required: true },
        ],
      },
    });
  }

  console.log("  ✅ Elevators, components, and schedules created");

  // ─── Threshold Rules ────────────────────────────────────

  // NOTE: no `cabin_load_kg` row. Cabin overload is evaluated against each
  // unit's own `maxPayloadKg` (see `payloadThresholds` in
  // src/lib/iot/thresholds.ts), so an absolute table row would never be read
  // — it previously sat here with 4500/5000 kg and silently did nothing when
  // edited.
  const thresholds = [
    { metricName: "motor_vibration_mm_s", warningMax: 4.0, criticalMax: 7.0, description: "Motor vibration level in mm/s RMS" },
    { metricName: "motor_temperature_c", warningMax: 85, criticalMax: 105, description: "Motor winding temperature in Celsius" },
    { metricName: "door_speed_ms", warningMax: 1.5, criticalMax: 2.0, warningMin: 0.3, criticalMin: 0.1, description: "Door opening/closing speed in m/s" },
    { metricName: "leveling_offset_mm", warningMax: 8, criticalMax: 15, warningMin: -8, criticalMin: -15, description: "Floor leveling offset in mm" },
    { metricName: "supply_voltage_v", warningMax: 440, criticalMax: 460, warningMin: 360, criticalMin: 340, description: "Supply voltage in volts" },
    { metricName: "current_draw_a", warningMax: 60, criticalMax: 80, description: "Motor current draw in amps" },
  ];

  for (const t of thresholds) {
    await prisma.thresholdRule.upsert({
      where: { metricName: t.metricName },
      update: {
        warningMax: t.warningMax,
        criticalMax: t.criticalMax,
        warningMin: t.warningMin,
        criticalMin: t.criticalMin,
        description: t.description,
      },
      create: t as any,
    });
  }

  console.log("  ✅ Threshold rules created");

  // ─── Sample Work Orders ─────────────────────────────────

  const elevators = await prisma.elevator.findMany();

  await prisma.workOrder.create({
    data: {
      orderNumber: "WO-202608-0001",
      title: "Monthly Safety Inspection — Metro Plaza EL01",
      description: "Scheduled monthly safety inspection for elevator EP-BLD01-EL01.",
      type: "PREVENTIVE",
      priority: "MEDIUM",
      status: "ASSIGNED",
      elevatorId: elevators[0].id,
      assignedToId: tech1.id,
      createdById: manager.id,
      scheduledDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      estimatedHours: 3,
    },
  });

  await prisma.workOrder.create({
    data: {
      orderNumber: "WO-202608-0002",
      title: "High Vibration Alert — Riverside EL01",
      description:
        "Motor vibration exceeding 4.0 mm/s threshold. Requires immediate inspection of traction motor mounting and brake assembly.",
      type: "CORRECTIVE",
      priority: "HIGH",
      status: "OPEN",
      elevatorId: elevators[2].id,
      createdById: manager.id,
      estimatedHours: 4,
    },
  });

  await prisma.workOrder.create({
    data: {
      orderNumber: "WO-202608-0003",
      title: "Emergency: Motor Overheating — Harborview EL01",
      description:
        "CRITICAL: Motor temperature exceeding 105°C. Elevator shut down. Immediate inspection required.",
      type: "EMERGENCY",
      priority: "CRITICAL",
      status: "IN_PROGRESS",
      elevatorId: elevators[4].id,
      assignedToId: tech2.id,
      createdById: manager.id,
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      estimatedHours: 6,
    },
  });

  console.log("  ✅ Sample work orders created");

  // ─── Error Code Catalogue ───────────────────────────────

  // Upserted on the code rather than deleted and recreated: incidents reference
  // these rows, and a re-seed that dropped them would null out the error code
  // on every historical report. The copy is the shared catalogue, so the
  // wizard shows the same instructions here as it does in the demo fixtures.
  for (const entry of ELEVATOR_ERROR_CODES) {
    await prisma.errorCode.upsert({
      where: { code: entry.code },
      update: {
        title: entry.title,
        description: entry.description,
        solution: entry.solution,
        isActive: true,
      },
      create: {
        code: entry.code,
        title: entry.title,
        description: entry.description,
        solution: entry.solution,
      },
    });
  }

  console.log(`  ✅ ${ELEVATOR_ERROR_CODES.length} error codes created`);

  // ─── Sample Client Incidents ────────────────────────────

  // Two rows so a fresh install has something on both boards: one outstanding
  // escalation with the work order it raised, and one the client cleared
  // themselves. Without these the incident board renders empty on first run
  // and there is no way to see the pipeline without filing a report by hand.
  const doorCode = await prisma.errorCode.findUnique({
    where: { code: "E-101" },
    select: { id: true },
  });

  const escalationOrder = await prisma.workOrder.create({
    data: {
      orderNumber: "WO-202608-0004",
      title: "Client report – EP-BLD01-EL02",
      description:
        "Reported by the building through the client portal.\n" +
        "Elevator: EP-BLD01-EL02\n" +
        "Site: Metro Plaza Tower, 100 Commerce Street\n\n" +
        "Reporter's description:\nLes portes restent ouvertes au rez-de-chaussée.",
      type: "CORRECTIVE",
      priority: "HIGH",
      status: "OPEN",
      elevatorId: elevators[1].id,
      createdById: owner.id,
    },
  });

  await prisma.incidentReport.upsert({
    where: { incidentNumber: "INC-202609-100001" },
    update: {},
    create: {
      incidentNumber: "INC-202609-100001",
      elevatorId: elevators[1].id,
      clientId: owner.id,
      errorCodeId: doorCode?.id ?? null,
      status: "ESCALATED",
      isDirectTransfer: false,
      workOrderId: escalationOrder.id,
      notes: "Les portes restent ouvertes au rez-de-chaussée.",
    },
  });

  await prisma.incidentReport.upsert({
    where: { incidentNumber: "INC-202609-100002" },
    update: {},
    create: {
      incidentNumber: "INC-202609-100002",
      elevatorId: elevators[0].id,
      clientId: owner.id,
      errorCodeId: doorCode?.id ?? null,
      status: "RESOLVED_BY_CLIENT",
      isDirectTransfer: false,
      notes: "Un colis bloquait le seuil. Déplacé, les portes fonctionnent.",
      resolvedAt: new Date(),
    },
  });

  console.log("  ✅ Sample client incidents created");

  console.log("\n🎉 Seed complete!\n");
  console.log("  Login credentials (all passwords: password123):");
  console.log("    Admin:   admin@elevatorpulse.com");
  console.log("    Manager: manager@elevatorpulse.com");
  console.log(`    Tech 1:  ${tech1.email}   (${tech1.status})`);
  console.log(`    Tech 2:  ${tech2.email}   (${tech2.status})`);
  // Listed so the ON_LEAVE row is visible without a database client: she can
  // sign in, she simply cannot be dispatched.
  console.log(`    Tech 3:  ${tech3.email}  (${tech3.status} — not dispatchable)`);
  console.log("    Owner:   owner@metroplaza.com");
}

main()
  .catch((e) => {
    console.error("Seed error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
