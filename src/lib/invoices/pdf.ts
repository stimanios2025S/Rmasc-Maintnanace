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
 * le bloc client/intervention, le bandeau d'état, le tableau financier et le
 * total. Une « fonction de facture » paramétrée par un titre ne produirait
 * correctement aucun des documents.
 *
 * LA TVA, ET POURQUOI ELLE EST DÉDUITE DU TOTAL
 * Le schéma ne stocke qu'un montant : `Invoice.amount`, celui que le bureau a
 * arrêté à l'émission. Il n'existe ni colonne de taux ni lignes chiffrées, et
 * une facture émise est figée — on ne recalcule pas ce qu'un client doit.
 *
 * Le document imprime pourtant HT / TVA / TTC, comme le formulaire de
 * l'entreprise. Le montant stocké est donc traité comme le **TTC** : le HT est
 * obtenu en le divisant par 1,19 et la TVA par différence. Le total à payer
 * reste exactement celui de la base, au centime près ; c'est la seule lecture
 * qui ne modifie pas une facture déjà envoyée.
 *
 * POURQUOI LE TABLEAU NE PORTE QU'UNE LIGNE
 * Les prix ne sont pas stockés par pièce : le technicien saisit un montant
 * global et la liste des pièces posées. Inventer des prix unitaires pour
 * remplir des colonnes produirait un document faux. Le tableau porte donc la
 * prestation facturée (quantité 1, prix HT déduit), et les pièces sont listées
 * en annexe avec leurs quantités, sous le tableau.
 *
 * IL N'INVENTE AUCUNE MENTION LÉGALE
 * Le cachet de l'entreprise — raison sociale, adresse, téléphone, identifiants
 * légaux — n'est pas écrit en dur. Une facture portant une adresse ou un NIF
 * fabriqués serait un faux document, et c'est exactement le genre de valeur
 * qu'on ne remarque pas avant de l'avoir envoyée à un client. Ces mentions
 * viennent de `charte.ts`, donc de l'environnement (voir `.env.example`) :
 *
 *   INVOICE_COMPANY_NAME / ADDRESS / PHONE / EMAIL
 *   INVOICE_COMPANY_RC / NIF / NIS / AI
 *   INVOICE_COMPANY_BANK / RIB
 *   INVOICE_COMPANY_MENTIONS
 *   INVOICE_LOGO_PATH, INVOICE_STAMP_PATH
 *
 * L'ÉCHÉANCE DE PAIEMENT
 * Le schéma ne porte pas de colonne d'échéance. Le document imprime la date
 * d'émission augmentée du délai de règlement, `INVOICE_PAYMENT_TERMS_DAYS`
 * (30 jours par défaut) — une valeur de configuration, pas une donnée figée par
 * facture.
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
  companyName,
  drawDocumentFooter,
  drawDocumentHeader,
  drawSectionTitle,
  drawStampIn,
  frame,
  frenchDate,
  printable,
} from "@/lib/documents/charte";
import { VAT_RATE_PERCENT } from "@/lib/quotes/totals";
import { amountInWords } from "@/lib/quotes/words";

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

/** Le délai de règlement imprimé en échéance, en jours. */
function paymentTermsDays(): number {
  const configured = Number(process.env.INVOICE_PAYMENT_TERMS_DAYS);
  return Number.isFinite(configured) && configured > 0 ? configured : 30;
}

/**
 * Les trois montants du document, déduits du total stocké (voir l'en-tête).
 *
 * Le calcul se fait au centime, comme le module des devis : une TVA calculée en
 * flottant sur un total de 12 500 afficherait 1 995,8000000000002.
 */
function totalsFromTtc(amount: number): {
  totalHt: number;
  vatAmount: number;
  totalTtc: number;
} {
  const totalTtc = Math.round(amount * 100) / 100;
  const totalHt =
    Math.round((totalTtc / (1 + VAT_RATE_PERCENT / 100)) * 100) / 100;
  const vatAmount = Math.round((totalTtc - totalHt) * 100) / 100;
  return { totalHt, vatAmount, totalTtc };
}

/** Un montant tel qu'il s'imprime dans une colonne : « 10 504,20 ». */
function moneyLabel(value: number): string {
  return printable(
    value.toLocaleString("fr-FR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
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
      // Les pages restent en mémoire pour recevoir le pied de page après coup :
      // sans ce tampon, seule la dernière page porterait les mentions.
      bufferPages: true,
      info: {
        Title: `Facture ${invoice.number}`,
        Author: companyName(),
        Subject: `Bon de travail ${invoice.orderNumber}`,
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const { left, right, width } = frame(doc);

    /** Ajoute une page si le contenu n'a plus de place, et rend le nouveau y. */
    const ensureRoom = (y: number, needed: number): number => {
      if (y + needed < doc.page.height - PAGE_MARGIN) return y;
      doc.addPage();
      return PAGE_MARGIN;
    };

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
      completedLabel: invoice.completedAt
        ? printable(frenchDate(invoice.completedAt))
        : null,
    };

    const parts = readParts(invoice.partsReplaced).map((part) => ({
      ...part,
      name: printable(part.name),
      ...(part.partNumber ? { partNumber: printable(part.partNumber) } : {}),
    }));

    const totals = totalsFromTtc(Number(invoice.amount));
    const dueAt = new Date(
      invoice.issuedAt.getTime() + paymentTermsDays() * 86_400_000
    );

    // ─── En-tête ──────────────────────────────────────────────
    //
    // L'entreprise à gauche (logo, coordonnées, identifiants), le document à
    // droite, puis le trait de séparation rendu par la charte.
    let y = drawDocumentHeader(doc, {
      title: "FACTURE",
      lines: [view.number],
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

    // ─── Client, site et références ───────────────────────────
    const columnWidth = (width - 24) / 2;
    const rightColumnX = left + columnWidth + 24;

    // Les deux étiquettes ne passent pas par `drawSectionTitle` : elles sont
    // posées sur une demi-largeur, alors que la charte écrit sur toute la
    // ligne. Les forcer dans l'aide commune les ferait déborder l'une sur
    // l'autre.
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8);
    doc.text("FACTURÉ À", left, y, { width: columnWidth });
    doc.text("SITE / APPAREIL", rightColumnX, y, { width: columnWidth });

    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11);
    doc.text(view.clientName, left, y + 14, { width: columnWidth });
    doc.text(view.buildingName, rightColumnX, y + 14, { width: columnWidth });

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

    doc.text(clientLines.join("\n") || "—", left, y + 30, {
      width: columnWidth,
      lineGap: 1,
    });
    doc.text(siteLines.join("\n"), rightColumnX, y + 30, {
      width: columnWidth,
      lineGap: 1,
    });

    y += 30 + Math.max(clientHeight, siteHeight) + 14;

    // ─── Références ───────────────────────────────────────────
    y = ensureRoom(y, 60);
    drawSectionTitle(doc, "Références de la facture", y);
    y += 13;

    const references = [
      `Numéro : ${view.number}`,
      `Date d'émission : ${view.issuedAt}`,
      `Échéance de paiement : ${printable(frenchDate(dueAt))}`,
    ];

    doc.fillColor(MUTED).font("Helvetica").fontSize(9);
    doc.text(printable(references.join("   ·   ")), left, y, {
      width,
      lineGap: 2,
    });
    y = doc.y + 16;

    // ─── Le bon d'origine ─────────────────────────────────────
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
    y += 26 + 16;

    doc.fillColor(INK).font("Helvetica-Bold").fontSize(12);
    doc.text(view.orderTitle, left, y, { width });
    y = doc.y + 16;

    // ─── Travaux effectués ────────────────────────────────────
    y = ensureRoom(y, 70);
    drawSectionTitle(doc, "Travaux effectués", y);
    doc.fillColor(INK).font("Helvetica").fontSize(10);
    doc.text(view.reportNotes?.trim() || "Non renseigné.", left, y + 13, {
      width,
      lineGap: 2,
    });
    y = doc.y + 18;

    // ─── Tableau financier ────────────────────────────────────
    y = ensureRoom(y, 110);

    const col = {
      designation: left,
      qty: left + width * 0.62,
      price: left + width * 0.74,
      amount: left + width * 0.87,
    };

    const headerRow = () => {
      doc.rect(left, y, width, 18).fill("#f3f4f6");
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(7.5);
      doc.text("DÉSIGNATION DES PRESTATIONS / PIÈCES", col.designation + 4, y + 6, {
        width: width * 0.6 - 8,
      });
      doc.text("QTÉ", col.qty, y + 6, {
        width: width * 0.1,
        align: "right",
      });
      doc.text("P.U. HT (DZD)", col.price, y + 6, {
        width: width * 0.12,
        align: "right",
      });
      doc.text("TOTAL HT (DZD)", col.amount, y + 6, {
        width: right - col.amount,
        align: "right",
      });
      y += 18;
    };

    headerRow();

    const designationWidth = width * 0.6 - 8;
    const designationHeight = doc.heightOfString(view.orderTitle, {
      width: designationWidth,
    });
    const rowHeight = Math.max(designationHeight, 11) + 8;

    doc.fillColor(INK).font("Helvetica").fontSize(8.5);
    doc.text(view.orderTitle, col.designation + 4, y + 4, {
      width: designationWidth,
    });
    doc.text("1", col.qty, y + 4, {
      width: width * 0.1,
      align: "right",
    });
    doc.text(moneyLabel(totals.totalHt), col.price, y + 4, {
      width: width * 0.12,
      align: "right",
    });
    doc.text(moneyLabel(totals.totalHt), col.amount, y + 4, {
      width: right - col.amount,
      align: "right",
    });
    y += rowHeight;

    doc
      .moveTo(left, y)
      .lineTo(right, y)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
    y += 14;

    // ─── Pièces remplacées (annexe) ───────────────────────────
    //
    // Sans prix unitaires : le montant a été arrêté globalement. Les lister
    // avec des prix inventés ferait un document faux ; les taire priverait le
    // client du détail de ce qui a été posé.
    if (parts.length > 0) {
      y = ensureRoom(y, 60);
      drawSectionTitle(doc, "Pièces remplacées — comprises dans le montant", y);
      y += 14;

      const colRef = left + width * 0.62;
      const colQty = left + width * 0.86;

      doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8);
      doc.text("DÉSIGNATION", left, y, { width: colRef - left });
      doc.text("RÉFÉRENCE", colRef, y, { width: colQty - colRef });
      doc.text("QTÉ", colQty, y, { width: right - colQty, align: "right" });
      y += 12;
      doc
        .moveTo(left, y)
        .lineTo(right, y)
        .strokeColor(RULE)
        .lineWidth(0.5)
        .stroke();
      y += 6;

      for (const part of parts) {
        const rowTop = y;
        doc.fillColor(INK).font("Helvetica").fontSize(9.5);
        doc.text(part.name, left, rowTop, { width: colRef - left - 8 });
        const nameHeight = doc.heightOfString(part.name, {
          width: colRef - left - 8,
        });

        doc.fillColor(MUTED).fontSize(8.5);
        doc.text(part.partNumber ?? "—", colRef, rowTop + 1, {
          width: colQty - colRef - 8,
        });
        doc.fillColor(INK).fontSize(9.5);
        doc.text(String(part.qty), colQty, rowTop, {
          width: right - colQty,
          align: "right",
        });

        y = rowTop + Math.max(nameHeight, 12) + 5;
      }
      y += 8;
    }

    // ─── Totaux ───────────────────────────────────────────────
    y = ensureRoom(y, 120);

    const totalsX = left + width * 0.55;
    const totalsWidth = right - totalsX;

    const totalRow = (label: string, value: string, bold = false) => {
      doc
        .fillColor(bold ? INK : MUTED)
        .font(bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(bold ? 11 : 9.5);
      doc.text(printable(label), totalsX, y, { width: totalsWidth * 0.6 });
      doc.text(printable(value), totalsX + totalsWidth * 0.6, y, {
        width: totalsWidth * 0.4,
        align: "right",
      });
      y += bold ? 18 : 14;
    };

    totalRow("Total HT", `${moneyLabel(totals.totalHt)} DZD`);
    totalRow(`TVA (${VAT_RATE_PERCENT}%)`, `${moneyLabel(totals.vatAmount)} DZD`);
    doc
      .moveTo(totalsX, y)
      .lineTo(right, y)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
    y += 6;
    totalRow("Total TTC", `${moneyLabel(totals.totalTtc)} DZD`, true);

    // ─── Le montant en lettres ────────────────────────────────
    y = ensureRoom(y, 50);
    doc.rect(left, y, width, 30).fill("#f9fafb");
    doc.fillColor(INK).font("Helvetica").fontSize(9.5);
    doc.text(
      printable(
        `Arrêté la présente facture à la somme de : ${amountInWords(
          totals.totalTtc
        )}.`
      ),
      left + 8,
      y + 7,
      { width: width - 16, lineGap: 2 }
    );
    y = doc.y + 16;

    // ─── Conditions et signature, côte à côte ────────────────
    //
    // Les empiler coûtait une page : sur une facture à une ligne, le cadre de
    // signature se retrouvait seul sur la deuxième feuille. Deux colonnes
    // gardent le document sur une page et rapprochent le cachet des conditions
    // qu'il engage.
    y = ensureRoom(y, 130);

    const signatureWidth = width * 0.48;
    const conditionsX = left + signatureWidth + 24;
    const conditionsWidth = width - signatureWidth - 24;

    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8);
    doc.text("CACHET ET SIGNATURE DE L'ENTREPRISE", left, y, {
      width: signatureWidth,
    });
    doc.text("CONDITIONS DE RÈGLEMENT", conditionsX, y, {
      width: conditionsWidth,
    });

    doc.fillColor(INK).font("Helvetica").fontSize(9);
    doc.text(
      printable(
        `Paiement à ${paymentTermsDays()} jours, échéance le ${frenchDate(
          dueAt
        )}. Règlement par virement bancaire aux coordonnées ci-dessous.`
      ),
      conditionsX,
      y + 13,
      { width: conditionsWidth, lineGap: 2 }
    );

    doc.fillColor(MUTED).font("Helvetica").fontSize(8);
    doc.text(printable(companyName()), left, y + 13, {
      width: signatureWidth,
    });
    doc.text("La Direction", left, y + 25, { width: signatureWidth });
    doc
      .rect(left, y + 38, signatureWidth, 56)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();

    // Le tampon est posé dans le cadre, jamais sur les conditions.
    drawStampIn(doc, left + 8, y + 42, 48);

    // ─── Pied de page, sur chaque page ────────────────────────
    const range = doc.bufferedPageRange();
    for (let index = 0; index < range.count; index++) {
      doc.switchToPage(range.start + index);
      drawDocumentFooter(doc, index + 1, range.count);
    }

    doc.end();
  });
}
