/**
 * La charte des documents imprimés.
 *
 * POURQUOI CE MODULE EXISTE
 * Les factures ont leur générateur PDF, la fiche d'inspection a sa page
 * imprimable, et trois nouveaux documents arrivent — devis, fiche d'entretien,
 * fiche de remplacement de pièces. Écrire quatre fois la même mise en page
 * garantit qu'elles divergent : le jour où l'adresse de l'entreprise change,
 * une seule des quatre la voit changer.
 *
 * Ce module ne porte donc que ce qui doit *se ressembler* : les mesures de page,
 * les encres, l'en-tête société lu dans l'environnement, la règle de séparation,
 * le tampon, et les deux conversions de texte sans lesquelles un document
 * français s'imprime mal. La composition propre à chaque document — où se
 * placent le client, les lignes, le total — reste dans son propre générateur.
 *
 * CE QUI N'EST PAS ICI, ET POURQUOI
 * Aucune fonction ne compose un document entier. Une « fonction de facture »
 * paramétrée par un titre produirait un document qui n'est bien aucun des
 * quatre.
 *
 * LA RÈGLE À NE PAS PERDRE
 * `printable()` n'est pas cosmétique. Voir son commentaire : sans elle, un
 * montant s'imprime « 18 /500 DZD ».
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type PDFKit from "pdfkit";

// ─── Mesures et encres ──────────────────────────────────────

/**
 * La marge, en points, sur les quatre côtés d'une page A4.
 *
 * 48 points valent environ 1,7 cm. C'est ce que la facture utilise depuis le
 * début, et les quatre documents la partagent pour qu'une pile de papiers sortis
 * de la même imprimante ne se décale pas d'un document à l'autre.
 */
export const PAGE_MARGIN = 48;

/** L'encre du texte courant. */
export const INK = "#111827";
/** L'encre des étiquettes, des mentions secondaires et des filets de tableau. */
export const MUTED = "#6b7280";
/** Le gris des traits de séparation. */
export const RULE = "#d1d5db";

// ─── Texte ──────────────────────────────────────────────────

/**
 * Ramène un texte à ce que les polices standard savent écrire.
 *
 * Les polices standard de pdfkit — Helvetica, Times, Courier — sont encodées en
 * `WinAnsiEncoding`, qui couvre le latin-1 et rien au-delà. Le français
 * typographique, lui, utilise des espaces que le latin-1 ignore :
 * `toLocaleString("fr-FR")` sépare les milliers par une espace fine insécable
 * (U+202F), un copier-coller depuis un traitement de texte en apporte d'autres,
 * et une date formatée peut en poser aussi. Mal encodées, ces espaces ressortent
 * en caractère parasite — le montant s'imprime « 18 /500 DZD ».
 *
 * Sur une facture, ce n'est pas une coquette : c'est un montant faux, et c'est
 * exactement ce qu'un lecteur ne pardonne pas.
 *
 * Elles sont remplacées par une espace insécable ordinaire (U+00A0), qui est
 * dans le latin-1 et garde l'office qu'on attend d'elle — ne pas séparer « 18 »
 * de « 500 » en fin de ligne. Le tiret insécable U+2011 devient un tiret
 * ordinaire, pour la même raison.
 *
 * Les caractères sont écrits en échappements explicites, et non en littéraux :
 * dans un éditeur, U+202F et une espace ordinaire se ressemblent, et une
 * « correction » qui remplacerait l'un par l'autre ne se verrait pas.
 */
export function printable(text: string): string {
  return text.replace(/[   ]/g, " ").replace(/‑/g, "-");
}

/** Une date lisible, en toutes lettres, indépendante de la locale du poste. */
export function frenchDate(date: Date): string {
  return date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

/** Une date et une heure, pour les documents qui horodatent une décision. */
export function frenchDateTime(date: Date): string {
  return date.toLocaleString("fr-FR", {
    dateStyle: "long",
    timeStyle: "short",
  });
}

// ─── Identité de l'entreprise ───────────────────────────────

/**
 * Le nom porté en tête des documents.
 *
 * Lu dans l'environnement avec « RMASC » pour seul défaut : c'est le seul nom
 * qu'on connaisse sans qu'on ait rien demandé à personne. Tout le reste s'imprime
 * s'il est renseigné et disparaît sinon — un document sans adresse est un
 * document incomplet, un document avec une adresse inventée est un faux.
 */
export function companyName(): string {
  return process.env.INVOICE_COMPANY_NAME ?? "RMASC";
}

/**
 * Les mentions de l'entreprise, dans l'ordre où elles s'impriment.
 *
 * Le préfixe des variables reste `INVOICE_` pour les documents qui ne sont pas
 * des factures, et c'est délibéré : ce sont les mêmes coordonnées, une seule
 * fois renseignées. Introduire un `DEVIS_COMPANY_NAME` aurait demandé de
 * re-saisir la même adresse dans un second fichier d'environnement, et la
 * première correction aurait été faite d'un seul côté.
 */
export function companyMentions(): string[] {
  return [
    process.env.INVOICE_COMPANY_ADDRESS,
    process.env.INVOICE_COMPANY_PHONE,
    process.env.INVOICE_COMPANY_EMAIL,
    process.env.INVOICE_COMPANY_TAX_ID,
  ]
    .filter((line): line is string => Boolean(line))
    .map(printable);
}

/** Le chemin du tampon, ou `null` s'il n'a pas été déposé. */
export function resolveStampPath(): string | null {
  const configured = process.env.INVOICE_STAMP_PATH;
  const candidate = configured
    ? path.resolve(configured)
    : path.join(process.cwd(), "public", "cachet.png");
  return existsSync(candidate) ? candidate : null;
}

// ─── Composition ────────────────────────────────────────────

/** Les deux bords utiles de la page, et la largeur entre eux. */
export function frame(doc: PDFKit.PDFDocument) {
  const left = PAGE_MARGIN;
  const right = doc.page.width - PAGE_MARGIN;
  return { left, right, width: right - left };
}

/**
 * La hauteur sous l'en-tête.
 *
 * L'en-tête est écrit en deux blocs qui se chevauchent verticalement — le nom à
 * gauche, le titre et la référence à droite — et la hauteur du plus grand n'est
 * pas connue à l'avance. pdfkit suit `doc.y` tout seul ; on repart donc de là,
 * avec un minimum, pour que le trait ne remonte jamais dans le titre quand la
 * raison sociale est courte.
 */
export function headerBaseline(doc: PDFKit.PDFDocument): number {
  return Math.max(doc.y, PAGE_MARGIN + 62) + 12;
}

/** Le trait de séparation sous l'en-tête, et sous les blocs. */
export function drawRule(
  doc: PDFKit.PDFDocument,
  y: number,
  lineWidth = 1
): void {
  const { left, right } = frame(doc);
  doc
    .moveTo(left, y)
    .lineTo(right, y)
    .strokeColor(RULE)
    .lineWidth(lineWidth)
    .stroke();
}

/** L'étiquette en petites capitales qui introduit une section. */
export function drawSectionTitle(
  doc: PDFKit.PDFDocument,
  text: string,
  y: number
): number {
  const { left, width } = frame(doc);
  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8);
  doc.text(printable(text).toUpperCase(), left, y, { width });
  return doc.y;
}

/**
 * Un couple « étiquette / valeur », sur une colonne.
 *
 * Renvoie la hauteur consommée pour que l'appelant place la ligne suivante sans
 * deviner : une valeur longue passe sur deux lignes, et un pas fixe les ferait
 * se chevaucher.
 */
export function drawField(
  doc: PDFKit.PDFDocument,
  options: {
    label: string;
    value: string;
    x: number;
    y: number;
    width: number;
  }
): number {
  const { label, value, x, y, width } = options;

  doc.fillColor(MUTED).font("Helvetica").fontSize(8);
  doc.text(printable(label).toUpperCase(), x, y, { width });

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(10);
  doc.text(printable(value), x, y + 11, { width });

  return doc.y - y;
}

export interface DocumentHeader {
  /** Le grand mot à droite, dans la langue du lecteur : « FACTURE », « DEVIS ». */
  title: string;
  /**
   * Les lignes alignées à droite sous le titre — référence, dates.
   *
   * Déjà mises en forme par l'appelant, et passées par `printable` ici : une
   * ligne de référence porte le plus souvent un numéro, mais aussi parfois une
   * date en toutes lettres, et l'échappement ne doit pas dépendre de ce que
   * l'appelant a pensé à faire.
   */
  lines: readonly string[];
}

/**
 * L'en-tête commun : l'entreprise à gauche, le document à droite.
 *
 * Renvoie la hauteur du trait de séparation, pour que l'appelant enchaîne sans
 * recalculer.
 */
export function drawDocumentHeader(
  doc: PDFKit.PDFDocument,
  header: DocumentHeader
): number {
  const { left, width } = frame(doc);

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(18);
  doc.text(printable(companyName()), left, PAGE_MARGIN);

  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  const mentions = companyMentions();
  if (mentions.length > 0) {
    doc.text(mentions.join("  ·  "), left, PAGE_MARGIN + 24, {
      width: width * 0.55,
    });
  }

  // Le bloc titre est aligné à droite, sur la même ligne de base que le nom. Il
  // porte la référence, qui est ce qu'on cherche en premier sur un document
  // classé.
  doc
    .fillColor(INK)
    .font("Helvetica-Bold")
    .fontSize(22)
    .text(printable(header.title), left, PAGE_MARGIN - 4, {
      width,
      align: "right",
    });

  doc.font("Helvetica").fontSize(10).fillColor(MUTED);
  for (const line of header.lines) {
    doc.text(printable(line), { width, align: "right" });
  }

  const baseline = headerBaseline(doc);
  drawRule(doc, baseline);
  return baseline;
}

/**
 * Le tampon de l'entreprise, s'il a été déposé.
 *
 * Sous le contenu et jamais par-dessus : un cachet qui recouvre un montant rend
 * le document illisible, ce qui est l'exact inverse de son objet. La borne basse
 * le garde dans la page quand le contenu est long — un cachet à moitié hors du
 * papier ne vaut pas mieux qu'un cachet absent.
 *
 * Un fichier illisible ne fait pas échouer le document : il s'imprime sans
 * tampon. Un document manquant serait pire que la découverte, dans les journaux,
 * d'un PNG que pdfkit n'a pas su lire.
 */
export function drawStamp(doc: PDFKit.PDFDocument, y: number): void {
  const stampPath = resolveStampPath();
  if (!stampPath) return;

  const { right } = frame(doc);
  const stampWidth = 110;
  const stampY = Math.min(doc.page.height - PAGE_MARGIN - stampWidth, y);

  try {
    doc.image(stampPath, right - stampWidth, stampY, { width: stampWidth });
  } catch {
    console.error(`[documents] tampon illisible : ${stampPath}`);
  }
}

// ─── Nom du fichier ─────────────────────────────────────────

/**
 * Le nom du fichier téléchargé, sûr.
 *
 * La référence est assainie parce qu'un en-tête HTTP se construit par
 * concaténation : un guillemet ou un retour à la ligne dans un numéro y
 * injecterait une directive. Le préfixe dit ce qu'est le document, pour qu'un
 * dossier de téléchargements ne contienne pas quatre fichiers qui commencent par
 * le même mot.
 */
export function documentFileName(prefix: string, reference: string): string {
  const cleaned = reference.replace(/[^A-Za-z0-9-]/g, "");
  return `${prefix}-${cleaned || "sans-reference"}.pdf`;
}
