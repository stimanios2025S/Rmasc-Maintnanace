/**
 * La couverture contractuelle — ce qu'un badge et le portail client lisent.
 *
 * GET /api/contracts/coverage
 *
 * POURQUOI CETTE ROUTE EXISTE
 * `/api/contracts` est le registre du bureau : il exige un rôle de gestion et
 * rend les montants, la devise et l'e-mail du client. Un badge sur une fiche
 * d'ascenseur n'a besoin que du palier et des dates ; le portail client, des
 * mêmes champs pour ses propres contrats. Ouvrir le registre à tous les rôles
 * pour cela exposerait la facturation de l'entreprise à un technicien, et la
 * liste entière à un client mal filtré.
 *
 * LE CLOISONNEMENT EST DANS LA REQUÊTE
 * Un `BUILDING_OWNER` reçoit un `clientId` imposé par le serveur, jamais par un
 * paramètre : la route n'en accepte aucun. Les autres rôles voient la
 * couverture du parc — elle ne contient ni montant ni coordonnées de client,
 * seulement des paliers, des dates et des noms d'immeubles.
 *
 * CE QUI N'EST PAS RENDU
 * `amount`, `currency`, `client`, `terminationReason`, l'historique : rien de
 * commercial ni de personnel. Le portail client a besoin de savoir à quoi il a
 * droit, pas de relire son dossier commercial.
 */

import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { handleRouteError } from "@/lib/api/http";
import { requireSession } from "@/lib/api/guard";
import {
  effectiveEndsAt,
  effectiveStatus,
  expiryAlert,
} from "@/lib/contracts/status";
import type { ContractRenewalMode, ContractStatus } from "@/types";

export const dynamic = "force-dynamic";

const COVERAGE_SELECT = {
  id: true,
  reference: true,
  slaTier: true,
  status: true,
  renewalMode: true,
  noticeDays: true,
  startsAt: true,
  endsAt: true,
  responseHours: true,
  interventionHours: true,
  buildings: {
    select: {
      building: {
        select: { id: true, name: true, city: true, ownerId: true },
      },
    },
  },
} satisfies Prisma.ContractSelect;

type CoverageRow = Prisma.ContractGetPayload<{
  select: typeof COVERAGE_SELECT;
}>;

export async function GET() {
  try {
    const session = await requireSession();

    const where: Prisma.ContractWhereInput = {
      // Un brouillon ne couvre rien ; un contrat résilié ou échu non plus.
      status: { in: ["ACTIVE", "SUSPENDED"] },
      // Le seul cloisonnement qui compte : un client ne lit que ses contrats.
      // Les rôles du personnel voient la couverture du parc, sans les montants.
      ...(session.user.role === "BUILDING_OWNER"
        ? { clientId: session.user.id }
        : {}),
    };

    const rows = await prisma.contract.findMany({
      where,
      select: COVERAGE_SELECT,
      orderBy: { startsAt: "desc" },
    });

    const now = new Date();
    const ownerScope =
      session.user.role === "BUILDING_OWNER" ? session.user.id : null;

    const data = rows
      .map((row) => decorate(row, now, ownerScope))
      /**
       * Un contrat `MANUAL` ou `NONE` dont la date est passée est `EXPIRED` à
       * la lecture : il ne couvre plus rien, même si la ligne porte encore
       * `ACTIVE`. Le filtre s'applique après le calcul, pas dans la requête.
       */
      .filter(
        (row) =>
          row.effectiveStatus === "ACTIVE" ||
          row.effectiveStatus === "SUSPENDED"
      )
      .sort((a, b) => {
        const rank = (status: ContractStatus) => (status === "ACTIVE" ? 0 : 1);
        return rank(a.effectiveStatus) - rank(b.effectiveStatus);
      });

    return NextResponse.json({ data, total: data.length });
  } catch (error) {
    return handleRouteError(error);
  }
}

function decorate(row: CoverageRow, now: Date, ownerScope: string | null) {
  const dated = {
    status: row.status as ContractStatus,
    renewalMode: row.renewalMode as ContractRenewalMode,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
  };

  /**
   * Un client ne voit que ses immeubles.
   *
   * Le contrat est déjà filtré sur `clientId`, et un immeuble ne peut entrer
   * dans un contrat que s'il appartient au titulaire — mais la propriété d'un
   * site peut changer après coup. Filtrer ici évite qu'un site transféré
   * réapparaisse dans le portail de son ancien propriétaire.
   */
  const buildings = row.buildings
    .map((link) => link.building)
    .filter((building) => ownerScope === null || building.ownerId === ownerScope)
    .map((building) => ({
      id: building.id,
      name: building.name,
      city: building.city,
    }));

  return {
    id: row.id,
    reference: row.reference,
    slaTier: row.slaTier,
    status: row.status,
    effectiveStatus: effectiveStatus(dated, now),
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    effectiveEndsAt: effectiveEndsAt(dated, now),
    renewalMode: row.renewalMode,
    noticeDays: row.noticeDays,
    responseHours: row.responseHours,
    interventionHours: row.interventionHours,
    buildings,
    expiry: expiryAlert(dated, now),
  };
}
