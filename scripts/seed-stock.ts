/**
 * Remplit la réserve locale du magasin avec un catalogue de démonstration.
 *
 * Idempotent : `upsert` par référence, donc relancer le script ne duplique rien
 * et ne remet pas à zéro une quantité que le magasinier aurait déjà décrémentée
 * — l'`update` ne touche qu'aux libellés, à la catégorie, au prix et au seuil.
 *
 * Crée aussi trois demandes de pièces de démonstration sur des bons ouverts,
 * pour que la console « Demandes de pièces » ne soit pas vide au premier
 * lancement.
 *
 * À lancer une fois sur un poste de développement :
 *   npx tsx scripts/seed-stock.ts
 */

import { readFileSync } from "node:fs";

const items = [
  {
    reference: "FUJI-VVVF-15",
    name: "Variateur Fuji 15 kW",
    category: "Électronique",
    quantity: 1,
    reorderThreshold: 2,
    unitPrice: 145000,
    location: "Allée C · casier 2",
  },
  {
    reference: "GG-80-KIT",
    name: "Jeu de patins de guidage",
    category: "Guidage",
    quantity: 2,
    reorderThreshold: 3,
    unitPrice: 18500,
    location: "Allée B · radeau 1",
  },
  {
    reference: "BTN-PAL-01",
    name: "Boutons palier",
    category: "Portes",
    quantity: 25,
    reorderThreshold: 10,
    unitPrice: 1200,
    location: "Allée A · casier 8",
  },
  {
    reference: "REL-24V",
    name: "Relais 24 V",
    category: "Électronique",
    quantity: 4,
    reorderThreshold: 5,
    unitPrice: 3500,
    location: "Allée C · radeau 1",
  },
  {
    reference: "CAB-6X19-8",
    name: "Câbles de traction 6x19 Ø8",
    category: "Câbles",
    quantity: 0,
    reorderThreshold: 1,
    unitPrice: 95000,
    location: "Hors stock · sur commande",
  },
  {
    reference: "MPB-3400-R2",
    name: "Carte de commande",
    category: "Électronique",
    quantity: 3,
    reorderThreshold: 1,
    unitPrice: 82000,
    location: "Allée A · radeau 2",
  },
  {
    reference: "DV-12-R",
    name: "Verrou de porte palière",
    category: "Portes",
    quantity: 6,
    reorderThreshold: 3,
    unitPrice: 7800,
    location: "Allée A · casier 4",
  },
  {
    reference: "LIM-VIT-450",
    name: "Limiteur de vitesse",
    category: "Sécurité",
    quantity: 1,
    reorderThreshold: 1,
    unitPrice: 64000,
    location: "Allée C · radeau 3",
  },
];

async function main() {
  // `prisma` lit `DATABASE_URL` dans l'environnement ; un script lancé par tsx
  // ne passe pas par le chargeur de Next. On lit donc le `.env` à la main.
  const envFile = readFileSync(".env", "utf8");
  const databaseUrl = envFile
    .split(/\r?\n/)
    .find((line) => line.startsWith("DATABASE_URL="));
  if (databaseUrl && !process.env.DATABASE_URL) {
    process.env.DATABASE_URL = databaseUrl
      .slice("DATABASE_URL=".length)
      .replace(/^"|"$/g, "");
  }

  const { prisma } = await import("../src/lib/db/prisma");

  for (const item of items) {
    await prisma.stockItem.upsert({
      where: { reference: item.reference },
      update: {
        name: item.name,
        category: item.category,
        reorderThreshold: item.reorderThreshold,
        unitPrice: item.unitPrice,
        location: item.location,
      },
      create: item,
    });
  }

  /**
   * Trois demandes de démonstration, rattachées à de vrais bons ouverts.
   *
   * Elles couvrent trois états du circuit : à vérifier au stock, en rupture à
   * commander, et commandée. Les numéros sont fixes et l'`upsert` ne réécrit
   * rien : une demande que le bureau a déjà traitée le reste au prochain seed.
   */
  const openWorkOrders = await prisma.workOrder.findMany({
    where: {
      status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS", "ON_HOLD"] },
    },
    orderBy: { createdAt: "desc" },
    take: 3,
    select: {
      id: true,
      assignedToId: true,
      elevator: { select: { elevatorCode: true } },
    },
  });

  const admin = await prisma.user.findFirst({
    where: { role: "ADMIN", isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  const demoRequests = [
    {
      number: "DP-DEMO-001",
      faultyPartName: "Patins de guidage usés",
      faultyPartReference: "GG-OLD",
      replacementPartName: "Jeu de patins de guidage",
      replacementPartReference: "GG-80-KIT",
      quantity: 1,
      urgency: "IMMEDIATE" as const,
      status: "PENDING_STOCK_CHECK" as const,
      notes: "Usure constatée sur les quatre patins ; jeu complet à remplacer.",
    },
    {
      number: "DP-DEMO-002",
      faultyPartName: "Variateur Fuji en défaut",
      faultyPartReference: "FUJI-OLD",
      replacementPartName: "Variateur Fuji 15 kW",
      replacementPartReference: "FUJI-VVVF-15",
      quantity: 1,
      urgency: "IMMEDIATE" as const,
      status: "ORDER_REQUIRED" as const,
      notes: "Variateur hors stock : approvisionnement à lancer avant la repose.",
    },
    {
      number: "DP-DEMO-003",
      faultyPartName: "Relais de sécurité fatigué",
      faultyPartReference: "REL-24V",
      replacementPartName: "Relais 24 V",
      replacementPartReference: "REL-24V",
      quantity: 2,
      urgency: "PREVENTIVE" as const,
      status: "ORDERED" as const,
      notes: "Remplacement préventif programmé avec la prochaine visite.",
    },
  ];

  if (openWorkOrders.length === 0) {
    console.log(
      "Aucun bon ouvert : les demandes de démonstration n'ont pas été créées."
    );
  } else {
    for (const [index, request] of demoRequests.entries()) {
      const workOrder = openWorkOrders[index % openWorkOrders.length];
      await prisma.partRequirement.upsert({
        where: { number: request.number },
        // Une demande déjà traitée par le bureau garde son état.
        update: {},
        create: {
          number: request.number,
          workOrderId: workOrder.id,
          requestedById: workOrder.assignedToId,
          faultyPartName: request.faultyPartName,
          faultyPartReference: request.faultyPartReference,
          replacementPartName: request.replacementPartName,
          replacementPartReference: request.replacementPartReference,
          quantity: request.quantity,
          urgency: request.urgency,
          notes: request.notes,
          status: request.status,
          statusChangedAt:
            request.status === "PENDING_STOCK_CHECK" ? null : new Date(),
          statusChangedById:
            request.status === "PENDING_STOCK_CHECK" ? null : admin?.id ?? null,
        },
      });
    }
    console.log(
      `${demoRequests.length} demandes de pièces de démonstration disponibles.`
    );
  }

  console.log(`${items.length} articles de réserve disponibles.`);
  await prisma.$disconnect();
}

void main();
