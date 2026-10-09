/**
 * Le devis, en PDF — For: APP/DA/04/14.
 *
 * IL REPRODUIT LE FORMULAIRE DE L'ENTREPRISE
 * Les rubriques, leur ordre, les intitulés des colonnes et les mentions de pied
 * sont ceux du papier : « Validité de l'offre », « Arrêté le présent devis à la
 * somme de », « Conditions de règlement : 50 % à la commande, solde à la
 * livraison », « Garantie : selon la nature des équipements fournis », « Bon
 * pour accord et confirmation ». Une offre de l'entreprise se reconnaît à ces
 * phrases, et un devis qui les reformulerait ne serait plus le document qu'un
 * client signe.
 *
 * LA TVA, QUE LES FACTURES N'ONT PAS
 * Le formulaire porte « TVA (19%) » en dur et un total TTC. C'est donc le
 * formulaire qui tranche un point que le schéma des factures laisse ouvert —
 * « Aucune TVA et aucun taux : le régime n'est pas tranché ». Ce module
 * n'imprime la TVA que sur un devis : une facture déjà émise ne change pas de
 * montant parce qu'un devis a été créé.
 *
 * CE QUI N'EST PAS IMPRIMÉ, ET POURQUOI
 * Le champ « Code Client » du formulaire n'a pas d'équivalent : le produit ne
 * tient aucun code client, et en inventer un produirait un numéro qui ne
 * correspondrait à rien dans les classeurs de l'entreprise. La ligne est donc
 * absente plutôt que remplie d'un faux.
 *
 * Module serveur : il lit le disque pour le tampon. Rien de ce qui est ici ne
 * doit atteindre un bundle navigateur.
 */

import PDFDocument from "pdfkit";
import {
  INK,
  MUTED,
  PAGE_MARGIN,
  RULE,
  companyName,
  documentFileName,
  drawDocumentHeader,
  drawRule,
  drawSectionTitle,
  drawStamp,
  frame,
  frenchDate,
  printable,
} from "@/lib/documents/charte";
import {
  VAT_RATE_PERCENT,
  computeQuoteTotals,
  formatDa,
  lineAmountHt,
} from "@/lib/quotes/totals";
import { amountInWords } from "@/lib/quotes/words";

export interface QuoteDocumentLine {
  reference: string | null;
  designation: string;
  quantity: number;
  unit: string | null;
  unitPrice: number;
}

export interface QuoteDocument {
  number: string;
  status: string;
  issuedAt: Date;
  /** Jusqu'à quand l'offre tient. Null tant que le devis n'a pas été remis. */
  validUntil: Date | null;
  validityDays: number;
  need: string;
  notes: string | null;
  clientName: string;
  buildingName: string;
  buildingAddress: string;
  buildingCity: string;
  elevatorCode: string | null;
  lines: readonly QuoteDocumentLine[];
}

export function quoteFileName(reference: string): string {
  return documentFileName("Devis", reference);
}

/**
 * Une quantité telle qu'elle s'imprime : « 2,5 » ou « 4 », jamais « 4.00 ».
 *
 * L'ÉCHAPPEMENT EST COMPRIS, ET C'EST LE POINT
 * `toLocaleString("fr-FR")` sépare les milliers par une espace fine insécable
 * (U+202F), qui n'existe pas dans l'encodage WinAnsi des polices standard de
 * pdfkit. Non convertie, pdfkit la remplace par une barre oblique : le montant
 * « 185 000,00 » s'imprime « 185 /000,00 ».
 *
 * La conversion est donc faite *dans* ces deux fonctions, et non à chaque appel
 * — c'est la leçon du module des factures, qui passe tout son contenu par une
 * seule barrière. Une barrière appliquée à quinze appels sur dix-huit laisse
 * trois montants faux, et c'est ce qui est arrivé ici : la première version de
 * ce tableau appelait `printable()` sur la référence et sur l'unité, et
 * l'oubliait sur les prix. Le contrôle du PDF l'a montré du premier coup.
 *
 * Rendre le texte déjà imprimable plutôt que compter sur l'appelant fait qu'on
 * ne *peut pas* oublier : il n'existe pas de variante non convertie à appeler.
 */
function quantityLabel(value: number): string {
  return printable(
    value.toLocaleString("fr-FR", { maximumFractionDigits: 2 })
  );
}

/** Le prix unitaire et le montant, qui sont toujours des montants. */
function moneyLabel(value: number): string {
  return printable(
    value.toLocaleString("fr-FR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

export function renderQuotePdf(quote: QuoteDocument): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: PAGE_MARGIN,
      info: {
        Title: `Devis ${quote.number}`,
        Author: companyName(),
        Subject: `Devis pour ${quote.buildingName}`,
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

    // ─── En-tête ──────────────────────────────────────────────
    let y = drawDocumentHeader(doc, {
      title: "DEVIS",
      lines: [
        quote.number,
        `Date : ${frenchDate(quote.issuedAt)}`,
        `Validité de l'offre : ${quote.validityDays} jours`,
      ],
    });
    y += 18;

    // ─── Identité du client et du projet ──────────────────────
    const columnWidth = (width - 24) / 2;

    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8);
    doc.text("CLIENT", left, y, { width: columnWidth });
    doc.text("PROJET / ADRESSE", left + columnWidth + 24, y, {
      width: columnWidth,
    });

    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11);
    doc.text(printable(quote.clientName), left, y + 14, { width: columnWidth });
    doc.text(printable(quote.buildingName), left + columnWidth + 24, y + 14, {
      width: columnWidth,
    });

    doc.font("Helvetica").fontSize(9).fillColor(MUTED);
    const siteLines = [
      quote.buildingAddress,
      quote.buildingCity,
      quote.elevatorCode ? `Appareil ${quote.elevatorCode}` : null,
    ].filter((line): line is string => Boolean(line));

    const clientHeight = doc.heightOfString("—", { width: columnWidth });
    const siteHeight = doc.heightOfString(printable(siteLines.join("\n")), {
      width: columnWidth,
    });

    doc.text("—", left, y + 30, { width: columnWidth });
    doc.text(printable(siteLines.join("\n")), left + columnWidth + 24, y + 30, {
      width: columnWidth,
    });
    y += 30 + Math.max(clientHeight, siteHeight) + 18;

    // ─── Le besoin ────────────────────────────────────────────
    y = ensureRoom(y, 90);
    drawSectionTitle(doc, "Objet de la demande", y);
    y += 13;
    doc.fillColor(INK).font("Helvetica").fontSize(10);
    doc.text(printable(quote.need), left, y, { width, lineGap: 2 });
    y = doc.y + 18;

    // ─── Le tableau ───────────────────────────────────────────
    y = ensureRoom(y, 120);

    // Les six colonnes du formulaire, en proportions de la largeur utile.
    //
    // Les largeurs ont été ajustées après un premier rendu : avec une colonne
    // « MONTANT HT (DA) » de 11 % de la largeur, l'en-tête se coupait sur deux
    // lignes et se lisait mal. Le contrôle du texte du PDF l'a montré — c'est
    // l'intérêt de relire le document plutôt que de le croire.
    const col = {
      ref: left,
      designation: left + width * 0.12,
      qty: left + width * 0.56,
      unit: left + width * 0.64,
      price: left + width * 0.73,
      amount: left + width * 0.86,
    };

    const headerRow = () => {
      doc.rect(left, y, width, 18).fill("#f3f4f6");
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(7.5);
      doc.text("RÉF", col.ref + 4, y + 6, { width: width * 0.12 - 6 });
      doc.text("DÉSIGNATION DES PRESTATIONS / FOURNITURES", col.designation + 4, y + 6, {
        width: width * 0.44 - 8,
      });
      doc.text("QTÉ", col.qty, y + 6, { width: width * 0.08, align: "right" });
      doc.text("UNITÉ", col.unit, y + 6, { width: width * 0.09, align: "right" });
      doc.text("P.U. (DA)", col.price, y + 6, {
        width: width * 0.13,
        align: "right",
      });
      doc.text("MONTANT HT (DA)", col.amount, y + 6, {
        width: right - col.amount,
        align: "right",
      });
      y += 18;
    };

    headerRow();

    if (quote.lines.length === 0) {
      doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(9);
      doc.text(
        printable(
          "Aucune prestation chiffrée à ce jour : ce devis est une demande en " +
            "attente de chiffrage."
        ),
        left + 4,
        y + 6,
        { width: width - 8 }
      );
      y += 24;
    }

    for (const line of quote.lines) {
      const amount = lineAmountHt(line);
      const designation = printable(line.designation);
      const designationWidth = width * 0.44 - 8;
      const height = doc.heightOfString(designation, {
        width: designationWidth,
      });
      const rowHeight = Math.max(height, 11) + 6;

      y = ensureRoom(y, rowHeight);
      // Une page ajoutée en cours de tableau doit reprendre ses en-têtes, sinon
      // la suite des lignes s'imprime sous rien.
      if (y === PAGE_MARGIN) headerRow();

      doc.fillColor(INK).font("Helvetica").fontSize(8.5);
      doc.text(printable(line.reference ?? "—"), col.ref + 4, y + 3, {
        width: width * 0.12 - 6,
      });
      doc.text(designation, col.designation + 4, y + 3, {
        width: designationWidth,
      });
      doc.text(quantityLabel(line.quantity), col.qty, y + 3, {
        width: width * 0.08,
        align: "right",
      });
      doc.text(printable(line.unit ?? "—"), col.unit, y + 3, {
        width: width * 0.09,
        align: "right",
      });
      doc.text(moneyLabel(line.unitPrice), col.price, y + 3, {
        width: width * 0.13,
        align: "right",
      });
      doc.text(moneyLabel(amount), col.amount, y + 3, {
        width: right - col.amount,
        align: "right",
      });

      y += rowHeight;
      doc.moveTo(left, y).lineTo(right, y).strokeColor(RULE).lineWidth(0.5).stroke();
    }

    y += 14;

    // ─── Totaux ───────────────────────────────────────────────
    y = ensureRoom(y, 110);
    const totals = computeQuoteTotals(quote.lines);
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

    totalRow("Total HT", formatDa(totals.totalHt));
    totalRow(`TVA (${VAT_RATE_PERCENT}%)`, formatDa(totals.vatAmount));
    doc.moveTo(totalsX, y).lineTo(right, y).strokeColor(RULE).lineWidth(0.5).stroke();
    y += 6;
    totalRow("Total TTC", formatDa(totals.totalTtc), true);

    // ─── Le montant en lettres ────────────────────────────────
    //
    // La mention du formulaire, et c'est une mention d'usage sur une offre :
    // elle rend le montant difficile à falsifier. Un chiffre se retouche, une
    // phrase se relit.
    y = ensureRoom(y, 60);
    doc.rect(left, y, width, 30).fill("#f9fafb");
    doc.fillColor(INK).font("Helvetica").fontSize(9.5);
    doc.text(
      printable(
        `Arrêté le présent devis à la somme de : ${amountInWords(totals.totalTtc)}.`
      ),
      left + 8,
      y + 7,
      { width: width - 16, lineGap: 2 }
    );
    y = doc.y + 16;

    // ─── Observations du bureau ───────────────────────────────
    if (quote.notes?.trim()) {
      y = ensureRoom(y, 60);
      drawSectionTitle(doc, "Observations", y);
      y += 13;
      doc.fillColor(INK).font("Helvetica").fontSize(9.5);
      doc.text(printable(quote.notes.trim()), left, y, { width, lineGap: 2 });
      y = doc.y + 16;
    }

    // ─── Conditions ───────────────────────────────────────────
    y = ensureRoom(y, 90);
    drawRule(doc, y, 0.5);
    y += 10;

    doc.fillColor(INK).font("Helvetica").fontSize(9);
    for (const mention of [
      "Conditions de règlement : 50 % à la commande, solde à la livraison.",
      "Garantie : selon la nature des équipements fournis.",
    ]) {
      doc.text(printable(mention), left, y, { width });
      y += 13;
    }
    doc.fillColor(MUTED).fontSize(8);
    doc.text(
      printable(
        `Devis valable ${quote.validityDays} jours${
          quote.validUntil ? ` à compter du ${frenchDate(quote.validUntil)}` : ""
        }.`
      ),
      left,
      y,
      { width }
    );
    y += 22;

    // ─── Bon pour accord ──────────────────────────────────────
    y = ensureRoom(y, 110);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.5);
    doc.text("Bon pour accord et confirmation", left, y, { width: width * 0.55 });
    doc.fillColor(MUTED).font("Helvetica").fontSize(8);
    doc.text("(Nom, date, signature et cachet du client)", left, y + 12, {
      width: width * 0.55,
    });
    doc.rect(left, y + 26, width * 0.55, 56).strokeColor(RULE).lineWidth(0.5).stroke();

    doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.5);
    doc.text("SARL RMASC", left + width * 0.6, y, { width: width * 0.4 });
    doc.fillColor(MUTED).font("Helvetica").fontSize(8);
    doc.text("La Direction", left + width * 0.6, y + 12, {
      width: width * 0.4,
    });
    doc
      .rect(left + width * 0.6, y + 26, width * 0.4, 56)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();

    // ─── Le tampon ────────────────────────────────────────────
    drawStamp(doc, y + 92);

    doc.end();
  });
}
