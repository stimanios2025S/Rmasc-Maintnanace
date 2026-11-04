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
import { notify } from "@/lib/notifications/service";
import { notifyLowStock, recordStockMovement } from "@/lib/stock/movements";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoPartRequirements } from "@/lib/demo/responses";
import { PART_REQUIREMENT_STATUSES, PART_URGENCIES } from "@/types";
import type { PartRequirementStatus } from "@/types";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

/**
 * Ce qu'une demande montre, sur le panneau d'un bon comme au registre du bureau.
 *
 * LE CONTEXTE EST TOUJOURS RENDU, MÊME QUAND LE PANNEAU N'EN A PAS BESOIN
 * Le panneau vit sur la fiche d'un bon : il sait déjà de quel appareil et de
 * quel immeuble il parle. Le registre, lui, mélange tout le parc, et une ligne
 * qui ne dirait ni le site ni le bon ne dirait rien.
 *
 * Deux projections auraient été plus fines, et c'est ce qui a été fait pour les
 * devis — mais là-bas la différence portait sur une collection imbriquée, les
 * lignes d'un devis, qu'un registre n'a effectivement pas à transporter. Ici ce
 * sont trois chaînes par ligne. Une seconde projection pour trois chaînes
 * coûterait plus cher en risque de divergence qu'en octets.
 */
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
  stockItemId: true,
  requestedBy: { select: { id: true, name: true } },
  statusChangedBy: { select: { id: true, name: true } },
  /**
   * L'état de la transmission au magasin central.
   *
   * Joint ici, et non réservé au poste du magasinier : le registre du bureau
   * montre les mêmes lignes, et une demande déjà commandée là-bas qui
   * s'afficherait ici comme « à commander » ferait commander deux fois.
   */
  stockReference: true,
  stockCodeRef: true,
  stockSentAt: true,
  stockSendError: true,
  stockSentBy: { select: { id: true, name: true } },
  workOrder: {
    select: {
      orderNumber: true,
      title: true,
      elevator: {
        select: {
          id: true,
          elevatorCode: true,
          building: { select: { id: true, name: true, city: true } },
        },
      },
    },
  },
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

interface StockHit {
  id: string;
  quantity: number;
  location: string | null;
  reference: string;
  name: string;
  reorderThreshold: number;
}

/**
 * La réserve locale, indexée par référence **et** par nom.
 *
 * Les pièces du terrain sont du texte libre : tantôt une référence, tantôt une
 * désignation. Indexer les deux permet de rapprocher une demande d'un article
 * sans exiger un identifiant de catalogue que personne ne saisit sur un toit.
 */
async function loadStockIndex(): Promise<Map<string, StockHit>> {
  const items = await prisma.stockItem.findMany({
    select: {
      id: true,
      reference: true,
      name: true,
      quantity: true,
      location: true,
      reorderThreshold: true,
    },
  });

  const index = new Map<string, StockHit>();
  for (const item of items) {
    const hit: StockHit = {
      id: item.id,
      quantity: item.quantity,
      location: item.location,
      reference: item.reference,
      name: item.name,
      reorderThreshold: item.reorderThreshold,
    };
    index.set(item.reference.trim().toLowerCase(), hit);
    index.set(item.name.trim().toLowerCase(), hit);
  }
  return index;
}

/** Les articles liés par identifiant, pour ne pas dépendre d'un texte renommé. */
async function loadStockByIds(ids: readonly string[]): Promise<Map<string, StockHit>> {
  if (ids.length === 0) return new Map();

  const items = await prisma.stockItem.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: {
      id: true,
      reference: true,
      name: true,
      quantity: true,
      location: true,
      reorderThreshold: true,
    },
  });

  return new Map(
    items.map((item) => [
      item.id,
      {
        id: item.id,
        quantity: item.quantity,
        location: item.location,
        reference: item.reference,
        name: item.name,
        reorderThreshold: item.reorderThreshold,
      },
    ])
  );
}

function stockFor(
  row: { replacementPartName: string; replacementPartReference: string | null },
  index: Map<string, StockHit>
): StockHit | null {
  const keys = [row.replacementPartReference, row.replacementPartName]
    .filter((key): key is string => Boolean(key && key.trim()))
    .map((key) => key.trim().toLowerCase());

  for (const key of keys) {
    const hit = index.get(key);
    if (hit) return hit;
  }
  return null;
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

    const stock = await loadStockIndex();
    const linked = await loadStockByIds(
      rows.flatMap((row) => (row.stockItemId ? [row.stockItemId] : []))
    );

    return NextResponse.json({
      data: rows.map((row) => {
        /**
         * L'identifiant d'abord : c'est le lien durable. Le rapprochement par
         * texte ne sert plus qu'aux demandes créées avant que la colonne
         * n'existe, ou aux pièces qui n'ont pas encore d'article en réserve.
         */
        const hit =
          (row.stockItemId ? linked.get(row.stockItemId) : null) ??
          stockFor(row, stock);
        return {
          ...row,
          /** Quantité réellement en réserve, ou null si la pièce est inconnue. */
          stockAvailable: hit?.quantity ?? null,
          stockLocation: hit?.location ?? null,
        };
      }),
      total: rows.length,
    });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/parts-replacement");
      const { searchParams } = request.nextUrl;
      const demo = demoPartRequirements({
        workOrderId: searchParams.get("workOrderId") || undefined,
        status: searchParams.get("status") || undefined,
      });
      /**
       * La réserve n'est pas modélisée par la fixture : `null` plutôt qu'un
       * chiffre inventé. L'écran affiche « stock non suivi » et n'offre pas de
       * réservation qui aurait décrémenté un stock qui n'existe pas.
       */
      return NextResponse.json({
        ...demo,
        data: demo.data.map((row) => ({
          ...row,
          stockAvailable: null,
          stockLocation: null,
        })),
      });
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

    /**
     * Le lien durable vers la réserve, quand la pièce y est déjà connue.
     *
     * Le rapprochement de départ reste le texte — c'est ce que le technicien
     * saisit — mais l'identifiant est conservé tout de suite. Si le magasin
     * renomme ensuite l'article, la demande continuera de désigner la bonne
     * ligne au lieu de chercher un nom qui n'existe plus.
     */
    const stock = await loadStockIndex();
    const linkedStock = stockFor(
      {
        replacementPartName: body.replacementPartName,
        replacementPartReference: body.replacementPartReference ?? null,
      },
      stock
    );

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
            stockItemId: linkedStock?.id ?? null,
            quantity: body.quantity,
            urgency: body.urgency,
            notes: body.notes,
            /**
             * La demande arrive directement dans la file du magasin.
             *
             * C'est le circuit demandé : le technicien constate la pièce
             * manquante, le magasinier vérifie la réserve. Passer par un état
             * « en attente du bureau » ajoutait une étape qui ne décidait rien
             * — le bureau ne connaît pas le stock.
             */
            status: "PENDING_STOCK_CHECK",
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

const DecideSchema = z.union([
  /**
   * Le geste du magasinier, en un clic.
   *
   * `reserve` décrémente la réserve ; `order` constate la rupture ; `reject`
   * exige un motif. Le motif est vérifié plus bas, et non par un `.min(1)` ici,
   * parce qu'il n'est obligatoire que pour une seule des trois actions.
   */
  z
    .object({
      id: z.string().trim().min(1, "La demande est obligatoire"),
      action: z.enum(["reserve", "order", "reject"]),
      reason: z.string().trim().max(2000).optional(),
    })
    .strict(),
  /** L'ancien contrat — une transition d'état nue. Conservé pour l'existant. */
  z
    .object({
      id: z.string().trim().min(1, "La demande est obligatoire"),
      status: z.enum(PART_REQUIREMENT_STATUSES),
    })
    .strict(),
]);

/**
 * La décision du bureau et du magasin.
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
      select: {
        id: true,
        number: true,
        status: true,
        workOrderId: true,
        requestedById: true,
        quantity: true,
        replacementPartName: true,
        replacementPartReference: true,
        stockItemId: true,
        workOrder: {
          select: { orderNumber: true, elevator: { select: { elevatorCode: true } } },
        },
      },
    });
    if (!existing) {
      throw notFound(`Demande de pièce introuvable : ${parsed.id}`);
    }

    // ─── Le circuit du magasin ──────────────────────────────
    if ("action" in parsed) {
      const target: PartRequirementStatus =
        parsed.action === "reserve"
          ? "RESERVED"
          : parsed.action === "order"
            ? "ORDER_REQUIRED"
            : "REJECTED";

      const now = new Date();

      // Rejouer la même décision ne doit ni re-décrémenter le stock ni
      // renvoyer une notification : c'est le propre d'un double clic.
      if (existing.status === target) {
        const unchanged = await prisma.partRequirement.findUnique({
          where: { id: parsed.id },
          select: LIST_SELECT,
        });
        return jsonOk(unchanged);
      }

      const refusal = transitionRefusal(existing.status, target);
      if (refusal) throw badRequest(refusal);

      if (parsed.action === "reject" && !parsed.reason?.trim()) {
        throw badRequest(
          "Un refus doit porter un motif : sans lui, le technicien ne sait pas quoi corriger."
        );
      }

      let updated;

      if (parsed.action === "reserve") {
        const index = await loadStockIndex();
        /**
         * L'identifiant lié d'abord : une référence renommée au magasin ne
         * doit pas rendre la demande introuvable. Le texte reste le repli des
         * demandes ouvertes avant que la colonne n'existe.
         */
        const linkedHit = existing.stockItemId
          ? await prisma.stockItem.findUnique({
              where: { id: existing.stockItemId },
              select: {
                id: true,
                reference: true,
                name: true,
                quantity: true,
                location: true,
                reorderThreshold: true,
              },
            })
          : null;
        const hit = linkedHit ?? stockFor(existing, index);

        if (!hit) {
          throw conflict(
            `Aucune réserve connue pour « ${
              existing.replacementPartReference ?? existing.replacementPartName
            } ». Passez la demande en commande.`
          );
        }
        if (hit.quantity < existing.quantity) {
          throw conflict(
            `Stock insuffisant : ${hit.quantity} en réserve pour ${existing.quantity} demandée(s).`
          );
        }

        /**
         * La réservation est une écriture en deux temps, et elle doit être
         * atomique : lire le stock puis le décrémenter sans verrou laisserait
         * deux magasiniers réserver la même dernière pièce. Le `updateMany`
         * filtré sur `quantity >= demandé` est le verrou — s'il ne touche
         * aucune ligne, quelqu'un est passé entre-temps et l'on refuse.
         */
        const result = await prisma.$transaction(async (tx) => {
          const item = await tx.stockItem.findFirst({
            where: { id: hit.id, quantity: { gte: existing.quantity } },
            select: {
              id: true,
              reference: true,
              name: true,
              quantity: true,
              reorderThreshold: true,
            },
          });

          if (!item) {
            throw conflict(
              "Le stock a changé pendant la réservation. Rechargez l'écran et réessayez."
            );
          }

          const claimed = await tx.stockItem.updateMany({
            where: { id: item.id, quantity: { gte: existing.quantity } },
            data: { quantity: { decrement: existing.quantity } },
          });
          if (claimed.count === 0) {
            throw conflict(
              "Le stock a changé pendant la réservation. Rechargez l'écran et réessayez."
            );
          }

          await recordStockMovement(tx, {
            stockItemId: item.id,
            type: "RESERVATION",
            quantity: -existing.quantity,
            reason: `Réservation de la demande ${existing.number}`,
            userId: session.user.id ?? null,
          });

          const remaining = item.quantity - existing.quantity;

          const requirement = await tx.partRequirement.update({
            where: { id: parsed.id },
            data: {
              status: "RESERVED",
              statusChangedAt: now,
              statusChangedById: session.user.id ?? null,
              reservedAt: now,
              decisionNote: null,
              stockItemId: item.id,
            },
            select: LIST_SELECT,
          });

          return {
            requirement,
            lowStock:
              remaining <= item.reorderThreshold
                ? {
                    reference: item.reference,
                    name: item.name,
                    quantity: remaining,
                    reorderThreshold: item.reorderThreshold,
                  }
                : null,
          };
        });

        updated = result.requirement;
        if (result.lowStock) {
          await notifyLowStock(result.lowStock);
        }
      } else {
        updated = await prisma.partRequirement.update({
          where: { id: parsed.id },
          data: {
            status: target,
            statusChangedAt: now,
            statusChangedById: session.user.id ?? null,
            reservedAt: null,
            decisionNote: parsed.reason?.trim() || null,
          },
          select: LIST_SELECT,
        });
      }

      /**
       * Le technicien est prévenu du sort de sa demande.
       *
       * `notify` ne lève jamais : une notification qui échouerait ne doit pas
       * annuler une réservation déjà écrite en base.
       */
      if (existing.requestedById) {
        const partLabel =
          existing.replacementPartReference ?? existing.replacementPartName;
        const orderLabel = existing.workOrder.elevator.elevatorCode;

        const message =
          parsed.action === "reserve"
            ? `${partLabel} ×${existing.quantity} est en réserve au magasin pour l'appareil ${orderLabel}.`
            : parsed.action === "order"
              ? `${partLabel} ×${existing.quantity} n'est pas en stock : approvisionnement en cours pour l'appareil ${orderLabel}.`
              : `${partLabel} ×${existing.quantity} refusée : ${parsed.reason?.trim()}`;

        await notify({
          userId: existing.requestedById,
          title:
            parsed.action === "reserve"
              ? "📦 Pièce prête au magasin"
              : parsed.action === "order"
                ? "⏳ Pièce en cours d'approvisionnement"
                : "❌ Demande de pièce refusée",
          message,
          type: "part_requirement",
          linkUrl: `/bons-de-travail/${existing.workOrderId}`,
          workOrderId: existing.workOrderId,
        });
      }

      return jsonOk(updated);
    }

    // ─── L'ancien contrat : une transition nue ──────────────
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

    /**
     * Une pièce posée sort de la réserve physique.
     *
     * Une demande passée par « Approuver & réserver » a déjà décrémenté le
     * stock au moment de la réservation : la décrémenter une seconde fois à la
     * pose compterait la même pièce deux fois. Les demandes validées ou
     * commandées sans réservation, elles, n'ont encore touché à aucune
     * quantité — c'est ici qu'elles la consomment.
     *
     * Le `updateMany` filtré sur `quantity >= demandé` est le même verrou que
     * la réservation : deux poses simultanées de la dernière pièce ne peuvent
     * pas la faire passer sous zéro. Si l'article n'est pas dans la réserve
     * (pièce commandée hors stock), la pose reste valide et la quantité est
     * simplement inchangée.
     */
    const consumesStock =
      parsed.status === "FULFILLED" && existing.status !== "RESERVED";

    const applyTransition = async (
      tx: Prisma.TransactionClient,
      stockItemId?: string
    ) =>
      tx.partRequirement.update({
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
          ...(stockItemId ? { stockItemId } : {}),
        },
        select: LIST_SELECT,
      });

    const transition = consumesStock
      ? await prisma.$transaction(async (tx) => {
          const item = existing.stockItemId
            ? await tx.stockItem.findFirst({
                where: {
                  id: existing.stockItemId,
                  quantity: { gte: existing.quantity },
                },
                select: {
                  id: true,
                  reference: true,
                  name: true,
                  quantity: true,
                  reorderThreshold: true,
                },
              })
            : await tx.stockItem.findFirst({
                where: {
                  OR: [
                    {
                      reference: {
                        equals:
                          existing.replacementPartReference?.trim() ||
                          existing.replacementPartName.trim(),
                        mode: "insensitive",
                      },
                    },
                    {
                      name: {
                        equals: existing.replacementPartName.trim(),
                        mode: "insensitive",
                      },
                    },
                  ],
                  quantity: { gte: existing.quantity },
                },
                select: {
                  id: true,
                  reference: true,
                  name: true,
                  quantity: true,
                  reorderThreshold: true,
                },
              });

          if (item) {
            const claimed = await tx.stockItem.updateMany({
              where: { id: item.id, quantity: { gte: existing.quantity } },
              data: { quantity: { decrement: existing.quantity } },
            });

            if (claimed.count === 0) {
              throw conflict(
                "Le stock a changé pendant la pose. Rechargez l'écran et réessayez."
              );
            }

            await recordStockMovement(tx, {
              stockItemId: item.id,
              type: "EXIT",
              quantity: -existing.quantity,
              reason: `Pose de la demande ${existing.number}`,
              userId: session.user.id ?? null,
            });

            const remaining = item.quantity - existing.quantity;
            const requirement = await applyTransition(tx, item.id);

            return {
              requirement,
              lowStock:
                remaining <= item.reorderThreshold
                  ? {
                      reference: item.reference,
                      name: item.name,
                      quantity: remaining,
                      reorderThreshold: item.reorderThreshold,
                    }
                  : null,
            };
          }

          console.warn(
            `[parts] pose de ${existing.number} : aucune réserve suffisante pour ` +
              `${existing.replacementPartReference ?? existing.replacementPartName}, ` +
              "quantité laissée inchangée"
          );

          return {
            requirement: await applyTransition(tx),
            lowStock: null,
          };
        })
      : {
          requirement: await prisma.$transaction((tx) => applyTransition(tx)),
          lowStock: null,
        };

    if (transition.lowStock) {
      await notifyLowStock(transition.lowStock);
    }

    return jsonOk(transition.requirement);
  } catch (error) {
    return handleRouteError(error);
  }
}
