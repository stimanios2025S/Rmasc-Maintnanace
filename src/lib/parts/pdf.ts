/**
 * La fiche de remplacement de pièces, en PDF.
 *
 * CE QUE CE DOCUMENT EST, ET CE QU'IL N'EST PAS
 * C'est une fiche de travail interne : elle part avec la pièce, elle est lue par
 * celui qui commande et par celui qui monte. Elle ne porte aucun montant et
 * n'engage rien financièrement — ce qui engage, c'est la facture, et elle est
 * ailleurs. Le document est là pour qu'une commande de pièce ne repose pas sur
 * un message verbal.
 *
 * POURQUOI IL IMPRIME LES DEUX DÉCISIONS
 * « Demandée le … par … » puis « Validée le … par … » : le bureau qui reçoit
 * cette fiche au fond d'un carton doit pouvoir répondre à la seule question
 * qu'on lui posera — qui a autorisé cette dépense, et quand. Une fiche qui
 * n'imprimerait que l'état courant perdrait la première des deux.
 *
 * LA CHARTE EST CELLE DES FACTURES
 * Mesures, encres, en-tête société, tampon et échappement des caractères
 * viennent de `lib/documents/charte.ts` : c'est ce qui garantit qu'une pile de
 * papiers sortis de la même imprimante ne se décale pas d'un document à l'autre.
 * La composition, elle, est propre à cette fiche.
 *
 * Module serveur : il lit le disque pour le tampon. Rien de ce qui est ici ne
 * doit atteindre un bundle navigateur.
 */

import PDFDocument from "pdfkit";
import {
  INK,
  MUTED,
  PAGE_MARGIN,
  companyName,
  documentFileName,
  drawDocumentHeader,
  drawField,
  drawRule,
  drawSectionTitle,
  drawStamp,
  frame,
  frenchDateTime,
  printable,
} from "@/lib/documents/charte";
import { partUrgencyLabel, enumLabel } from "@/lib/ui/enum-labels";

/**
 * Tout ce que la fiche imprime.
 *
 * Une forme décrite à la main plutôt que la ligne Prisma : la route fait la
 * jointure, ce module ne connaît pas la base, et une seconde fiche — un jour,
 * pour un autre besoin — pourra réutiliser le rendu sans hériter du schéma.
 */
export interface PartSheetDocument {
  number: string;
  status: string;
  urgency: string;
  requestedAt: Date;
  quantity: number;

  faultyPartName: string;
  faultyPartReference: string | null;
  replacementPartName: string;
  replacementPartReference: string | null;
  notes: string | null;

  requestedByName: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  fulfilledAt: Date | null;

  orderNumber: string;
  orderTitle: string;
  elevatorCode: string;
  elevatorBrand: string | null;
  elevatorModel: string | null;
  buildingName: string;
  buildingAddress: string;
  buildingCity: string;
}

/** Le nom du fichier, pour la route qui le sert. */
export function partSheetFileName(reference: string): string {
  return documentFileName("Fiche-piece", reference);
}

/**
 * Le bandeau d'urgence, ou `null` pour une demande ordinaire.
 *
 * Il n'est rendu que sur une urgence immédiate. Une pièce qui immobilise un
 * appareil doit se voir avant qu'on lise la fiche, et une fiche sur cinq qui
 * porte un bandeau attire l'œil ; cinq fiches sur cinq qui en portent un
 * n'attirent plus rien.
 *
 * Le vocabulaire est celui du métier : « arrêt immédiat » dit à celui qui tient
 * la fiche qu'un ascenseur est à l'arrêt, ce qu'un mot comme « urgent » ne dit
 * pas.
 */
function urgencyBand(urgency: string): {
  label: string;
  fill: string;
  ink: string;
} | null {
  if (urgency !== "IMMEDIATE") return null;
  return {
    label: printable(
      "ARRÊT IMMÉDIAT — appareil immobilisé, remplacement à traiter sans attendre"
    ),
    fill: "#fee2e2",
    ink: "#991b1b",
  };
}

export function renderPartRequirementPdf(
  sheet: PartSheetDocument
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: PAGE_MARGIN,
      info: {
        Title: `Fiche de remplacement ${sheet.number}`,
        Author: companyName(),
        Subject: `Bon de travail ${sheet.orderNumber}`,
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const { left, right, width } = frame(doc);
    const columnWidth = (width - 24) / 2;

    // ─── En-tête ──────────────────────────────────────────────
    let y = drawDocumentHeader(doc, {
      title: "FICHE DE REMPLACEMENT",
      lines: [
        sheet.number,
        `Demandée le ${frenchDateTime(sheet.requestedAt)}`,
      ],
    });
    y += 18;

    // ─── Urgence ──────────────────────────────────────────────
    const band = urgencyBand(sheet.urgency);
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

    // ─── Où, et sur quoi ──────────────────────────────────────
    drawSectionTitle(doc, "Appareil et intervention", y);
    y += 14;

    const identity = [
      sheet.elevatorBrand && sheet.elevatorModel
        ? `${sheet.elevatorBrand} ${sheet.elevatorModel}`
        : null,
    ].filter((line): line is string => Boolean(line));

    const deviceHeight = Math.max(
      drawField(doc, {
        label: "Immeuble",
        value: sheet.buildingName,
        x: left,
        y,
        width: columnWidth,
      }),
      drawField(doc, {
        label: "Appareil",
        value: sheet.elevatorCode,
        x: left + columnWidth + 24,
        y,
        width: columnWidth,
      })
    );
    y += deviceHeight + 10;

    const siteHeight = Math.max(
      drawField(doc, {
        label: "Adresse",
        value: [sheet.buildingAddress, sheet.buildingCity]
          .filter(Boolean)
          .join(", "),
        x: left,
        y,
        width: columnWidth,
      }),
      drawField(doc, {
        label: "Marque et modèle",
        value: identity.join(" ") || "Non renseigné",
        x: left + columnWidth + 24,
        y,
        width: columnWidth,
      })
    );
    y += siteHeight + 10;

    y += drawField(doc, {
      label: "Bon de travail",
      value: `${sheet.orderNumber} — ${sheet.orderTitle}`,
      x: left,
      y,
      width,
    });
    y += 16;

    drawRule(doc, y, 0.5);
    y += 16;

    // ─── Les deux pièces ──────────────────────────────────────
    //
    // Côte à côte, et non l'une sous l'autre : c'est la comparaison qui porte
    // l'information. Celui qui commande lit la seconde colonne après la
    // première, et voit d'un coup d'œil si la référence demandée correspond
    // bien à ce qui est tombé en panne.
    drawSectionTitle(doc, "Pièce défectueuse", y);
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8);
    doc.text("PIÈCE DE RECHANGE REQUISE", left + columnWidth + 24, y, {
      width: columnWidth,
    });
    y += 14;

    const faultyHeight = drawField(doc, {
      label: "Désignation",
      value: sheet.faultyPartName,
      x: left,
      y,
      width: columnWidth,
    });
    const replacementHeight = drawField(doc, {
      label: "Désignation",
      value: sheet.replacementPartName,
      x: left + columnWidth + 24,
      y,
      width: columnWidth,
    });
    y += Math.max(faultyHeight, replacementHeight) + 10;

    const refHeight = Math.max(
      drawField(doc, {
        label: "Référence",
        value: sheet.faultyPartReference ?? "Non renseignée",
        x: left,
        y,
        width: columnWidth,
      }),
      drawField(doc, {
        label: "Référence",
        value: sheet.replacementPartReference ?? "Non renseignée",
        x: left + columnWidth + 24,
        y,
        width: columnWidth,
      })
    );
    y += refHeight + 10;

    y += drawField(doc, {
      label: "Quantité demandée",
      value: String(sheet.quantity),
      x: left,
      y,
      width: columnWidth,
    });
    y += 16;

    // ─── Observations ─────────────────────────────────────────
    drawSectionTitle(doc, "Observations du technicien", y);
    y += 13;
    doc.fillColor(INK).font("Helvetica").fontSize(10);
    doc.text(
      sheet.notes?.trim() ? printable(sheet.notes.trim()) : "Non renseignées.",
      left,
      y,
      { width, lineGap: 2 }
    );
    y = doc.y + 20;

    // ─── Suivi ────────────────────────────────────────────────
    drawRule(doc, y, 0.5);
    y += 16;

    drawSectionTitle(doc, "Suivi de la demande", y);
    y += 14;

    const tracking: { label: string; value: string }[] = [
      {
        label: "Demandée par",
        value: sheet.requestedByName ?? "Compte supprimé",
      },
      {
        label: "Décision du bureau",
        value:
          sheet.decidedAt && sheet.status !== "PENDING"
            ? `${enumLabel(sheet.status)} le ${frenchDateTime(sheet.decidedAt)}` +
              (sheet.decidedByName ? ` par ${sheet.decidedByName}` : "")
            : "En attente de décision",
      },
    ];
    if (sheet.fulfilledAt) {
      tracking.push({
        label: "Pièce posée",
        value: frenchDateTime(sheet.fulfilledAt),
      });
    }

    const trackingWidth = (width - 24) / 2;
    for (let index = 0; index < tracking.length; index += 2) {
      const pair = tracking.slice(index, index + 2);
      const heights = pair.map((entry, column) =>
        drawField(doc, {
          label: entry.label,
          value: entry.value,
          x: left + column * (trackingWidth + 24),
          y,
          width: trackingWidth,
        })
      );
      y += Math.max(...heights) + 10;
    }

    // ─── Pied ─────────────────────────────────────────────────
    y += 8;
    drawRule(doc, y, 0.5);
    doc.fillColor(MUTED).font("Helvetica").fontSize(8);
    doc.text(
      printable(
        `${companyName()} · Fiche interne de demande de pièce. Ce document ` +
          "accompagne une commande ; il ne vaut ni devis, ni facture, ni " +
          "autorisation de dépense au-delà de la pièce décrite ci-dessus."
      ),
      left,
      y + 8,
      { width }
    );

    drawStamp(doc, y + 40);

    doc.end();
  });
}
