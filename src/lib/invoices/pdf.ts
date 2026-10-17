/**
 * La facture, en PDF.
 *
 * Module serveur : il lit le disque et produit un flux binaire. Rien de ce qui
 * est ici ne doit atteindre un bundle navigateur.
 *
 * LA MISE EN PAGE COMMUNE VIENT DE `documents/charte.ts`
 * Ce fichier portait sa propre copie des marges, des encres, de `printable`,
 * de `frenchDate`, du chemin du tampon, de l'en-tête et du trait de séparation.
 * C'était la quatrième copie d'une mise en page qui doit rester identique d'un
 * document à l'autre — le jour où l'adresse de l'entreprise change, une seule
 * des quatre la voit changer. Tout ce qui doit *se ressembler* est désormais
 * importé ; seule la composition propre à une facture reste ici.
 *
 * Ce qui reste propre à ce document, et ne doit pas remonter dans la charte :
 * le bloc client/intervention, le bandeau d'état, le tableau des pièces et le
 * total. Une « fonction de facture » paramétrée par un titre ne produirait
 * correctement aucun des documents.
 *
 * LA RÉGRESSION VISUELLE A ÉTÉ VÉRIFIÉE, PAS SUPPOSÉE
 * `scripts/pdf-golden.ts` rend sept variantes (ordinaire, sans pièces, réglée,
 * annulée, sans coordonnées, textes longs, devise étrangère) et imprime
 * l'empreinte SHA-256 de leurs flux de contenu décompressés. Les empreintes
 * avant et après ce raccordement sont identiques.
 *
 * Elles ne peuvent pas porter sur le fichier entier : pdfkit inscrit la date de
 * création dans le PDF, et deux rendus du même code diffèrent donc de quelques
 * octets. C'est le *contenu* qui doit être identique, et il l'est.
 *
 * IL N'INVENTE AUCUNE MENTION LÉGALE
 * Le cachet de l'entreprise — raison sociale, adresse, téléphone, numéro
 * d'identification fiscale — n'est pas écrit en dur. Une facture portant une
 * adresse ou un NIF fabriqués serait un faux document, et c'est exactement le
 * genre de valeur qu'on ne remarque pas avant de l'avoir envoyée à un client.
 * Ces mentions viennent donc de l'environnement, et le document s'imprime sans
 * elles tant qu'elles ne sont pas renseignées :
 *
 *   INVOICE_COMPANY_NAME      « RMASC » par défaut — le seul nom qu'on connaisse
 *   INVOICE_COMPANY_ADDRESS
 *   INVOICE_COMPANY_PHONE
 *   INVOICE_COMPANY_EMAIL
 *   INVOICE_COMPANY_TAX_ID    NIF, RC, ou ce que l'administration exige
 *
 * LE TAMPON
 * `cachet.png` est posé en bas à droite. Le fichier vit dans `public/`, ou
 * partout ailleurs si `INVOICE_STAMP_PATH` le désigne. S'il est absent, la
 * facture s'imprime sans tampon — jamais avec un carré vide ou une image de
 * remplacement : un document sans cachet est une facture non signée, un
 * document avec un faux cachet est un document falsifié.
 *
 * POURQUOI LES VALEURS VIENNENT DE LA LIGNE `Invoice`
 * Voir le commentaire du modèle : une facture est un document opposable, et tout
 * ce qu'elle imprime est figé à l'émission. Ce module ne lit jamais le bon.
 *
 * L'ÉTAT EST LA SEULE CHOSE QUI BOUGE, ET C'EST VOULU
 * Tout ce qui précède reste vrai du contenu : le client, le lieu, les travaux,
 * les pièces et le montant viennent des colonnes figées le jour de l'émission.
 * L'*état* de la pièce, lui, est relu sur la ligne à chaque rendu — et c'est
 * nécessaire, parce qu'une facture annulée qui continuerait de s'imprimer comme
 * une facture ordinaire réclame une somme que plus personne ne doit.
 *
 * Une facture restée `ISSUED` s'imprime exactement comme avant que la colonne
 * n'existe. Aucune pièce déjà envoyée à un client ne change d'aspect, donc
 * aucune réimpression ne devient une variante du document d'origine.
 */

import PDFDocument from "pdfkit";
import type { Invoice } from "@prisma/client";
import {
  INK,
  MUTED,
  PAGE_MARGIN,
  RULE,
  drawDocumentHeader,
  drawSectionTitle,
  drawStamp,
  frame,
  frenchDate,
  printable,
} from "@/lib/documents/charte";
import { formatDzd } from "@/lib/ui/money";

/** Une pièce telle qu'elle a été figée sur la facture. */
interface FrozenPart {
  name: string;
  partNumber?: string;
  qty: number;
}

/**
 * Relit la liste des pièces depuis la colonne JSON.
 *
 * Le contenu vient de `WorkOrder.partsReplaced`, écrit par le formulaire du
 * technicien, donc de forme connue — mais une colonne `Json` accepte n'importe
 * quoi, et une facture ne doit pas échouer parce qu'une ligne écrite il y a deux
 * ans n'a pas la bonne forme. Ce qui ne se lit pas est ignoré.
 */
function readParts(value: unknown): FrozenPart[] {
  if (!Array.isArray(value)) return [];
  const parts: FrozenPart[] = [];
  for (const raw of value) {
    const line = raw as { name?: unknown; partNumber?: unknown; qty?: unknown };
    if (typeof line?.name !== "string" || line.name.trim() === "") continue;
    const qty = typeof line.qty === "number" ? line.qty : Number(line.qty);
    parts.push({
      name: line.name.trim(),
      ...(typeof line.partNumber === "string" && line.partNumber.trim() !== ""
        ? { partNumber: line.partNumber.trim() }
        : {}),
      qty: Number.isFinite(qty) ? qty : 1,
    });
  }
  return parts;
}

function amountLabel(amount: Invoice["amount"], currency: string): string {
  // `formatDzd` écrit « DZD » parce que tout montant de ce produit est en
  // dinars. La colonne existe pour qu'une seconde devise n'exige pas une
  // migration ; si elle arrive un jour, c'est le code stocké qui s'imprime.
  return currency === "DZD"
    ? formatDzd(amount.toString()) ?? "0 DZD"
    : `${amount.toString()} ${currency}`;
}

/**
 * Le bandeau d'état, ou `null` pour une facture ordinaire.
 *
 * Il n'est rendu que sur une pièce qui n'est plus due. `ISSUED` ne produit rien
 * du tout, et c'est la garantie qu'une facture jamais touchée s'imprime
 * exactement comme avant l'existence de la colonne.
 *
 * Le texte dit ce que l'état veut dire, et pas seulement son nom : « ANNULÉE »
 * seul laisse un lecteur devant la question de savoir s'il doit payer. Le
 * bandeau vert, lui, sert au règlement — la facture réglée qu'un client
 * redemande est un document qui circule, et il vaut mieux qu'il porte la réponse
 * que de la laisser chercher.
 */
function statusBand(invoice: Invoice): {
  label: string;
  fill: string;
  ink: string;
} | null {
  const since = invoice.statusChangedAt
    ? ` le ${printable(frenchDate(invoice.statusChangedAt))}`
    : "";

  if (invoice.status === "PAID") {
    return {
      label: printable(`RÉGLÉE${since} — cette facture a été acquittée`),
      fill: "#dcfce7",
      ink: "#166534",
    };
  }

  if (invoice.status === "CANCELLED") {
    return {
      label: printable(
        `ANNULÉE${since} — cette facture est sans effet et n'est plus due`
      ),
      fill: "#fee2e2",
      ink: "#991b1b",
    };
  }

  return null;
}

/**
 * Rend la facture et renvoie son contenu binaire.
 *
 * Renvoie un `Buffer` plutôt qu'un flux : une facture A4 tient en quelques
 * dizaines de kilo-octets, et un `Buffer` laisse la route poser un
 * `Content-Length` exact, ce qu'un flux ne permet pas sans compter à l'avance.
 */
export function renderInvoicePdf(invoice: Invoice): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: PAGE_MARGIN,
      info: {
        Title: `Facture ${invoice.number}`,
        Author: process.env.INVOICE_COMPANY_NAME ?? "RMASC",
        Subject: `Bon de travail ${invoice.orderNumber}`,
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const { left, right, width } = frame(doc);

    /**
     * Tout ce que le document imprime, passé une fois par `printable`.
     *
     * Une seule barrière plutôt qu'un appel à chaque `doc.text` : aucune ligne
     * de cette mise en page ne peut l'oublier, et une correction du même genre
     * — un tiret, un guillemet — n'a qu'un endroit où se poser.
     */
    const view = {
      number: printable(invoice.number),
      issuedAt: printable(frenchDate(invoice.issuedAt)),
      clientName: printable(invoice.clientName),
      clientAddress: invoice.clientAddress
        ? printable(invoice.clientAddress)
        : null,
      clientEmail: invoice.clientEmail ? printable(invoice.clientEmail) : null,
      clientPhone: invoice.clientPhone ? printable(invoice.clientPhone) : null,
      buildingName: printable(invoice.buildingName),
      buildingAddress: printable(invoice.buildingAddress),
      buildingCity: printable(invoice.buildingCity),
      elevatorCode: printable(invoice.elevatorCode),
      orderNumber: printable(invoice.orderNumber),
      orderTitle: printable(invoice.orderTitle),
      reportNotes: invoice.reportNotes ? printable(invoice.reportNotes) : null,
      orderType: invoice.orderType,
      amount: printable(amountLabel(invoice.amount, invoice.currency)),
      completedLabel: invoice.completedAt
        ? printable(frenchDate(invoice.completedAt))
        : null,
    };

    const parts = readParts(invoice.partsReplaced).map((part) => ({
      ...part,
      name: printable(part.name),
      ...(part.partNumber ? { partNumber: printable(part.partNumber) } : {}),
    }));

    // ─── En-tête ──────────────────────────────────────────────
    //
    // L'entreprise à gauche, le document à droite, puis le trait de séparation.
    // `drawDocumentHeader` rend la hauteur de ce trait : l'appelant n'a pas à
    // recalculer où il tombe.
    let y = drawDocumentHeader(doc, {
      title: "FACTURE",
      lines: [view.number, `Émise le ${view.issuedAt}`],
    });
    y += 18;

    // ─── État de la pièce ─────────────────────────────────────
    //
    // Placé juste sous l'en-tête, avant tout le contenu : c'est la première
    // chose qu'un lecteur doit savoir d'une facture annulée, et la dernière
    // qu'il lirait si le bandeau vivait en pied de page.
    const band = statusBand(invoice);
    if (band) {
      const bandHeight = 24;
      doc.rect(left, y, width, bandHeight).fill(band.fill);
      doc
        .fillColor(band.ink)
        .font("Helvetica-Bold")
        .fontSize(10)
        .text(band.label, left + 10, y + 8, { width: width - 20 });
      y += bandHeight + 18;
    }

    // ─── Client et lieu ───────────────────────────────────────
    const columnWidth = (width - 24) / 2;

    // Les deux étiquettes ne passent pas par `drawSectionTitle` : elles sont
    // posées sur une demi-largeur, alors que la charte écrit sur toute la
    // ligne. Les forcer dans l'aide commune les ferait déborder l'une sur
    // l'autre.
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8);
    doc.text("FACTURÉ À", left, y, { width: columnWidth });
    doc.text("INTERVENTION", left + columnWidth + 24, y, { width: columnWidth });

    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11);
    doc.text(view.clientName, left, y + 14, { width: columnWidth });
    doc.text(view.buildingName, left + columnWidth + 24, y + 14, {
      width: columnWidth,
    });

    doc.font("Helvetica").fontSize(9).fillColor(MUTED);
    const clientLines = [
      view.clientAddress,
      view.clientEmail,
      view.clientPhone,
    ].filter((line): line is string => Boolean(line));
    const siteLines = [
      view.buildingAddress,
      view.buildingCity,
      `Appareil ${view.elevatorCode}`,
    ].filter((line): line is string => Boolean(line));

    const clientHeight = doc.heightOfString(clientLines.join("\n") || "—", {
      width: columnWidth,
    });
    const siteHeight = doc.heightOfString(siteLines.join("\n"), {
      width: columnWidth,
    });

    doc.text(clientLines.join("\n") || "—", left, y + 30, { width: columnWidth });
    doc.text(siteLines.join("\n"), left + columnWidth + 24, y + 30, {
      width: columnWidth,
    });

    y += 30 + Math.max(clientHeight, siteHeight) + 20;

    // ─── Le bon ───────────────────────────────────────────────
    doc.rect(left, y, width, 26).fill("#f3f4f6");
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(9);
    doc.text(`Bon de travail ${view.orderNumber}`, left + 10, y + 8, {
      width: width - 20,
    });
    doc.font("Helvetica").fillColor(MUTED);
    doc.text(
      view.completedLabel
        ? `Clos le ${view.completedLabel}`
        : `Type : ${view.orderType}`,
      left + 10,
      y + 8,
      { width: width - 20, align: "right" }
    );
    y += 26 + 18;

    doc.fillColor(INK).font("Helvetica-Bold").fontSize(12);
    doc.text(view.orderTitle, left, y, { width });
    y = doc.y + 16;

    // ─── Travaux effectués ────────────────────────────────────
    drawSectionTitle(doc, "TRAVAUX EFFECTUÉS", y);
    doc.fillColor(INK).font("Helvetica").fontSize(10);
    doc.text(view.reportNotes?.trim() || "Non renseigné.", left, y + 13, {
      width,
      lineGap: 2,
    });
    y = doc.y + 20;

    // ─── Pièces ───────────────────────────────────────────────
    drawSectionTitle(doc, "PIÈCES REMPLACÉES", y);
    y += 14;

    const colRef = left + width * 0.62;
    const colQty = left + width * 0.86;

    if (parts.length === 0) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(10);
      doc.text("Aucune pièce remplacée sur cette intervention.", left, y, { width });
      y = doc.y + 16;
    } else {
      doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8);
      doc.text("DÉSIGNATION", left, y, { width: colRef - left });
      doc.text("RÉFÉRENCE", colRef, y, { width: colQty - colRef });
      doc.text("QTÉ", colQty, y, { width: right - colQty, align: "right" });
      y += 12;
      doc.moveTo(left, y).lineTo(right, y).strokeColor(RULE).lineWidth(0.5).stroke();
      y += 6;

      for (const part of parts) {
        const rowTop = y;
        doc.fillColor(INK).font("Helvetica").fontSize(10);
        doc.text(part.name, left, rowTop, { width: colRef - left - 8 });
        const nameHeight = doc.heightOfString(part.name, {
          width: colRef - left - 8,
        });

        doc.fillColor(MUTED).fontSize(9);
        doc.text(part.partNumber ?? "—", colRef, rowTop + 1, {
          width: colQty - colRef - 8,
        });
        doc.fillColor(INK).fontSize(10);
        doc.text(String(part.qty), colQty, rowTop, {
          width: right - colQty,
          align: "right",
        });

        y = rowTop + Math.max(nameHeight, 12) + 6;
      }
      y += 6;
    }

    // ─── Total ────────────────────────────────────────────────
    y += 4;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(RULE).lineWidth(1).stroke();
    y += 14;

    doc.fillColor(MUTED).font("Helvetica").fontSize(9);
    doc.text(
      "Le montant ci-dessous comprend la main-d'œuvre et les pièces listées ci-dessus.",
      left,
      y + 6,
      { width: width * 0.55 }
    );

    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11);
    doc.text("TOTAL À PAYER", left + width * 0.6, y, {
      width: width * 0.4,
      align: "right",
    });
    doc.fontSize(16);
    doc.text(view.amount, left + width * 0.6, y + 14, {
      width: width * 0.4,
      align: "right",
    });

    // Le bloc de total occupe environ 40 points ; on repart en dessous pour le
    // cachet, qui ne doit jamais recouvrir le montant.
    y += 56;

    // ─── Tampon ───────────────────────────────────────────────
    //
    // `drawStamp` borne le tampon dans la page et ne fait jamais échouer le
    // document sur un fichier illisible.
    drawStamp(doc, y);

    doc.end();
  });
}
