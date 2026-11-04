/**
 * Maintenance RMASC – Une notification, par identifiant.
 *
 * PATCH /api/notifications/:id – marquer cette notification comme lue
 *
 * Le `userId` est dans le WHERE, pas dans une vérification après coup : marquer
 * la notification de quelqu'un d'autre est alors impossible à exprimer. La
 * route de collection (`PATCH /api/notifications`) reste le chemin « tout
 * marquer lu » ; celle-ci est le geste unitaire, utilisé par la cloche quand on
 * ouvre une ligne.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError, notFound, readJson } from "@/lib/api/http";
import { requireSession } from "@/lib/api/guard";

export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function PATCH(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireSession();

    // Le corps est optionnel : le seul geste supporté est « lire ».
    await readJson(_request).catch(() => null);

    const result = await prisma.notification.updateMany({
      where: { id: params.id, userId: session.user.id },
      data: { isRead: true },
    });

    if (result.count === 0) {
      throw notFound("Notification introuvable.");
    }

    return NextResponse.json({ data: { id: params.id, isRead: true } });
  } catch (error) {
    return handleRouteError(error);
  }
}
