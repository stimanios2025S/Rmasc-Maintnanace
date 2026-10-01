/**
 * Maintenance RMASC – le PDF d'une facture.
 *
 * GET /api/invoices/:id/pdf – le document, tel qu'il a été émis
 *
 * POURQUOI CETTE ROUTE NE PREND AUCUN PARAMÈTRE DE FORME
 * Rien ici ne permet de choisir une mise en page, une langue ou un sous-ensemble
 * de champs. Une facture est un document opposable : deux personnes qui
 * téléchargent la même ne doivent pas pouvoir obtenir deux fichiers différents,
 * et une adresse fabriquée à la main ne doit pas produire une variante du
 * document. Le seul paramètre est l'identifiant de la facture.
 *
 * LE NOM DU FICHIER
 * `Content-Disposition: attachment` avec le numéro dans le nom, pour que le
 * fichier enregistré soit identifiable sans l'ouvrir. Le numéro est déjà
 * contraint par le schéma (`FA-AAAA-NNNN`) ; il est tout de même assaini, parce
 * qu'un en-tête HTTP est construit par concaténation et qu'une valeur contenant
 * un guillemet ou un retour à la ligne y injecterait une directive.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError, notFound } from "@/lib/api/http";
import { OPS_ROLES, requireRole } from "@/lib/api/guard";
import { renderInvoicePdf } from "@/lib/invoices/pdf";

type Params = { params: { id: string } };

/**
 * pdfkit lit ses polices et les images sur le disque : la route doit tourner
 * dans le runtime Node, jamais dans l'edge, où `fs` n'existe pas.
 */
export const runtime = "nodejs";

/** Ne laisse passer que de quoi composer un nom de fichier sûr. */
function safeFileName(number: string): string {
  const cleaned = number.replace(/[^A-Za-z0-9-]/g, "");
  return `Facture-${cleaned || "sans-numero"}.pdf`;
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");

    const where: { id: string; clientId?: string } = { id: params.id };
    // Un compte client ne télécharge que ses propres factures. `findFirst` avec
    // ce filtre renvoie `null` pour celle d'un autre, ce qui est déjà la 404 à
    // servir — et qui n'apprend pas à l'appelant que l'identifiant existe.
    if (session.user.role === "BUILDING_OWNER") {
      where.clientId = session.user.id;
    }

    const invoice = await prisma.invoice.findFirst({ where });
    if (!invoice) throw notFound(`Facture introuvable : ${params.id}`);

    const pdf = await renderInvoicePdf(invoice);

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${safeFileName(invoice.number)}"`,
        "Content-Length": String(pdf.byteLength),
        // Un document financier ne se met pas en cache : ni par un proxy
        // d'entreprise, ni par l'historique partagé d'un poste de bureau.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
