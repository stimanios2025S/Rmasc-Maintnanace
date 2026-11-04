import { readFileSync } from "node:fs";

async function main() {
  const env = readFileSync(".env", "utf8");
  const line = env.split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
  if (line) {
    process.env.DATABASE_URL = line
      .slice("DATABASE_URL=".length)
      .replace(/^"|"$/g, "");
  }
  const { prisma } = await import("../src/lib/db/prisma");

  const buildings = await prisma.building.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      owner: { select: { id: true, email: true, clientType: true } },
      elevators: {
        where: { isActive: true },
        select: { id: true, elevatorCode: true, status: true },
        take: 3,
      },
    },
  });
  console.log("BUILDINGS");
  for (const b of buildings) {
    console.log(
      `${b.id} | ${b.name} | owner=${b.owner?.email ?? "—"} type=${b.owner?.clientType ?? "—"} | elevators=${b.elevators.map((e) => `${e.id}:${e.elevatorCode}`).join(",")}`
    );
  }

  const techs = await prisma.user.findMany({
    where: { role: "FIELD_TECHNICIAN", isActive: true },
    select: { id: true, email: true, name: true, status: true },
  });
  console.log("TECHNICIANS");
  for (const t of techs) console.log(`${t.id} | ${t.email} | ${t.name} | ${t.status}`);

  console.log("COUNTS", {
    schedules: await prisma.maintenanceSchedule.count(),
    workOrders: await prisma.workOrder.count(),
    incidents: await prisma.incidentReport.count(),
    reports: await prisma.inspectionReport.count(),
    invoices: await prisma.invoice.count(),
    quotes: await prisma.quote.count(),
  });

  await prisma.$disconnect();
}

void main();
