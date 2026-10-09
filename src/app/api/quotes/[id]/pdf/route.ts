/**
 * Maintenance RMASC – le devis, en PDF.
 *
 * GET /api/quotes/:id/pdf – l'offre, telle qu'elle est remise au client
 *
 * QUI PEUT LE TÉLÉCHARGER
 * Les rôles de gestion, et le client à qui l'offre est adressée — c'est même le
 * principal intérêt du portail : un devis se consulte, s'imprime et se signe
 * sans passer par le bureau. Un client ne peut lire que les siens : `findFirst`
 * avec le filtre rend `null` pour celui d'un autre, ce qui est déjà la 404 à
 * servir, et qui n'apprend pas à l'appelant que l'identifiant existe.
 *
 * AUCUN PARAMÈTRE DE FORME
 * Comme le PDF d'une facture, et pour la même raison : un devis est un document
 * qu'un client signe. Deux personnes qui téléchargent le même ne doivent pas
 * pouvoir obtenir deux fichiers différents, et une adresse fabriquée à la main
 * ne doit pas produire une variante de l'offre.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError, notFound } from "@/lib/api/http";
import { MANAGEMENT_ROLES, requireRole } from "@/lib/api/guard";
import { quoteFileName, renderQuotePdf } from "@/lib/quotes/pdf";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoQuoteById } from "@/lib/demo/responses";
import type { Prisma } from "@prisma/client";

type Params = { params: { id: string } };

/** pdfkit lit ses polices et le tampon sur le disque : jamais dans l'edge. */
export const runtime = "nodejs";

/**
 * Ce qu'un devis doit porter pour être imprimé.
 *
 * `lines` est trié par position : l'ordre des lignes est celui du bureau, et un
 * devis dont les lignes se réordonnent à l'impression changerait la lecture des
 * totaux partiels qu'un client fait de tête.
 */
const DOCUMENT_SELECT = {
  number: true,
  status: true,
  createdAt: true,
  sentAt: true,
  validityDays: true,
  need: true,
  notes: true,
  client: { select: { name: true } },
  building: { select: { name: true, address: true, city: true } },
  elevator: { select: { elevatorCode: true } },
  lines: {
    select: {
      reference: true,
      designation: true,
      quantity: true,
      unit: true,
      unitPrice: true,
    },
    orderBy: { position: "asc" as const },
  },
} satisfies Prisma.QuoteSelect;

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireRole(...MANAGEMENT_ROLES, "BUILDING_OWNER");

    const where: Prisma.QuoteWhereInput = {
      id: params.id,
      // Le périmètre du compte client, posé dans la requête plutôt que vérifié
      // après coup.
      ...(session.user.role === "BUILDING_OWNER"
        ? { clientId: session.user.id }
        : {}),
    };

    const row = await prisma.quote.findFirst({
      where,
      select: DOCUMENT_SELECT,
    });
    if (!row) throw notFound(`Devis introuvable : ${params.id}`);

    const pdf = await renderQuotePdf(toDocument(row));
    return pdfResponse(pdf, row.number);
  } catch (error) {
    if (shouldServeDemoData(error)) {
      const row = demoQuoteById(params.id);
      if (!row) {
        return handleRouteError(
          notFound(`Devis introuvable : ${params.id}`)
        );
      }
      warnDemoFallbackOnce("GET /api/quotes/[id]/pdf");
      const pdf = await renderQuotePdf(toDocument(row));
      return pdfResponse(pdf, row.number);
    }
    return handleRouteError(error);
  }
}

/** La forme que le générateur attend — décrite par ses champs, pas par Prisma. */
function toDocument(row: {
  number: string;
  status: string;
  createdAt: Date;
  sentAt: Date | null;
  validityDays: number;
  need: string;
  notes: string | null;
  client: { name: string } | null;
  building: { name: string; address: string; city: string };
  elevator: { elevatorCode: string } | null;
  lines: readonly {
    reference: string | null;
    designation: string;
    quantity: unknown;
    unit: string | null;
    unitPrice: unknown;
  }[];
}) {
  /**
   * La validité court à compter de l'envoi, et non de la demande.
   *
   * Compter trente jours depuis la création ferait expirer une offre avant
   * qu'elle soit lue, dès que le bureau met une semaine à la chiffrer. Tant que
   * le devis n'est pas remis, il n'a pas de date de fin — et le document le dit
   * plutôt que d'imprimer une échéance qui ne veut rien dire.
   */
  const validUntil = row.sentAt
    ? new Date(row.sentAt.getTime() + row.validityDays * 24 * 60 * 60 * 1000)
    : null;

  return {
    number: row.number,
    status: row.status,
    issuedAt: row.createdAt,
    validUntil,
    validityDays: row.validityDays,
    need: row.need,
    notes: row.notes,
    clientName: row.client?.name ?? "—",
    buildingName: row.building.name,
    buildingAddress: row.building.address,
    buildingCity: row.building.city,
    elevatorCode: row.elevator?.elevatorCode ?? null,
    // Un `Decimal` de Prisma traverse la frontière typée en `unknown` : on le
    // ramène ici à un nombre, une fois, plutôt qu'à chaque usage.
    lines: row.lines.map((line) => ({
      reference: line.reference,
      designation: line.designation,
      quantity: Number(String(line.quantity)),
      unit: line.unit,
      unitPrice: Number(String(line.unitPrice)),
    })),
  };
}

function pdfResponse(pdf: Buffer, reference: string): NextResponse {
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${quoteFileName(reference)}"`,
      "Content-Length": String(pdf.byteLength),
      // Une offre porte un prix et le nom d'un client : elle ne se met pas en
      // cache, comme le PDF d'une facture.
      "Cache-Control": "private, no-store",
    },
  });
}
