/**
 * Maintenance RMASC – réception d'un bon de livraison fournisseur.
 *
 * POST /api/stock/receptions
 *
 * POURQUOI UNE ROUTE DE LOT
 * Une livraison n'arrive presque jamais avec une seule référence : c'est un
 * bon de livraison, plusieurs lignes, un fournisseur. Créditer chaque article
 * par un `PATCH /api/stock` séparé aurait laissé le stock à moitié mis à jour
 * si le réseau tombait au milieu, et le numéro de BL n'aurait été écrit que
 * dans un des mouvements.
 *
 * Ici, les lignes sont fusionnées par article, écrites dans une seule
 * transaction, et chaque mouvement porte le même motif `Réception BL <numéro>`.
 * Le journal permet donc de retrouver toutes les lignes d'une livraison.
 */

import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  handleRouteError,
  jsonOk,
  notFound,
  readJson,
} from "@/lib/api/http";
import { MANAGEMENT_ROLES, requireRole } from "@/lib/api/guard";
import { shouldServeDemoData } from "@/lib/demo/mode";

export const dynamic = "force-dynamic";

const ReceptionSchema = z
  .object({
    blNumber: z.string().trim().min(1).max(100),
    lines: z
      .array(
        z
          .object({
            stockItemId: z.string().trim().min(1),
            quantity: z.number().int().positive().max(100_000),
          })
          .strict()
      )
      .min(1)
      .max(100),
  })
  .strict();

const STOCK_SELECT = {
  id: true,
  reference: true,
  name: true,
  category: true,
  quantity: true,
  reorderThreshold: true,
  unitPrice: true,
  location: true,
  updatedAt: true,
} satisfies Prisma.StockItemSelect;

export async function POST(request: NextRequest) {
  let submitted: z.infer<typeof ReceptionSchema> | null = null;

  try {
    const session = await requireRole(...MANAGEMENT_ROLES);
    const parsed = ReceptionSchema.parse(await readJson(request));
    submitted = parsed;

    /**
     * Deux lignes du même article sur un BL sont une seule écriture de stock.
     * Les additionner ici évite deux updates concurrents sur la même ligne et
     * deux mouvements dont la somme serait plus difficile à relire.
     */
    const quantities = new Map<string, number>();
    for (const line of parsed.lines) {
      quantities.set(
        line.stockItemId,
        (quantities.get(line.stockItemId) ?? 0) + line.quantity
      );
    }

    const ids = [...quantities.keys()];
    const existing = await prisma.stockItem.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });

    if (existing.length !== ids.length) {
      const known = new Set(existing.map((item) => item.id));
      const missing = ids.filter((id) => !known.has(id));
      throw notFound(
        `Article(s) introuvable(s) dans la réserve : ${missing.join(", ")}`
      );
    }

    const items = await prisma.$transaction(async (tx) => {
      const updated = [];

      for (const [stockItemId, quantity] of quantities) {
        const item = await tx.stockItem.update({
          where: { id: stockItemId },
          data: { quantity: { increment: quantity } },
          select: STOCK_SELECT,
        });

        await tx.stockMovement.create({
          data: {
            stockItemId,
            type: "ENTRY",
            quantity,
            reason: `Réception BL ${parsed.blNumber}`,
            userId: session.user.id ?? null,
          },
        });

        updated.push(item);
      }

      return updated;
    });

    return jsonOk({ blNumber: parsed.blNumber, items }, 201);
  } catch (error) {
    if (submitted && shouldServeDemoData(error)) {
      return NextResponse.json(
        {
          data: {
            blNumber: submitted.blNumber,
            items: [],
            demo: true,
          },
        },
        { status: 201 }
      );
    }
    return handleRouteError(error);
  }
}
