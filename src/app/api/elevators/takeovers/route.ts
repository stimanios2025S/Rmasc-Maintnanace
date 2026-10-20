/**
 * Le registre des reprises d'appareils tiers.
 *
 * GET /api/elevators/takeovers
 *
 * POURQUOI CETTE ROUTE EXISTE
 * `/api/elevators` rend le parc, mais un appareil repris n'est pas encore du
 * parc : il attend un audit, puis un matricule. L'écran de reprise a besoin de
 * cette question-là — « où en est chaque reprise ? » —, et la poser depuis la
 * liste générale obligerait à ouvrir chaque appareil pour lire l'état de son
 * bon. La requête ci-dessous joint l'appareil, son immeuble et ses bons
 * d'inspection en une lecture.
 *
 * La route est déclarée avant `[id]` par le routeur de Next : `/takeovers`
 * n'est donc jamais lu comme un identifiant d'appareil.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError } from "@/lib/api/http";
import { MANAGEMENT_ROLES, requireRole } from "@/lib/api/guard";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireRole(...MANAGEMENT_ROLES);

    const rows = await prisma.elevator.findMany({
      where: { originBrand: { not: null } },
      select: {
        id: true,
        elevatorCode: true,
        brand: true,
        originBrand: true,
        model: true,
        serialNumber: true,
        rmascCode: true,
        status: true,
        createdAt: true,
        building: { select: { id: true, name: true, city: true } },
        workOrders: {
          where: { type: "INSPECTION" },
          orderBy: { createdAt: "desc" as const },
          select: {
            id: true,
            orderNumber: true,
            status: true,
            createdAt: true,
            completedAt: true,
          },
        },
      },
      orderBy: [{ rmascCode: "asc" }, { createdAt: "desc" }],
    });

    return NextResponse.json({ data: rows, total: rows.length });
  } catch (error) {
    return handleRouteError(error);
  }
}
