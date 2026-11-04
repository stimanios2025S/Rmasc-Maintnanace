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

// ─── Identité complète (en-tête et pied de page) ────────────

/** Un identifiant légal imprimé sur le document. */
export interface CompanyLegalId {
  label: string;
  value: string;
}

/**
 * Le profil de l'entreprise, tel que l'en-tête et le pied de page le lisent.
 *
 * TOUT VIENT DE L'ENVIRONNEMENT, RIEN N'EST INVENTÉ
 * Un champ non renseigné disparaît de l'en-tête plutôt que d'imprimer un
 * « RC : — » qui laisserait croire à un document incomplet. C'est le même choix
 * que pour `companyMentions`, étendu aux identifiants légaux et aux coordonnées
 * bancaires.
 *
 * `INVOICE_COMPANY_TAX_ID` reste lu comme article d'imposition quand
 * `INVOICE_COMPANY_AI` n'est pas fourni : c'est le nom que ce champ portait
 * avant que le formulaire ne distingue RC, NIF, NIS et AI, et une entreprise qui
 * ne met à jour qu'une variable ne doit pas perdre son numéro fiscal.
 */
export interface CompanyProfile {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  legalIds: CompanyLegalId[];
  bank: string | null;
  rib: string | null;
  footerMentions: string[];
  /** Le logo vu du navigateur (`/brand/…`), ou `null` s'il n'est pas servi. */
  logoUrl: string | null;
}

function envText(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? printable(value) : null;
}

export function companyProfile(): CompanyProfile {
  const legalIds: CompanyLegalId[] = [];
  const addId = (label: string, value: string | null) => {
    if (value) legalIds.push({ label, value });
  };

  addId("RC", envText("INVOICE_COMPANY_RC"));
  addId("NIF", envText("INVOICE_COMPANY_NIF"));
  addId("NIS", envText("INVOICE_COMPANY_NIS"));
  addId(
    "AI",
    envText("INVOICE_COMPANY_AI") ?? envText("INVOICE_COMPANY_TAX_ID")
  );

  return {
    name: printable(companyName()),
    address: envText("INVOICE_COMPANY_ADDRESS"),
    phone: envText("INVOICE_COMPANY_PHONE"),
    email: envText("INVOICE_COMPANY_EMAIL"),
    legalIds,
    bank: envText("INVOICE_COMPANY_BANK"),
    rib: envText("INVOICE_COMPANY_RIB"),
    footerMentions: companyFooterMentions(),
    logoUrl: logoPublicUrl(),
  };
}

/**
 * Les mentions de pied de page, une par entrée.
 *
 * Une seule variable, découpée sur `|` : un fichier d'environnement n'a pas de
 * tableau, et multiplier les variables numérotées (`_1`, `_2`) revient à
 * oublier la troisième.
 */
export function companyFooterMentions(): string[] {
  const raw = process.env.INVOICE_COMPANY_MENTIONS;
  if (!raw) return [];
  return raw
    .split("|")
    .map((line) => printable(line.trim()))
    .filter(Boolean);
}

/**
 * Le logo, côté système de fichiers, pour le PDF.
 *
 * `INVOICE_LOGO_PATH` accepte deux formes : un chemin public (`/brand/x.png`,
 * résolu sous `public/`) ou un chemin absolu. Le défaut est le fichier déposé
 * avec le produit ; s'il n'existe pas, le document s'imprime sans logo plutôt
 * que d'échouer.
 */
export function resolveLogoPath(): string | null {
  const configured = process.env.INVOICE_LOGO_PATH?.trim();
  const candidate = configured
    ? configured.startsWith("/")
      ? path.join(process.cwd(), "public", configured.replace(/^\/+/, ""))
      : path.resolve(configured)
    : path.join(process.cwd(), "public", "brand", "rmasc-logo.png");

  return existsSync(candidate) ? candidate : null;
}

/** Le logo vu du navigateur — `null` si le chemin configuré n'est pas public. */
function logoPublicUrl(): string | null {
  const configured = process.env.INVOICE_LOGO_PATH?.trim();
  if (!configured) return "/brand/rmasc-logo.png";
  return configured.startsWith("/") ? configured : null;
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
  const profile = companyProfile();

  /**
   * Le logo décale le bloc société vers la droite.
   *
   * Sa hauteur n'est pas supposée carrée : elle est lue dans l'image, sinon un
   * logo horizontal ferait remonter le trait de séparation dans le texte. Un
   * fichier illisible laisse simplement l'en-tête sans logo — un document qui
   * refuse de s'imprimer pour une image manquante serait pire que le document
   * sans image.
   */
  let textLeft = left;
  let logoBottom = PAGE_MARGIN;

  const logoPath = resolveLogoPath();
  if (logoPath) {
    const logoWidth = 74;
    try {
      /**
       * `openImage` existe à l'exécution mais n'est pas déclaré par les types
       * de pdfkit : on lit les dimensions réelles pour ne pas supposer un logo
       * carré.
       */
      const image = (
        doc as unknown as {
          openImage(path: string): { width: number; height: number };
        }
      ).openImage(logoPath);
      const logoHeight = (image.height / image.width) * logoWidth;
      doc.image(logoPath, left, PAGE_MARGIN - 4, { width: logoWidth });
      textLeft = left + logoWidth + 14;
      logoBottom = PAGE_MARGIN - 4 + logoHeight;
    } catch {
      console.error(`[documents] logo illisible : ${logoPath}`);
    }
  }

  const textWidth = Math.max(150, width * 0.6 - (textLeft - left));

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(16);
  doc.text(printable(profile.name), textLeft, PAGE_MARGIN, { width: textWidth });

  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED);
  const contact = [profile.address, profile.phone, profile.email]
    .filter((line): line is string => Boolean(line))
    .join("  ·  ");
  if (contact) {
    doc.text(contact, textLeft, PAGE_MARGIN + 21, { width: textWidth });
  }

  const legal = profile.legalIds
    .map((id) => `${id.label} : ${id.value}`)
    .join("  ·  ");
  if (legal) {
    doc.text(legal, textLeft, PAGE_MARGIN + 33, { width: textWidth });
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

  const baseline = Math.max(headerBaseline(doc), logoBottom + 8);
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

/**
 * Le même tampon, à une position imposée.
 *
 * La facture réserve un cadre « Cachet et signature » à gauche et y pose le
 * tampon ; `drawStamp`, qui colle à droite, recouvrirait les conditions de
 * règlement. Un fichier illisible laisse le cadre vide, jamais un document en
 * échec.
 */
export function drawStampIn(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  stampWidth: number
): void {
  const stampPath = resolveStampPath();
  if (!stampPath) return;

  try {
    doc.image(stampPath, x, y, { width: stampWidth });
  } catch {
    console.error(`[documents] tampon illisible : ${stampPath}`);
  }
}

// ─── Pied de page ───────────────────────────────────────────

/**
 * Le pied de page commun : coordonnées bancaires, mentions, pagination.
 *
 * APPELÉ APRÈS LE CONTENU, PAGE PAR PAGE
 * Le générateur garde les pages en mémoire (`bufferPages: true`) et revient sur
 * chacune pour écrire ce bloc. C'est le seul moyen d'avoir un pied de page sur
 * la première *et* sur la dernière quand le tableau déborde : l'écrire au fil
 * de l'eau laisserait la page finale sans mentions.
 *
 * Il se place sous la zone de contenu (`height - PAGE_MARGIN`), dans la marge
 * basse, donc jamais par-dessus une ligne du tableau.
 */
export function drawDocumentFooter(
  doc: PDFKit.PDFDocument,
  pageNumber: number,
  pageCount: number
): void {
  const profile = companyProfile();
  const { left, right } = frame(doc);
  const y = doc.page.height - 34;

  /**
   * Le pied de page s'écrit dans la marge basse, sous la zone de contenu.
   *
   * pdfkit pagine tout seul dès qu'un texte dépasse la marge inférieure : sans
   * cette neutralisation, écrire les mentions à `height - 17` ajoutait une page
   * blanche à la fin de chaque facture. On annule la marge le temps du bloc, et
   * on la rétablit — le document suivant sur le même `doc` en dépend.
   */
  const bottomMargin = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;

  doc
    .moveTo(left, y)
    .lineTo(right, y)
    .strokeColor(RULE)
    .lineWidth(0.5)
    .stroke();

  doc.fillColor(MUTED).font("Helvetica").fontSize(7);

  const bank = [
    profile.bank ? `Banque : ${profile.bank}` : null,
    profile.rib ? `RIB : ${profile.rib}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("  ·  ");

  if (bank) {
    doc.text(printable(bank), left, y + 6, { width: (right - left) * 0.75 });
  }
  doc.text(`Page ${pageNumber}/${pageCount}`, left, y + 6, {
    width: right - left,
    align: "right",
  });

  const mentions = profile.footerMentions.join("  ·  ");
  if (mentions) {
    doc.fontSize(6.5).text(printable(mentions), left, y + 17, {
      width: right - left,
    });
  }

  doc.page.margins.bottom = bottomMargin;
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
