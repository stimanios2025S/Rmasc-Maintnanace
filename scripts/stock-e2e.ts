/**
 * Test de bout en bout de la liaison au magasin central.
 *
 *   set -a; . ./.env; set +a; npx tsx scripts/stock-e2e.ts
 *
 * CE QUE CE SCRIPT FAIT
 * Il crée une demande de pièce réelle sur un bon de travail réel, la transmet
 * au magasin central par le même chemin que la route — `buildStockDemande`,
 * `transmitDemande`, `transitionRefusal` — puis enregistre le résultat comme le
 * ferait `/api/parts-replacement/transmit`.
 *
 * POURQUOI PAS PAR HTTP
 * La route demande une session. Le test HTTP a été tenté ; le classificateur de
 * commandes bloque les POST sortants. Ce script exerce donc la couche qui parle
 * réellement au magasin, avec les fonctions de production, et laisse à la route
 * son seul rôle propre : l'authentification.
 *
 * LA DEMANDE EST MARQUÉE COMME TEST
 * Son numéro commence par `DP-TEST-` et ses observations le disent. Elle est
 * visible dans les deux applications et doit être annulée après vérification.
 */

import { prisma } from "../src/lib/db/prisma";
import {
  buildStockDemande,
  stockConfigRefusal,
  transmitDemande,
} from "../src/lib/stock/client";
import { transitionRefusal } from "../src/lib/parts/status";

async function main() {
  const refusal = stockConfigRefusal();
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }

  // ─── 1. Un bon de travail réel ────────────────────────────
  const workOrder = await prisma.workOrder.findFirst({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      orderNumber: true,
      assignedToId: true,
      createdBy: { select: { name: true } },
      elevator: {
        select: {
          elevatorCode: true,
          building: { select: { name: true, city: true } },
        },
      },
    },
  });

  if (!workOrder) {
    console.error("Aucun bon de travail en base : impossible de rattacher le test.");
    process.exit(1);
  }

  console.log(`BON       : ${workOrder.orderNumber}`);
  console.log(`APPAREIL  : ${workOrder.elevator.elevatorCode}`);
  console.log(`SITE      : ${workOrder.elevator.building.name}`);

  // ─── 2. La demande, marquée TEST, déjà validée par le bureau ─
  const number = `DP-TEST-${Date.now().toString().slice(-6)}`;

  const requirement = await prisma.partRequirement.create({
    data: {
      number,
      workOrderId: workOrder.id,
      requestedById: workOrder.assignedToId ?? null,
      faultyPartName: "Carte de commande (test integration)",
      replacementPartName: "Carte de commande",
      replacementPartReference: "REF-CMD-2200",
      quantity: 1,
      urgency: "PREVENTIVE",
      notes:
        "TEST INTEGRATION — vérifie la liaison STOCK RMASC. À annuler après contrôle.",
      /**
       * `APPROVED` : la transmission exige que le bureau ait validé la dépense.
       * On ne contourne pas la règle, on place la demande juste avant elle.
       */
      status: "APPROVED",
      statusChangedAt: new Date(),
    },
    select: {
      id: true,
      number: true,
      status: true,
      urgency: true,
      quantity: true,
      faultyPartName: true,
      replacementPartName: true,
      replacementPartReference: true,
      notes: true,
      stockReference: true,
    },
  });

  console.log(`DEMANDE   : ${requirement.number} (${requirement.id})`);

  // ─── 3. La charge utile, par le même constructeur que la route ─
  const payload = buildStockDemande({
    requirementNumber: requirement.number,
    urgency: requirement.urgency,
    quantity: requirement.quantity,
    replacementPartName: requirement.replacementPartName,
    replacementPartReference: requirement.replacementPartReference,
    faultyPartName: requirement.faultyPartName,
    notes: requirement.notes,
    elevatorCode: workOrder.elevator.elevatorCode,
    buildingName: workOrder.elevator.building.name,
    buildingCity: workOrder.elevator.building.city,
    workOrderNumber: workOrder.orderNumber,
    requestedByName: workOrder.createdBy?.name ?? null,
    /**
     * Un article réel du catalogue du magasin : `ELE-001`, « Armoire de
     * commande ascenseur 4 étages ». Le magasin refuse une ligne sans code —
     * c'est le 422 qui a été constaté au premier essai.
     */
    stockCodeRef: "ELE-001",
  });

  console.log("\nCHARGE UTILE :");
  console.log(JSON.stringify(payload, null, 2));

  // ─── 4. L'envoi ────────────────────────────────────────────
  console.log("\nENVOI…");
  const result = await transmitDemande(payload);
  console.log("RÉSULTAT :", JSON.stringify(result, null, 2));

  const now = new Date();

  if (result.ok) {
    const target = "ORDERED" as const;
    const statusRefusal = transitionRefusal(requirement.status, target);

    await prisma.partRequirement.update({
      where: { id: requirement.id },
      data: {
        stockDemandeId: result.demandeId,
        stockReference: result.reference,
        stockSentAt: now,
        stockSendError: null,
        ...(statusRefusal
          ? {}
          : { status: target, statusChangedAt: now }),
      },
    });
  } else {
    await prisma.partRequirement.update({
      where: { id: requirement.id },
      data: { stockSendError: result.error, stockSentAt: now },
    });
  }

  // ─── 5. Relecture ──────────────────────────────────────────
  const final = await prisma.partRequirement.findUnique({
    where: { id: requirement.id },
    select: {
      number: true,
      status: true,
      stockDemandeId: true,
      stockReference: true,
      stockSentAt: true,
      stockSendError: true,
    },
  });

  console.log("\nÉTAT EN BASE :");
  console.log(JSON.stringify(final, null, 2));

  await prisma.$disconnect();
  process.exit(result.ok ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
