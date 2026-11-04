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
import { prisma } from "@/lib/db/prisma";
import { handleRouteError, parsePagination } from "@/lib/api/http";
import { MANAGEMENT_ROLES, requireRole } from "@/lib/api/guard";
import { shouldServeDemoData } from "@/lib/demo/mode";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireRole(...MANAGEMENT_ROLES);

    const { page, limit, skip } = parsePagination(request.nextUrl.searchParams, {
      defaultLimit: 100,
      maxLimit: 200,
    });
    const stockItemId =
      request.nextUrl.searchParams.get("stockItemId") || undefined;

    const where = stockItemId ? { stockItemId } : {};

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
