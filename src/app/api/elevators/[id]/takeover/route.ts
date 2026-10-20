/**
 * La validation d'une reprise d'appareil tiers.
 *
 * POST /api/elevators/[id]/takeover
 *
 * CE QUE VALIDE CE GESTE
 * La visite d'état des lieux, pas la fiche. Tant qu'un bon d'inspection est
 * ouvert sur l'appareil, personne n'a regardé la machine : attribuer un
 * matricule à ce moment-là ferait entrer dans le parc un appareil dont on ne
 * connaît que ce qu'un formulaire a déclaré. La règle est donc vérifiée ici et
 * pas seulement à l'écran.
 *
 * CE QU'ELLE PRODUIT
 * Le matricule RMASC `ASC-AAAA-NNNN` — la suite des appareils de l'année — et
 * l'adresse du QR qui le porte. Le QR encode la page publique de l'appareil :
 * c'est la même page que celle du premier scan, avec en plus la demande d'accès
 * client. Un appareil repris n'a donc rien de spécial à installer.
 *
 * Le matricule est unique en base. Deux validations simultanées liraient le
 * même dernier numéro ; la contrainte tranche, et la seconde réessaie avec le
 * suivant. C'est le même choix que pour les numéros de bon.
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import {
  conflict,
  handleRouteError,
  jsonOk,
  notFound,
} from "@/lib/api/http";
import { MANAGEMENT_ROLES, requireRole } from "@/lib/api/guard";
import { OPEN_WORK_ORDER_STATUSES } from "@/lib/work-orders/service";
import { scanUrlFor } from "@/lib/documents/qr";

const ATTEMPTS = 5;

/** `ASC-2026-0001`, dans la suite des appareils de l'année. */
async function nextRmascCode(year: number): Promise<string> {
  const prefix = `ASC-${year}-`;
  /**
   * Le plus grand numéro se lit numériquement, pas alphabétiquement : au-delà
   * de 9999, `ASC-2026-10000` passerait avant `ASC-2026-9999` dans un tri de
   * chaînes, et le générateur proposerait sans fin un matricule déjà pris.
   */
  const rows = await prisma.elevator.findMany({
    where: { rmascCode: { startsWith: prefix } },
    select: { rmascCode: true },
  });

  const sequence =
    rows.reduce((max, row) => {
      const value = Number.parseInt(row.rmascCode?.slice(prefix.length) ?? "", 10);
      return Number.isFinite(value) && value > max ? value : max;
    }, 0) + 1;

  return `${prefix}${String(sequence).padStart(4, "0")}`;
}

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireRole(...MANAGEMENT_ROLES);

    const elevator = await prisma.elevator.findFirst({
      where: { id: params.id, isActive: true },
      select: {
        id: true,
        elevatorCode: true,
        originBrand: true,
        rmascCode: true,
      },
    });
    if (!elevator) throw notFound(`Ascenseur introuvable : ${params.id}`);

    if (!elevator.originBrand) {
      throw conflict(
        `L'appareil ${elevator.elevatorCode} n'est pas une reprise d'appareil tiers : ` +
          "aucune marque d'origine n'est enregistrée."
      );
    }
    if (elevator.rmascCode) {
      throw conflict(
        `Le matricule ${elevator.rmascCode} a déjà été attribué à cet appareil.`
      );
    }

    /**
     * L'audit doit être terminé. Un bon seulement annulé ne compte pas comme un
     * audit : il n'a rien constaté. C'est la raison du filtre sur les états
     * ouverts plutôt que sur « au moins un bon existe ».
     */
    const openAudit = await prisma.workOrder.findFirst({
      where: {
        elevatorId: elevator.id,
        type: "INSPECTION",
        status: { in: [...OPEN_WORK_ORDER_STATUSES] },
      },
      select: { orderNumber: true },
    });
    if (openAudit) {
      throw conflict(
        `Le bon d'inspection ${openAudit.orderNumber} n'est pas terminé. ` +
          "Le matricule ne peut être attribué qu'une fois l'état des lieux constaté."
      );
    }

    const year = new Date().getFullYear();
    let updated: { id: string; rmascCode: string | null } | null = null;

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const code = await nextRmascCode(year);
      try {
        updated = await prisma.elevator.update({
          where: { id: elevator.id },
          data: { rmascCode: code },
          select: { id: true, rmascCode: true },
        });
        break;
      } catch (error) {
        // P2002 : le matricule a été pris entre la lecture et l'écriture.
        if ((error as { code?: string })?.code !== "P2002") throw error;
      }
    }

    if (!updated?.rmascCode) {
      throw conflict(
        "Le matricule n'a pas pu être attribué après plusieurs tentatives. " +
          "Réessayez dans un instant."
      );
    }

    return jsonOk({
      id: updated.id,
      rmascCode: updated.rmascCode,
      scanUrl: scanUrlFor(updated.id),
      qrUrl: `/api/elevators/${updated.id}/qr`,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
