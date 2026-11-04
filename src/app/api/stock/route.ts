/**
 * Maintenance RMASC – la réserve locale du magasin.
 *
 * GET  /api/stock – les articles en réserve, avec leur quantité et leur seuil.
 * POST /api/stock – créer une référence dans la réserve physique.
 *
 * POURQUOI CETTE ROUTE
 * `StockItem` est la réserve physique du magasinier, distincte du magasin
 * central. L'onglet « Réception & réserve physique » de la console a besoin de
 * la lire ; sans route, la table n'aurait été visible que par Prisma Studio.
 * La création est le geste qui manquait : une pièce reçue sans référence au
 * catalogue restait impossible à enregistrer autrement qu'en base.
 */

import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  conflict,
  handleRouteError,
  notFound,
  readJson,
} from "@/lib/api/http";
import { MANAGEMENT_ROLES, requireRole } from "@/lib/api/guard";
import { shouldServeDemoData } from "@/lib/demo/mode";
import { STOCK_DEMO_ARTICLES } from "@/lib/stock/demo";

export const dynamic = "force-dynamic";

const CreateStockSchema = z
  .object({
    reference: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(200),
    category: z.string().trim().max(100).optional(),
    quantity: z.number().int().min(0).max(100_000),
    reorderThreshold: z.number().int().min(0).max(100_000),
    unitPrice: z.number().min(0).max(99_999_999.99).optional(),
    location: z.string().trim().max(200).optional(),
  })
  .strict();

/**
 * Réapprovisionner ou ajuster un article existant.
 *
 * `quantity` pose une quantité absolue ; `delta` ajoute ou retire un nombre
 * d'unités. Les deux ne se combinent pas : un appel qui porterait les deux
 * dirait deux choses différentes sur la même colonne.
 *
 * `reference` est acceptée comme identifiant de repli : la console magasin
 * connaît la référence d'un article avant de connaître son `id`, et exiger
 * l'identifiant technique aurait obligé l'appelant à relire la liste.
 */
const UpdateStockSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    reference: z.string().trim().min(1).max(80).optional(),
    quantity: z.number().int().min(0).max(100_000).optional(),
    delta: z.number().int().min(-100_000).max(100_000).optional(),
    reorderThreshold: z.number().int().min(0).max(100_000).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.id) !== Boolean(value.reference), {
    message: "Fournissez soit id, soit reference — pas les deux.",
  })
  .refine(
    (value) => value.quantity === undefined || value.delta === undefined,
    {
      message:
        "Fournissez quantity (quantité absolue) ou delta (ajout/retrait), pas les deux.",
    }
  )
  .refine(
    (value) =>
      value.quantity !== undefined ||
      value.delta !== undefined ||
      value.reorderThreshold !== undefined,
    { message: "Aucune modification demandée." }
  );

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

export async function GET() {
  try {
    await requireRole(...MANAGEMENT_ROLES);

    const items = await prisma.stockItem.findMany({
      orderBy: [{ name: "asc" }],
      select: {
        id: true,
        reference: true,
        name: true,
        category: true,
        quantity: true,
        reorderThreshold: true,
        unitPrice: true,
        location: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({ data: items, total: items.length });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      /**
       * Le catalogue fictif du magasin central, ramené à la forme de la
       * réserve locale. C'est la seule source de quantités qui existe sans
       * base — et elle est explicitement de démonstration.
       */
      const data = STOCK_DEMO_ARTICLES.map((article) => ({
        id: article.codeRef,
        reference: article.codeRef,
        name: article.designation,
        category: null,
        quantity: article.quantiteStock,
        reorderThreshold: article.seuilAlerte,
        unitPrice: null,
        location: article.emplacement,
        updatedAt: new Date().toISOString(),
      }));
      return NextResponse.json({ data, total: data.length });
    }
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  let submitted: z.infer<typeof CreateStockSchema> | null = null;

  try {
    await requireRole(...MANAGEMENT_ROLES);
    const parsed = CreateStockSchema.parse(await readJson(request));
    submitted = parsed;

    const existing = await prisma.stockItem.findUnique({
      where: { reference: parsed.reference },
      select: { id: true },
    });
    if (existing) {
      throw conflict(
        `Un article utilise déjà la référence ${parsed.reference}. ` +
          "Utilisez PATCH /api/stock pour réapprovisionner cet article."
      );
    }

    const item = await prisma.stockItem.create({
      data: {
        reference: parsed.reference,
        name: parsed.name,
        category: parsed.category?.trim() || null,
        quantity: parsed.quantity,
        reorderThreshold: parsed.reorderThreshold,
        unitPrice: parsed.unitPrice ?? null,
        location: parsed.location?.trim() || null,
      },
      select: {
        id: true,
        reference: true,
        name: true,
        category: true,
        quantity: true,
        reorderThreshold: true,
        unitPrice: true,
        location: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({ data: item }, { status: 201 });
  } catch (error) {
    if (submitted && shouldServeDemoData(error)) {
      const now = new Date().toISOString();
      return NextResponse.json(
        {
          data: {
            id: `demo-stock-${Date.now()}`,
            ...submitted,
            category: submitted.category ?? null,
            unitPrice: submitted.unitPrice ?? null,
            location: submitted.location ?? null,
            updatedAt: now,
          },
          demo: true,
        },
        { status: 201 }
      );
    }
    return handleRouteError(error);
  }
}

/**
 * Réapprovisionner ou ajuster un article existant.
 *
 * PATCH /api/stock
 *
 * `quantity` est une quantité absolue ; `delta` est un mouvement relatif
 * (positif pour une entrée, négatif pour une sortie). Le retrait relatif passe
 * par un `updateMany` filtré sur `quantity >= |delta|` : deux retraits
 * simultanés ne peuvent pas faire passer la réserve sous zéro.
 *
 * La création reste `POST /api/stock`. Un `POST` sur une référence existante
 * renvoie 409, et ce 409 est désormais le signal d'utiliser `PATCH`.
 */
export async function PATCH(request: NextRequest) {
  let submitted: z.infer<typeof UpdateStockSchema> | null = null;

  try {
    await requireRole(...MANAGEMENT_ROLES);
    const parsed = UpdateStockSchema.parse(await readJson(request));
    submitted = parsed;

    const where: Prisma.StockItemWhereUniqueInput = parsed.id
      ? { id: parsed.id }
      : { reference: parsed.reference as string };

    const existing = await prisma.stockItem.findUnique({
      where,
      select: { id: true, quantity: true },
    });
    if (!existing) {
      throw notFound("Article introuvable dans la réserve.");
    }

    const data: Prisma.StockItemUpdateInput = {};

    if (parsed.reorderThreshold !== undefined) {
      data.reorderThreshold = parsed.reorderThreshold;
    }

    if (parsed.quantity !== undefined) {
      data.quantity = parsed.quantity;
    } else if (parsed.delta !== undefined && parsed.delta >= 0) {
      data.quantity = { increment: parsed.delta };
    } else if (parsed.delta !== undefined) {
      const removed = -parsed.delta;
      const claimed = await prisma.stockItem.updateMany({
        where: { id: existing.id, quantity: { gte: removed } },
        data: { quantity: { increment: parsed.delta } },
      });

      if (claimed.count === 0) {
        throw conflict(
          `Stock insuffisant : ${existing.quantity} en réserve, ` +
            `${removed} demandé(s) en moins.`
        );
      }
    }

    const item =
      Object.keys(data).length > 0
        ? await prisma.stockItem.update({
            where: { id: existing.id },
            data,
            select: STOCK_SELECT,
          })
        : await prisma.stockItem.findUniqueOrThrow({
            where: { id: existing.id },
            select: STOCK_SELECT,
          });

    return NextResponse.json({ data: item });
  } catch (error) {
    if (submitted && shouldServeDemoData(error)) {
      return NextResponse.json({
        data: {
          id: submitted.id ?? submitted.reference,
          ...submitted,
          demo: true,
        },
      });
    }
    return handleRouteError(error);
  }
}
