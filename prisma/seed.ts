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
  console.log("🌱 Peuplement de la base ElevatorPulse...\n");

  // ─── Users ──────────────────────────────────────────────

  const password = await bcrypt.hash("password123", 12);

  const admin = await prisma.user.upsert({
    where: { email: "admin@elevatorpulse.com" },
    // Repair on re-seed: if the user already exists with a stale/wrong
    // hash (the #1 cause of "Invalid email or password"), fix it.
    update: {
      passwordHash: password,
      name: "Administrateur système",
      role: UserRole.ADMIN,
      isActive: true,
    },
    create: {
      email: "admin@elevatorpulse.com",
      name: "Administrateur système",
      passwordHash: password,
      role: UserRole.ADMIN,
      phone: "+213 21 00 00 01",
    },
  });

  const manager = await prisma.user.upsert({
    where: { email: "manager@elevatorpulse.com" },
    update: {
      passwordHash: password,
      name: "Amina Belkacem",
      role: UserRole.MAINTENANCE_MANAGER,
      isActive: true,
    },
    create: {
      email: "manager@elevatorpulse.com",
      name: "Amina Belkacem",
      passwordHash: password,
      role: UserRole.MAINTENANCE_MANAGER,
      phone: "+213 21 00 00 02",
    },
  });

  const tech1 = await prisma.user.upsert({
    where: { email: "tech1@elevatorpulse.com" },
    update: {
      passwordHash: password,
      name: "Karim Haddad",
      role: UserRole.FIELD_TECHNICIAN,
      isActive: true,
      status: TechnicianStatus.AVAILABLE,
    },
    create: {
      email: "tech1@elevatorpulse.com",
      name: "Karim Haddad",
      passwordHash: password,
      role: UserRole.FIELD_TECHNICIAN,
      phone: "+213 21 00 00 03",
      status: TechnicianStatus.AVAILABLE,
    },
  });

  // Mid-shift and mid-job. Still dispatchable — work can be queued behind the
  // one he is on — which is why ON_JOB is not filtered out of the roster.
  const tech2 = await prisma.user.upsert({
    where: { email: "tech2@elevatorpulse.com" },
    update: {
      passwordHash: password,
      name: "Yacine Bouzid",
      role: UserRole.FIELD_TECHNICIAN,
      isActive: true,
      status: TechnicianStatus.ON_JOB,
    },
    create: {
      email: "tech2@elevatorpulse.com",
      name: "Yacine Bouzid",
      passwordHash: password,
      role: UserRole.FIELD_TECHNICIAN,
      phone: "+213 21 00 00 04",
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
      name: "Leïla Mansouri",
      role: UserRole.FIELD_TECHNICIAN,
      isActive: true,
      status: TechnicianStatus.ON_LEAVE,
    },
    create: {
      email: "tech3@elevatorpulse.com",
      name: "Leïla Mansouri",
      passwordHash: password,
      role: UserRole.FIELD_TECHNICIAN,
      phone: "+213 21 00 00 05",
      status: TechnicianStatus.ON_LEAVE,
    },
  });

  const owner = await prisma.user.upsert({
    where: { email: "owner@metroplaza.com" },
    update: {
      passwordHash: password,
      name: "Rachid Zerrouki",
      role: UserRole.BUILDING_OWNER,
      isActive: true,
    },
    create: {
      email: "owner@metroplaza.com",
      name: "Rachid Zerrouki",
      passwordHash: password,
      role: UserRole.BUILDING_OWNER,
      phone: "+213 21 00 00 06",
    },
  });

  console.log("  ✅ Utilisateurs créés");

  // ─── Buildings (idempotent: delete-and-recreate keeps FK graph clean) ──

  // `InspectionReport.elevator` is the one relation on this graph declared
  // without `onDelete`, so it defaults to RESTRICT. Postgres therefore refuses
  // to drop a building while any report still points at one of its elevators —
  // and the cascade that would eventually remove those reports (elevator ->
  // work order -> report) runs too late to save the delete. Clearing the
  // reports first is what makes the wipe possible; `InspectionCheckItem`
  // follows them by cascade.
  await prisma.inspectionReport.deleteMany({});

  await prisma.building.deleteMany({});

  const building1 = await prisma.building.create({
    data: {
      name: "Immeuble Le Panorama",
      address: "12 rue Didouche Mourad",
      city: "Alger",
      state: "Alger",
      zipCode: "16000",
      contactPerson: "Rachid Zerrouki",
      contactEmail: "owner@metroplaza.com",
      contactPhone: "+213 21 00 00 06",
      slaTier: SLATier.PREMIUM,
      latitude: 36.7538,
      longitude: 3.0588,
      ownerId: owner.id,
    },
  });

  const building2 = await prisma.building.create({
    data: {
      name: "Complexe d'affaires Les Oliviers",
      address: "45 boulevard de la Soummam",
      city: "Oran",
      state: "Oran",
      zipCode: "31000",
      contactPerson: "Nadia Boumediene",
      contactEmail: "n.boumediene@les-oliviers.dz",
      contactPhone: "+213 41 00 00 07",
      slaTier: SLATier.STANDARD,
      latitude: 35.6971,
      longitude: -0.6308,
    },
  });

  const building3 = await prisma.building.create({
    data: {
      name: "Résidence El Bahia",
      address: "8 avenue Aouati Mostefa",
      city: "Constantine",
      state: "Constantine",
      zipCode: "25000",
      contactPerson: "Samir Lakhdari",
      contactEmail: "s.lakhdari@elbahia.dz",
      contactPhone: "+213 31 00 00 08",
      slaTier: SLATier.ENTERPRISE,
      latitude: 36.365,
      longitude: 6.6147,
    },
  });

  console.log("  ✅ Immeubles créés");

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
        name: `${spec.brand} — moteur de traction`,
        manufacturer: spec.brand,
        expectedLifeHours: 60000,
        currentLifeHours: spec.operatingHours,
      },
      {
        componentType: ComponentType.BRAKE_ASSEMBLY,
        name: `${spec.brand} — ensemble de frein`,
        manufacturer: spec.brand,
        expectedLifeHours: 45000,
        currentLifeHours: spec.operatingHours * 0.9,
      },
      {
        componentType: ComponentType.DOOR_OPERATOR,
        name: `${spec.brand} — opérateur de porte`,
        manufacturer: spec.brand,
        expectedLifeHours: 40000,
        currentLifeHours: spec.operatingHours * 0.85,
      },
      {
        componentType: ComponentType.STEEL_ROPES,
        name: "Câbles de levage en acier (4×)",
        manufacturer: "CERHA",
        expectedLifeHours: 50000,
        currentLifeHours: spec.operatingHours * 0.95,
      },
      {
        componentType: ComponentType.GUIDE_SHOES,
        name: "Patins de guidage (PTFE)",
        manufacturer: "CERHA",
        expectedLifeHours: 35000,
        currentLifeHours: spec.operatingHours * 0.7,
      },
      {
        componentType: ComponentType.CONTROLLER_BOARD,
        name: `${spec.brand} — carte de commande`,
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
        title: "Inspection de sécurité mensuelle",
        description:
          "Inspection de sécurité complète : tension des câbles, essai des freins, contrôle du nivellement et vérification du fonctionnement des portes.",
        frequency: MaintenanceFrequency.MONTHLY,
        nextDueDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
        checklistItems: [
          { name: "Contrôle de la tension des câbles", required: true },
          { name: "Essai du frein d'urgence", required: true },
          { name: "Vérification du nivellement de la cabine", required: true },
          { name: "Graissage du moteur", required: true },
          { name: "Calibration des capteurs de porte", required: true },
          { name: "Essai du téléphone d'urgence", required: true },
          { name: "Inspection de la fosse", required: true },
          { name: "Essai du limiteur de vitesse", required: true },
        ],
      },
    });

    await prisma.maintenanceSchedule.create({
      data: {
        elevatorId: elevator.id,
        title: "Entretien complet trimestriel",
        description:
          "Maintenance approfondie : diagnostic de l'armoire de commande, évaluation du remplacement des câbles et analyse des vibrations du moteur.",
        frequency: MaintenanceFrequency.QUARTERLY,
        nextDueDate: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000),
        checklistItems: [
          { name: "Diagnostic de l'armoire de commande", required: true },
          { name: "Inspection des câbles et évaluation du remplacement", required: true },
          { name: "Analyse spectrale des vibrations du moteur", required: true },
          { name: "Graissage des guides de la cabine", required: true },
          { name: "Inspection des patins du contrepoids", required: true },
          { name: "Inspection des ressorts d'amortisseur", required: true },
          { name: "Essai du parachute", required: true },
        ],
      },
    });
  }

  console.log("  ✅ Ascenseurs, composants et plans d'entretien créés");

  // ─── Threshold Rules ────────────────────────────────────

  // NOTE: no `cabin_load_kg` row. Cabin overload is evaluated against each
  // unit's own `maxPayloadKg` (see `payloadThresholds` in
  // src/lib/iot/thresholds.ts), so an absolute table row would never be read
  // — it previously sat here with 4500/5000 kg and silently did nothing when
  // edited.
  const thresholds = [
    { metricName: "motor_vibration_mm_s", warningMax: 4.0, criticalMax: 7.0, description: "Niveau de vibration du moteur, en mm/s RMS" },
    { metricName: "motor_temperature_c", warningMax: 85, criticalMax: 105, description: "Température des enroulements du moteur, en degrés Celsius" },
    { metricName: "door_speed_ms", warningMax: 1.5, criticalMax: 2.0, warningMin: 0.3, criticalMin: 0.1, description: "Vitesse d'ouverture et de fermeture des portes, en m/s" },
    { metricName: "leveling_offset_mm", warningMax: 8, criticalMax: 15, warningMin: -8, criticalMin: -15, description: "Écart de nivellement à l'étage, en mm" },
    { metricName: "supply_voltage_v", warningMax: 440, criticalMax: 460, warningMin: 360, criticalMin: 340, description: "Tension d'alimentation, en volts" },
    { metricName: "current_draw_a", warningMax: 60, criticalMax: 80, description: "Courant absorbé par le moteur, en ampères" },
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

  console.log("  ✅ Règles de seuil créées");

  // ─── Sample Work Orders ─────────────────────────────────

  const elevators = await prisma.elevator.findMany();

  await prisma.workOrder.create({
    data: {
      orderNumber: "WO-202608-0001",
      title: "Inspection de sécurité mensuelle — Immeuble Le Panorama EL01",
      description: "Inspection de sécurité mensuelle planifiée pour l'ascenseur EP-BLD01-EL01.",
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
      title: "Alerte vibrations élevées — Les Oliviers EL01",
      description:
        "Vibrations du moteur au-delà du seuil de 4,0 mm/s. Inspection immédiate de la fixation du moteur de traction et de l'ensemble de frein requise.",
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
      title: "Urgence : surchauffe moteur — Résidence El Bahia EL01",
      description:
        "CRITIQUE : température du moteur au-delà de 105 °C. Ascenseur à l'arrêt. Inspection immédiate requise.",
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

  console.log("  ✅ Bons de travail d'exemple créés");

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

  console.log(`  ✅ ${ELEVATOR_ERROR_CODES.length} codes d'erreur créés`);

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
      title: "Signalement client – EP-BLD01-EL02",
      description:
        "Signalé par l'immeuble via le portail client.\n" +
        "Ascenseur : EP-BLD01-EL02\n" +
        "Site : Immeuble Le Panorama, 12 rue Didouche Mourad\n\n" +
        "Description du déclarant :\nLes portes restent ouvertes au rez-de-chaussée.",
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

  console.log("  ✅ Signalements client d'exemple créés");

  console.log("\n🎉 Peuplement terminé !\n");
  console.log("  Identifiants de connexion (mot de passe commun : password123) :");
  console.log("    Admin :            admin@elevatorpulse.com");
  console.log("    Responsable :      manager@elevatorpulse.com");
  console.log(`    Technicien 1 :     ${tech1.email}   (${tech1.status})`);
  console.log(`    Technicien 2 :     ${tech2.email}   (${tech2.status})`);
  // Listed so the ON_LEAVE row is visible without a database client: she can
  // sign in, she simply cannot be dispatched.
  console.log(
    `    Technicien 3 :     ${tech3.email}  (${tech3.status} — non affectable)`
  );
  console.log("    Client :           owner@metroplaza.com");
}

main()
  .catch((e) => {
    console.error("Erreur de peuplement :", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
