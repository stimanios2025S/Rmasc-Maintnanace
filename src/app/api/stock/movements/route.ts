/**
 * Maintenance RMASC – journal des mouvements de la réserve.
 *
 * GET /api/stock/movements – les derniers mouvements, du plus récent.
 *
 * LECTURE SEULE
 * Ce journal est écrit par les routes qui modifient le stock, jamais par
 * l'écran. Une correction manuelle d'une ligne d'historique effacerait la
 * seule preuve de ce qui s'est passé ; l'écran se contente donc de le lire.
 */

import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import {
  handleRouteError,
  parseEnumParam,
  parsePagination,
} from "@/lib/api/http";
import { MANAGEMENT_ROLES, requireRole } from "@/lib/api/guard";
import { shouldServeDemoData } from "@/lib/demo/mode";

export const dynamic = "force-dynamic";

const MOVEMENT_TYPES = [
  "ENTRY",
  "EXIT",
  "RESERVATION",
  "ADJUSTMENT",
] as const;

export async function GET(request: NextRequest) {
  try {
    await requireRole(...MANAGEMENT_ROLES);

    const { page, limit, skip } = parsePagination(request.nextUrl.searchParams, {
      defaultLimit: 100,
      maxLimit: 200,
    });
    const stockItemId =
      request.nextUrl.searchParams.get("stockItemId") || undefined;
    const type = parseEnumParam(
      request.nextUrl.searchParams,
      "type",
      MOVEMENT_TYPES
    );
    const query = request.nextUrl.searchParams.get("q")?.trim() || undefined;

    /**
     * Les filtres se composent par intersection : un type et une recherche
     * textuelle doivent pouvoir être appliqués ensemble. La recherche porte
     * sur la référence et la désignation de l'article, pas sur le motif libre
     * — un motif est une phrase, et une recherche plein texte dessus rendrait
     * des résultats que l'utilisateur ne peut pas expliquer.
     */
    const where: Prisma.StockMovementWhereInput = {
      ...(stockItemId ? { stockItemId } : {}),
      ...(type ? { type } : {}),
      ...(query
        ? {
            stockItem: {
              OR: [
                { reference: { contains: query, mode: "insensitive" } },
                { name: { contains: query, mode: "insensitive" } },
              ],
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.stockMovement.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          type: true,
          quantity: true,
          reason: true,
          createdAt: true,
          stockItem: {
            select: { id: true, reference: true, name: true },
          },
          user: { select: { id: true, name: true } },
        },
      }),
      prisma.stockMovement.count({ where }),
    ]);

    return NextResponse.json({ data: rows, total, page, limit });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      return NextResponse.json({
        data: [],
        total: 0,
        page: 1,
        limit: 0,
        demo: true,
      });
    }
    return handleRouteError(error);
  }
}
