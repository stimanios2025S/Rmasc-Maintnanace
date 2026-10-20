/**
 * Le QR d'un appareil, en PNG.
 *
 * GET /api/elevators/[id]/qr
 *
 * POURQUOI UNE ROUTE D'IMAGE PLUTÔT QU'UN DATA-URL DANS LA PAGE
 * La fiche d'entretien est un document qui s'imprime depuis le navigateur. Une
 * image servie par une adresse se charge et s'imprime de la même façon sur
 * n'importe quel poste ; un data-URL calculé à l'affichage dépend du JavaScript
 * de la page, et un QR absent à l'impression est exactement le défaut qu'on ne
 * voit qu'une fois le papier sorti.
 *
 * Elle est authentifiée et cloisonnée comme la fiche de l'appareil : le QR
 * n'apprend rien de plus que l'adresse qu'il encode, mais cette adresse est
 * l'identifiant d'un appareil, et un identifiant ne se distribue pas.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError, notFound } from "@/lib/api/http";
import { elevatorScopeFor, OPS_ROLES, requireRole } from "@/lib/api/guard";
import { qrPng, scanUrlFor } from "@/lib/documents/qr";

/** Le PNG passe par `node:zlib`. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");

    const elevator = await prisma.elevator.findFirst({
      where: { id: params.id, ...elevatorScopeFor(session) },
      select: { id: true },
    });
    if (!elevator) throw notFound(`Ascenseur introuvable : ${params.id}`);

    const png = qrPng(scanUrlFor(elevator.id), 6);

    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(png.length),
        // L'adresse de l'appareil ne change pas ; le QR non plus.
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
