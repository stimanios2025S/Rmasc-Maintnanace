/**
 * Maintenance RMASC – factures.
 *
 * GET  /api/invoices              – la liste, filtrée selon qui demande
 * POST /api/invoices              – émettre la facture d'un bon (idempotent)
 *
 * LA SÉPARATION DES LECTURES
 * Un administrateur ou un responsable voit toutes les factures ; un compte
 * client ne voit que les siennes. La seconde règle n'est pas un confort : une
 * facture porte le nom, l'adresse, l'e-mail et le téléphone d'un client, et le
 * montant de ce qu'il doit. Une liste non filtrée aurait envoyé à chaque client
 * le dossier de tous les autres — le même défaut que `buildingScopeFor` a été
 * écrit pour fermer sur les immeubles.
 *
 * AUCUN REPLI DE DÉMONSTRATION
 * Contrairement aux immeubles et aux ascenseurs, ces routes n'en ont pas. Une
 * facture est un document numéroté et figé : la fabriquer dans une fixture
 * reviendrait à inventer un numéro de pièce comptable, et le PDF devrait ensuite
 * être rendu pour un document qui n'existe pas en base. Les écrans qui les
 * affichent ont besoin d'une vraie base — c'est le comportement qui existe déjà
 * pour l'administration des clients.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  badRequest,
  handleRouteError,
  jsonOk,
  notFound,
  parsePagination,
  readJson,
} from "@/lib/api/http";
import { MANAGEMENT_ROLES, OPS_ROLES, requireRole } from "@/lib/api/guard";
import { issueInvoiceForWorkOrder } from "@/lib/invoices/service";

/**
 * Ce qu'une facture montre dans une liste.
 *
 * `issuedById` et les adresses n'y sont pas : une ligne de liste affiche un
 * numéro, une date et un montant, et le reste se lit sur la facture.
 */
const INVOICE_LIST_SELECT = {
  id: true,
  number: true,
  issuedAt: true,
  amount: true,
  currency: true,
  orderNumber: true,
  orderTitle: true,
  buildingName: true,
  clientId: true,
  clientName: true,
  workOrderId: true,
} as const;

export async function GET(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");
    const { searchParams } = new URL(request.url);
    const { page, limit, skip } = parsePagination(searchParams);

    const workOrderId = searchParams.get("workOrderId");
    const clientId = searchParams.get("clientId");

    const where: Record<string, unknown> = {};
    if (workOrderId) where.workOrderId = workOrderId;
    if (clientId) where.clientId = clientId;

    // Le périmètre du compte client est posé *après* les filtres, et écrase :
    // un client qui ajoute `?clientId=<un autre>` à l'adresse doit obtenir ses
    // propres factures, pas celles du voisin.
    if (session.user.role === "BUILDING_OWNER") {
      where.clientId = session.user.id;
    }

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        select: INVOICE_LIST_SELECT,
        orderBy: { issuedAt: "desc" },
        take: limit,
        skip,
      }),
      prisma.invoice.count({ where }),
    ]);

    return NextResponse.json({
      data: invoices,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

const IssueInvoiceSchema = z
  .object({ workOrderId: z.string().trim().min(1, "Le bon de travail est obligatoire") })
  .strict();

/**
 * Émet la facture d'un bon.
 *
 * Idempotent : rappeler cette route sur un bon déjà facturé renvoie la facture
 * existante. C'est ce qui permet de l'appeler sans risque après une validation —
 * et de l'appeler à nouveau depuis l'écran si la première tentative a échoué.
 *
 * Réservé aux rôles de gestion : émettre une facture est une décision, pas une
 * lecture.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireRole(...MANAGEMENT_ROLES);
    const parsed = IssueInvoiceSchema.parse(await readJson(request));

    const workOrder = await prisma.workOrder.findUnique({
      where: { id: parsed.workOrderId },
      select: {
        id: true,
        status: true,
        isBillable: true,
        invoiceAmount: true,
      },
    });
    if (!workOrder) {
      throw notFound(`Bon de travail introuvable : ${parsed.workOrderId}`);
    }

    /**
     * On refuse d'avancer une facture pour un travail qui n'est pas terminé.
     *
     * Sans cette garde, la route permettrait de facturer un bon encore ouvert ou
     * en attente de validation — c'est-à-dire d'envoyer une facture avant que
     * quiconque ait relu ce qui a été fait.
     */
    if (workOrder.status !== "COMPLETED") {
      throw badRequest(
        "Une facture ne peut être émise que pour un bon de travail clôturé."
      );
    }
    if (!workOrder.isBillable || workOrder.invoiceAmount === null) {
      throw badRequest(
        "Ce bon n'est pas facturable, ou son montant n'a pas été renseigné."
      );
    }

    const invoice = await issueInvoiceForWorkOrder(
      workOrder.id,
      session.user.id ?? null
    );
    if (!invoice) {
      throw badRequest("L'émission de la facture n'a produit aucun document.");
    }

    return jsonOk(invoice, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
