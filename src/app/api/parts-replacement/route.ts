/**
 * Maintenance RMASC – les demandes de pièces détachées.
 *
 * GET   /api/parts-replacement            – les demandes d'un bon, ou celles
 *                                           qui attendent une décision
 * POST  /api/parts-replacement            – ouvrir une demande depuis le terrain
 * PATCH /api/parts-replacement            – la décision du bureau
 *
 * POURQUOI CETTE ROUTE EXISTE
 * `WorkOrder.partsReplaced` enregistre ce qui a été *posé*. Rien n'enregistrait
 * ce qu'il fallait *commander* : un technicien qui diagnostiquait une carte
 * électronique en fin de vie et ne l'avait pas dans son véhicule le disait au
 * téléphone, et la pièce se commandait sur parole. Le bon, lui, restait ouvert
 * sans que rien ne dise pourquoi.
 *
 * C'est la même distinction que celle du schéma, et elle commande tout le reste
 * de ce fichier : une demande précède l'intervention qui la posera, elle porte
 * une urgence et une décision, et elle peut être refusée.
 *
 * LIRE EST OUVERT AU TERRAIN, DÉCIDER NON
 * Un technicien doit pouvoir relire ce qu'il a demandé et ce qu'on lui a
 * répondu — sans quoi il repose la question au téléphone, ce que cette route
 * existe pour éviter. Valider une dépense ne se délègue pas : `PATCH` demande
 * les rôles de gestion, comme l'émission d'une facture.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  badRequest,
  conflict,
  forbidden,
  handleRouteError,
  jsonOk,
  notFound,
  parseEnumParam,
  readJson,
} from "@/lib/api/http";
import {
  MANAGEMENT_ROLES,
  OPS_ROLES,
  buildingScopeFor,
  requireRole,
} from "@/lib/api/guard";
import { generatePartRequestNumber } from "@/lib/ids";
import { transitionRefusal } from "@/lib/parts/status";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoPartRequirements } from "@/lib/demo/responses";
import { PART_REQUIREMENT_STATUSES, PART_URGENCIES } from "@/types";
import type { PartRequirementStatus } from "@/types";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

/** Ce qu'une demande montre dans une liste. */
const LIST_SELECT = {
  id: true,
  number: true,
  status: true,
  urgency: true,
  quantity: true,
  faultyPartName: true,
  faultyPartReference: true,
  replacementPartName: true,
  replacementPartReference: true,
  notes: true,
  createdAt: true,
  statusChangedAt: true,
  fulfilledAt: true,
  workOrderId: true,
  requestedBy: { select: { id: true, name: true } },
  statusChangedBy: { select: { id: true, name: true } },
} satisfies Prisma.PartRequirementSelect;

const CreateSchema = z
  .object({
    workOrderId: z.string().trim().min(1, "Le bon de travail est obligatoire"),
    faultyPartName: z.string().trim().min(1).max(200),
    faultyPartReference: z.string().trim().max(200).optional(),
    replacementPartName: z.string().trim().min(1).max(200),
    replacementPartReference: z.string().trim().max(200).optional(),
    quantity: z.number().int().min(1).max(999).default(1),
    urgency: z.enum(PART_URGENCIES).default("PREVENTIVE"),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

/**
 * Le périmètre de lecture, par la même règle que les rapports d'inspection.
 *
 * Un technicien ne lit que les demandes ouvertes sur *ses* interventions. Le
 * cloisonnement passe par la relation au bon de travail plutôt que par un
 * identifiant recopié : il n'y a donc rien à tenir à jour, et un bon réaffecté
 * emmène ses demandes avec lui.
 *
 * Les rôles de gestion voient tout le parc actif, comme partout ailleurs.
 */
function scopeFor(
  session: Awaited<ReturnType<typeof requireRole>>
): Prisma.PartRequirementWhereInput {
  if (session.user.role === "FIELD_TECHNICIAN") {
    return { workOrder: { assignedToId: session.user.id } };
  }
  return { workOrder: { elevator: { building: buildingScopeFor(session) } } };
}

export async function GET(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES);
    const { searchParams } = request.nextUrl;

    const workOrderId = searchParams.get("workOrderId") || undefined;
    const elevatorId = searchParams.get("elevatorId") || undefined;
    const status = parseEnumParam(
      searchParams,
      "status",
      PART_REQUIREMENT_STATUSES
    );

    const where: Prisma.PartRequirementWhereInput = {
      ...(workOrderId ? { workOrderId } : {}),
      ...(elevatorId ? { workOrder: { elevatorId } } : {}),
      ...(status ? { status } : {}),
      // Le périmètre est étalé en dernier et écrase : un filtre de confort ne
      // peut pas élargir un droit. Voir le registre des factures, même règle.
      ...scopeFor(session),
    };

    const rows = await prisma.partRequirement.findMany({
      where,
      select: LIST_SELECT,
      /**
       * L'urgence d'abord, puis la plus ancienne.
       *
       * `orderBy` sur une énumération suit l'ordre de déclaration dans le
       * schéma, et `PartUrgency` est déclaré `IMMEDIATE` avant `PREVENTIVE` :
       * un tri croissant fait donc remonter ce qui immobilise un appareil. Une
       * demande urgente et vieille de trois semaines passe en tête, et c'est
       * exactement la ligne qu'un bureau doit voir en premier.
       */
      orderBy: [{ urgency: "asc" }, { createdAt: "asc" }],
    });

    return NextResponse.json({ data: rows, total: rows.length });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/parts-replacement");
      const { searchParams } = request.nextUrl;
      return NextResponse.json(
        demoPartRequirements({
          workOrderId: searchParams.get("workOrderId") || undefined,
          status: searchParams.get("status") || undefined,
        })
      );
    }
    return handleRouteError(error);
  }
}

/**
 * Ouvre une demande.
 *
 * LE NUMÉRO PEUT COLLISIONNER, ET C'EST PRÉVU
 * `generatePartRequestNumber` tire un suffixe au hasard sur une colonne unique,
 * comme les autres références du produit. Une collision est improbable mais
 * possible, et elle doit se résoudre en réessayant — pas en rendant une erreur
 * au technicien qui vient de saisir sa demande depuis un toit. Une seule
 * nouvelle tentative : deux collisions d'affilée ne sont plus de la malchance.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES);
    const body = CreateSchema.parse(await readJson(request));

    const workOrder = await prisma.workOrder.findUnique({
      where: { id: body.workOrderId },
      select: { id: true, orderNumber: true, assignedToId: true, status: true },
    });
    if (!workOrder) {
      throw notFound(`Bon de travail introuvable : ${body.workOrderId}`);
    }

    /**
     * Un technicien ne demande une pièce que pour une intervention qui lui est
     * affectée. La règle est celle du dépôt de rapport, et pour la même raison :
     * le bon de travail est l'unité d'autorisation.
     */
    const isManager =
      session.user.role === "ADMIN" ||
      session.user.role === "MAINTENANCE_MANAGER";
    if (!isManager && workOrder.assignedToId !== session.user.id) {
      throw forbidden(
        "Vous ne pouvez demander une pièce que pour une intervention qui vous est affectée."
      );
    }

    // Une demande sur un bon annulé ne serait rattachée à rien : personne ne
    // viendra poser la pièce.
    if (workOrder.status === "CANCELLED") {
      throw badRequest(
        "Impossible de demander une pièce pour un bon de travail annulé."
      );
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const created = await prisma.partRequirement.create({
          data: {
            number: generatePartRequestNumber(),
            workOrderId: workOrder.id,
            requestedById: session.user.id ?? null,
            faultyPartName: body.faultyPartName,
            faultyPartReference: body.faultyPartReference,
            replacementPartName: body.replacementPartName,
            replacementPartReference: body.replacementPartReference,
            quantity: body.quantity,
            urgency: body.urgency,
            notes: body.notes,
          },
          select: LIST_SELECT,
        });

        return NextResponse.json({ data: created }, { status: 201 });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "P2002" || attempt === 1) throw error;
        console.warn("[parts] collision de numéro, nouvelle tentative");
      }
    }

    // Inatteignable : la boucle renvoie ou relance.
    throw conflict("La demande n'a pas pu être enregistrée.");
  } catch (error) {
    return handleRouteError(error);
  }
}

const DecideSchema = z
  .object({
    id: z.string().trim().min(1, "La demande est obligatoire"),
    status: z.enum(PART_REQUIREMENT_STATUSES),
  })
  .strict();

/**
 * La décision du bureau.
 *
 * LA RÈGLE VIT DANS `lib/parts/status.ts`
 * et non ici : l'écran doit offrir exactement les boutons que cette route
 * accepte. Une règle écrite deux fois finit par diverger, et le bouton qui
 * échoue est ce que l'utilisateur voit de la divergence.
 *
 * IDEMPOTENTE : reposer l'état qu'une demande porte déjà réussit et n'écrit
 * rien. L'écran n'a pas à distinguer « je l'ai validée » de « elle l'était ».
 */
export async function PATCH(request: NextRequest) {
  try {
    const session = await requireRole(...MANAGEMENT_ROLES);
    const parsed = DecideSchema.parse(await readJson(request));

    const existing = await prisma.partRequirement.findUnique({
      where: { id: parsed.id },
      select: { id: true, number: true, status: true, workOrderId: true },
    });
    if (!existing) {
      throw notFound(`Demande de pièce introuvable : ${parsed.id}`);
    }

    if (existing.status === parsed.status) {
      const unchanged = await prisma.partRequirement.findUnique({
        where: { id: parsed.id },
        select: LIST_SELECT,
      });
      return jsonOk(unchanged);
    }

    const refusal = transitionRefusal(
      existing.status,
      parsed.status as PartRequirementStatus
    );
    if (refusal) throw badRequest(refusal);

    const now = new Date();
    const updated = await prisma.partRequirement.update({
      where: { id: parsed.id },
      data: {
        status: parsed.status,
        statusChangedAt: now,
        statusChangedById: session.user.id ?? null,
        /**
         * `fulfilledAt` est posé une fois et retiré quand on revient en arrière.
         * Le laisser derrière une réouverture ferait lire « pièce posée le 3
         * mars » sur une demande redevenue en attente — et c'est exactement la
         * ligne qu'on lit six mois plus tard pour savoir si la pièce a été
         * montée.
         */
        fulfilledAt: parsed.status === "FULFILLED" ? now : null,
      },
      select: LIST_SELECT,
    });

    return jsonOk(updated);
  } catch (error) {
    return handleRouteError(error);
  }
}
