/**
 * Test fonctionnel de bout en bout — deux parcours.
 *
 *   1. Panne urgente signalée par un client, dispatchée, exécutée, clôturée.
 *   2. Visite d'entretien préventive sur un immeuble hors contrat, exécutée,
 *      rapportée, facturée et archivée.
 *
 * Le script pilote les routes HTTP réelles avec une session NextAuth, puis
 * relit PostgreSQL pour vérifier ce qui a été écrit. Il laisse les traces en
 * base, préfixées `E2E`, pour que le bilan soit auditable.
 *
 *   npx tsx scripts/e2e-scenarios.ts
 *
 * Prérequis : `node pg-local/start-pg.mjs` et `npm run dev` en marche.
 */

import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:3000";
const PASSWORD = "password123";
const RUN = new Date().toISOString().slice(0, 19).replace("T", " ");

let cookies = new Map<string, string>();

function record(line: string) {
  console.log(line);
}

function absorb(response: Response) {
  const list =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  for (const cookie of list) {
    const [pair] = cookie.split(";");
    const index = pair.indexOf("=");
    if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
}

function cookieHeader() {
  return [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
}

async function login(email: string) {
  cookies = new Map();

  let response = await fetch(`${BASE}/api/auth/csrf`);
  absorb(response);
  const { csrfToken } = (await response.json()) as { csrfToken: string };

  const form = new URLSearchParams({
    csrfToken,
    email,
    password: PASSWORD,
    callbackUrl: `${BASE}/tableau-de-bord`,
    json: "true",
  });

  response = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      cookie: cookieHeader(),
    },
    body: form,
  });
  absorb(response);

  const session = (await fetch(`${BASE}/api/auth/session`, {
    headers: { cookie: cookieHeader() },
  }).then((res) => res.json())) as {
    user?: { email?: string; role?: string };
  };

  if (!session?.user?.email) {
    throw new Error(`Connexion impossible pour ${email}`);
  }

  record(`  [auth] ${session.user.email} (${session.user.role})`);
  return session.user;
}

async function api(
  method: string,
  path: string,
  body?: unknown
): Promise<Record<string, unknown>> {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      cookie: cookieHeader(),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const json = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  if (!response.ok) {
    throw new Error(
      `${method} ${path} → ${response.status} ${JSON.stringify(json)}`
    );
  }

  record(`  [http] ${method} ${path} → ${response.status}`);
  return json ?? {};
}

function isoInDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

async function main() {
  const env = readFileSync(".env", "utf8");
  const line = env.split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
  if (line && !process.env.DATABASE_URL) {
    process.env.DATABASE_URL = line
      .slice("DATABASE_URL=".length)
      .replace(/^"|"$/g, "");
  }

  const { prisma } = await import("../src/lib/db/prisma");

  const results: {
    scenario: string;
    ok: boolean;
    details: string;
    error?: string;
  }[] = [];

  // ── Contexte ─────────────────────────────────────────────
  const admin = await prisma.user.findUnique({
    where: { email: "admin@elevatorpulse.com" },
    select: { id: true, email: true },
  });
  const contractedUnit = await prisma.elevator.findFirst({
    where: {
      isActive: true,
      building: { isActive: true, owner: { clientType: "CONTRACTED" } },
    },
    select: {
      id: true,
      elevatorCode: true,
      building: { select: { id: true, name: true, latitude: true, longitude: true } },
    },
  });
  const offContractUnit = await prisma.elevator.findFirst({
    where: {
      isActive: true,
      building: {
        isActive: true,
        OR: [{ ownerId: null }, { owner: { clientType: "NON_CONTRACTED" } }],
      },
    },
    select: {
      id: true,
      elevatorCode: true,
      building: { select: { id: true, name: true, latitude: true, longitude: true } },
    },
  });
  const availableTech = await prisma.user.findFirst({
    where: { role: "FIELD_TECHNICIAN", isActive: true, status: "AVAILABLE" },
    select: { id: true, email: true, name: true },
  });

  if (!admin || !contractedUnit || !offContractUnit || !availableTech) {
    throw new Error(
      "Contexte insuffisant : compte admin, appareil sous contrat, appareil hors contrat ou technicien disponible manquant."
    );
  }

  record(`\n=== E2E ${RUN} ===`);
  record(
    `Contexte : ${contractedUnit.elevatorCode} (${contractedUnit.building.name}), ` +
      `${offContractUnit.elevatorCode} hors contrat (${offContractUnit.building.name}), ` +
      `technicien ${availableTech.name}`
  );

  // ══════════════════════════════════════════════════════════
  // SCÉNARIO 1 — Panne urgente
  // ══════════════════════════════════════════════════════════
  record("\n--- SCÉNARIO 1 : signalement de panne urgente ---");
  let incidentId = "";
  let workOrderId = "";

  try {
    await login(admin.email);

    const created = await api("POST", "/api/incidents", {
      elevatorId: contractedUnit.id,
      status: "ESCALATED",
      isDirectTransfer: true,
      notes: `E2E ${RUN} — surcharge / blocage cabine, client coincé au 3e.`,
    });
    const incident = created.data as {
      id: string;
      incidentNumber: string;
      status: string;
      technician: { id: string; email: string; name: string | null } | null;
      workOrder: { id: string; orderNumber: string; status: string } | null;
    };
    incidentId = incident.id;
    if (!incident.workOrder) throw new Error("Aucun bon de travail créé.");
    workOrderId = incident.workOrder.id;
    record(
      `  incident ${incident.incidentNumber} → ${incident.status}, bon ${incident.workOrder.orderNumber}`
    );

    let technician = incident.technician;
    if (!technician) {
      const dispatched = await api("PATCH", `/api/incidents/${incident.id}`, {
        action: "dispatch",
        technicianId: availableTech.id,
      });
      const row = dispatched.data as {
        technician: { id: string; email: string; name: string | null } | null;
      };
      technician = row.technician;
    }
    if (!technician) throw new Error("Dispatch sans technicien.");
    record(`  technicien affecté : ${technician.name ?? technician.email}`);

    await login(technician.email);
    await api("POST", `/api/work-orders/${workOrderId}/check-in`, {
      notes: `E2E ${RUN} — arrivée sur site`,
      ...(contractedUnit.building.latitude !== null &&
      contractedUnit.building.longitude !== null
        ? {
            latitude: contractedUnit.building.latitude,
            longitude: contractedUnit.building.longitude,
          }
        : {}),
    });
    const afterCheckIn = await prisma.incidentReport.findUnique({
      where: { id: incidentId },
      select: { status: true, workOrder: { select: { status: true } } },
    });
    record(
      `  pointage terrain → incident ${afterCheckIn?.status}, bon ${afterCheckIn?.workOrder?.status}`
    );

    await api("PATCH", `/api/work-orders?id=${workOrderId}`, {
      status: "PENDING_APPROVAL",
      notes: `E2E ${RUN} — contact de porte remplacé, essais conformes.`,
      isBillable: true,
      invoiceAmount: 12500,
      partsReplaced: [
        { name: "Contact de porte palière", partNumber: "DV-12-R", qty: 1 },
      ],
    });
    record("  rapport terrain déposé (PENDING_APPROVAL)");

    await login(admin.email);
    await api("PATCH", `/api/work-orders?id=${workOrderId}`, {
      status: "COMPLETED",
    });
    record("  bon validé et clôturé par le bureau");

    const after = await prisma.incidentReport.findUnique({
      where: { id: incidentId },
      select: {
        status: true,
        workOrder: {
          select: {
            status: true,
            startedAt: true,
            reportSubmittedAt: true,
            completedAt: true,
            revisions: { select: { id: true } },
            notifications: { select: { id: true, type: true } },
          },
        },
      },
    });

    const ok =
      after?.status === "CLOSED" &&
      after.workOrder?.status === "COMPLETED" &&
      Boolean(after.workOrder.startedAt) &&
      Boolean(after.workOrder.reportSubmittedAt) &&
      Boolean(after.workOrder.completedAt);

    results.push({
      scenario: "1. Panne urgente",
      ok,
      details:
        `incident=${after?.status} · bon=${after?.workOrder?.status} · ` +
        `started=${after?.workOrder?.startedAt?.toISOString() ?? "—"} · ` +
        `report=${after?.workOrder?.reportSubmittedAt?.toISOString() ?? "—"} · ` +
        `closed=${after?.workOrder?.completedAt?.toISOString() ?? "—"} · ` +
        `révisions=${after?.workOrder?.revisions.length ?? 0}`,
    });
  } catch (error) {
    results.push({
      scenario: "1. Panne urgente",
      ok: false,
      details: `incident=${incidentId || "—"} · bon=${workOrderId || "—"}`,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ══════════════════════════════════════════════════════════
  // SCÉNARIO 2 — Entretien préventif hors contrat
  // ══════════════════════════════════════════════════════════
  record("\n--- SCÉNARIO 2 : entretien préventif hors contrat ---");
  let scheduleId = "";
  let visitOrderId = "";
  let invoiceNumber = "";
  let quoteNumber = "";

  try {
    await login(admin.email);

    const schedule = await api("POST", "/api/maintenance-schedules", {
      elevatorId: offContractUnit.id,
      title: `E2E ${RUN} — visite préventive hors contrat`,
      description: "Contrôle trimestriel de sécurité, immeuble sans contrat.",
      frequency: "QUARTERLY",
      cycleThreshold: null,
      nextDueDate: isoInDays(10),
      checklistItems: [
        { name: "Freins et limiteur de vitesse", required: true },
        { name: "Portes palières et verrouillage", required: true },
        { name: "Nivellement à l'étage", required: true },
        { name: "Éclairage de cabine", required: false },
      ],
    });
    scheduleId = (schedule.data as { id: string }).id;
    record(`  programme créé ${scheduleId}`);

    const planned = await api(
      "POST",
      `/api/maintenance-schedules/${scheduleId}/plan`,
      { scheduledDate: isoInDays(2), assignedToId: availableTech.id }
    );
    const visit = planned.data as { id: string; orderNumber: string };
    visitOrderId = visit.id;
    record(`  visite planifiée → bon ${visit.orderNumber}`);

    await login(availableTech.email);
    await api("POST", `/api/work-orders/${visitOrderId}/check-in`, {
      notes: `E2E ${RUN} — arrivée sur site (visite préventive)`,
      ...(offContractUnit.building.latitude !== null &&
      offContractUnit.building.longitude !== null
        ? {
            latitude: offContractUnit.building.latitude,
            longitude: offContractUnit.building.longitude,
          }
        : {}),
    });
    record("  pointage terrain du bon de visite");

    const report = await api("POST", "/api/inspection-reports", {
      workOrderId: visitOrderId,
      kind: "INSPECTION",
      title: `E2E ${RUN} — rapport de visite préventive`,
      summary:
        "Visite trimestrielle réalisée. Aucune non-conformité bloquante ; éclairage de cabine à surveiller.",
      items: [
        { checkName: "Freins et limiteur de vitesse", result: "PASS" },
        { checkName: "Portes palières et verrouillage", result: "PASS" },
        { checkName: "Nivellement à l'étage", result: "PASS" },
        {
          checkName: "Éclairage de cabine",
          result: "NEEDS_ATTENTION",
          notes: "Tube clignotant, à remplacer à la prochaine visite.",
        },
      ],
      signatures: [
        {
          role: "TECHNICIAN",
          name: availableTech.name,
          method: "TYPED",
        },
      ],
    });
    const reportRow = report.data as { reportNumber: string };
    record(`  rapport d'inspection ${reportRow.reportNumber} déposé`);

    await api("PATCH", `/api/work-orders?id=${visitOrderId}`, {
      status: "PENDING_APPROVAL",
      notes: `E2E ${RUN} — visite réalisée, 4 points contrôlés.`,
      isBillable: true,
      invoiceAmount: 9000,
    });
    record("  bon passé À valider (prestation hors contrat facturable)");

    await login(admin.email);
    await api("PATCH", `/api/work-orders?id=${visitOrderId}`, {
      status: "COMPLETED",
    });

    const invoice = await api("POST", "/api/invoices", {
      workOrderId: visitOrderId,
    });
    invoiceNumber = (invoice.data as { number: string }).number;
    record(`  facture ${invoiceNumber} émise`);

    const quote = await api("POST", "/api/quotes", {
      buildingId: offContractUnit.building.id,
      elevatorId: offContractUnit.id,
      need:
        "Remplacement du tube d'éclairage de cabine et mise en conformité de l'éclairage de secours.",
      validityDays: 30,
    });
    quoteNumber = (quote.data as { number: string }).number;
    record(`  devis complémentaire ${quoteNumber} suggéré`);

    const [scheduleAfter, orderAfter, reportAfter, invoiceAfter, quoteAfter] =
      await Promise.all([
        prisma.maintenanceSchedule.findUnique({
          where: { id: scheduleId },
          select: { lastCompleted: true, nextDueDate: true },
        }),
        prisma.workOrder.findUnique({
          where: { id: visitOrderId },
          select: { status: true, completedAt: true, invoiceAmount: true },
        }),
        prisma.inspectionReport.findFirst({
          where: { workOrderId: visitOrderId },
          select: { reportNumber: true, overallResult: true, submittedAt: true },
        }),
        prisma.invoice.findUnique({
          where: { number: invoiceNumber },
          select: { number: true, status: true, amount: true, workOrderId: true },
        }),
        prisma.quote.findFirst({
          where: { buildingId: offContractUnit.building.id },
          orderBy: { createdAt: "desc" },
          select: { number: true, status: true },
        }),
      ]);

    const ok =
      orderAfter?.status === "COMPLETED" &&
      Boolean(scheduleAfter?.lastCompleted) &&
      Boolean(reportAfter) &&
      invoiceAfter?.status === "ISSUED" &&
      quoteAfter?.number === quoteNumber;

    results.push({
      scenario: "2. Entretien préventif hors contrat",
      ok,
      details:
        `bon=${orderAfter?.status} · rapport=${reportAfter?.overallResult ?? "—"} · ` +
        `facture=${invoiceAfter?.number ?? "—"}/${invoiceAfter?.status ?? "—"} · ` +
        `devis=${quoteAfter?.number ?? "—"}/${quoteAfter?.status ?? "—"} · ` +
        `prochaine échéance=${scheduleAfter?.nextDueDate?.toISOString().slice(0, 10) ?? "—"}`,
    });
  } catch (error) {
    results.push({
      scenario: "2. Entretien préventif hors contrat",
      ok: false,
      details: `programme=${scheduleId || "—"} · bon=${visitOrderId || "—"}`,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ── Bilan ────────────────────────────────────────────────
  record("\n=== BILAN ===");
  for (const result of results) {
    record(
      `${result.ok ? "OK  " : "ÉCHEC"} ${result.scenario}\n      ${result.details}${
        result.error ? `\n      erreur: ${result.error}` : ""
      }`
    );
  }

  await prisma.$disconnect();

  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

void main();
