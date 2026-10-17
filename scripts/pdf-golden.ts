/**
 * Empreinte de référence des PDF de facture.
 *
 *   npx tsx scripts/pdf-golden.ts <dossier-de-sortie>
 *
 * POURQUOI CE SCRIPT EXISTE
 * Une facture est un document opposable : celle que le client a reçue doit
 * pouvoir être reproduite à l'identique des années plus tard. Raccorder le
 * générateur à `charte.ts` déplace du code de mise en page ; le seul moyen de
 * savoir que rien n'a bougé est de comparer la sortie avant et après, octet par
 * octet.
 *
 * Ce script produit N variantes, écrit les PDF et imprime deux empreintes par
 * fichier :
 *
 *   - `fichier`  le SHA-256 du binaire complet ;
 *   - `contenu`  le SHA-256 des flux de contenu **décompressés**.
 *
 * LA SECONDE EST CELLE QUI COMPTE
 * PDFKit inscrit dans le document la date de création, qui change à chaque
 * rendu. Deux exécutions du MÊME code peuvent donc différer de quelques octets
 * sans qu'une seule instruction de dessin ait changé. L'empreinte du fichier
 * détecte tout ; celle du contenu dit si un pixel a bougé. Comparer la première
 * avant/après, et exiger l'égalité de la seconde.
 *
 * DÉTERMINISME DE L'ENVIRONNEMENT
 * Les mentions société et le tampon sont imposés ici plutôt que lus du `.env` de
 * la machine : une empreinte de référence qui dépend de l'environnement de celui
 * qui la produit ne compare rien.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";

import { Prisma } from "@prisma/client";
import type { Invoice } from "@prisma/client";

import { renderInvoicePdf } from "../src/lib/invoices/pdf";

// ─── Environnement figé ────────────────────────────────────

process.env.INVOICE_COMPANY_NAME = "RMASC";
process.env.INVOICE_COMPANY_ADDRESS = "12 rue des Ascenseurs, 16000 Alger";
process.env.INVOICE_COMPANY_PHONE = "+213 21 00 00 00";
process.env.INVOICE_COMPANY_EMAIL = "facturation@sarl-rmasc.com";
process.env.INVOICE_COMPANY_TAX_ID = "NIF 123456789012345";
/**
 * Un chemin qui n'existe pas : le document s'imprime sans tampon. Sans cela, la
 * présence accidentelle d'un `public/cachet.png` sur la machine changerait
 * l'empreinte et ferait croire à une régression.
 */
process.env.INVOICE_STAMP_PATH = "/nonexistent/cachet.png";

// ─── Fixtures ──────────────────────────────────────────────

const BASE: Invoice = {
  id: "inv_fixture",
  number: "FA-2026-0042",
  year: 2026,
  sequence: 42,
  workOrderId: "wo_fixture",
  clientId: "usr_owner",
  issuedById: "usr_admin",
  issuedAt: new Date("2026-01-15T09:00:00Z"),
  createdAt: new Date("2026-01-15T09:00:00Z"),
  clientName: "Rachid Zerrouki",
  clientAddress: "18 boulevard Mohamed V, Alger Centre",
  clientEmail: "owner@metroplaza.com",
  clientPhone: "+213 21 00 00 05",
  buildingName: "Immeuble Le Panorama",
  buildingAddress: "24 rue Didouche Mourad",
  buildingCity: "Alger",
  elevatorCode: "ASC-A-01",
  orderNumber: "BT-2026-0117",
  orderTitle: "Remplacement de la carte de commande",
  orderType: "CORRECTIVE",
  completedAt: new Date("2026-01-14T17:30:00Z"),
  reportNotes:
    "Carte de commande remplacée après diagnostic. Freins vérifiés, " +
    "nivellement contrôlé, essai du téléphone d'urgence concluant.",
  partsReplaced: [
    { name: "Carte de commande", partNumber: "REF-CMD-2200", qty: 1 },
    { name: "Patins de guidage (PTFE)", partNumber: "REF-PTG-0450", qty: 4 },
  ],
  amount: new Prisma.Decimal("185000.00"),
  currency: "DZD",
  status: "ISSUED",
  statusChangedAt: null,
  statusChangedById: null,
};

type Variant = { slug: string; invoice: Invoice };

const VARIANTS: Variant[] = [
  { slug: "01-issued", invoice: BASE },
  {
    slug: "02-issued-sans-pieces",
    invoice: { ...BASE, partsReplaced: [] },
  },
  {
    slug: "03-paye",
    invoice: {
      ...BASE,
      status: "PAID",
      statusChangedAt: new Date("2026-02-03T11:20:00Z"),
    },
  },
  {
    slug: "04-annulee",
    invoice: {
      ...BASE,
      status: "CANCELLED",
      statusChangedAt: new Date("2026-02-04T08:05:00Z"),
    },
  },
  {
    slug: "05-client-sans-coordonnees",
    invoice: {
      ...BASE,
      clientAddress: null,
      clientEmail: null,
      clientPhone: null,
      completedAt: null,
    },
  },
  {
    slug: "06-textes-longs",
    invoice: {
      ...BASE,
      clientName: "Société Immobilière El Bahia — Direction Générale",
      clientAddress:
        "Immeuble Les Oliviers, 4e étage, bureau 12, zone d'activité, " +
        "route nationale 5, 31000 Oran, Algérie",
      buildingAddress:
        "Complexe d'affaires Les Oliviers, tour B, 18 avenue de la " +
        "République, quartier des affaires",
      buildingCity: "Oran",
      orderTitle:
        "Intervention lourde : remplacement de l'ensemble du tableau de " +
        "commande, remise en état du circuit de freinage et contrôle " +
        "réglementaire complet de l'appareil",
      reportNotes:
        "Intervention en deux temps. Première visite : diagnostic complet " +
        "de l'armoire, relevé des tensions, contrôle des contacts. " +
        "Deuxième visite : remplacement de la carte, reprise du câblage, " +
        "essais de charge et de nivellement. Le client a demandé un " +
        "attestation de conformité, remise en main propre au gardien.",
      partsReplaced: Array.from({ length: 9 }, (_, i) => ({
        name: `Pièce de remplacement numéro ${i + 1} — désignation longue`,
        partNumber: `REF-${String(1000 + i)}`,
        qty: i + 1,
      })),
    },
  },
  {
    slug: "07-devise-etrangere",
    invoice: {
      ...BASE,
      currency: "EUR",
      amount: new Prisma.Decimal("1250.75"),
    },
  },
];

// ─── Empreintes ────────────────────────────────────────────

function sha256(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Le contenu des flux décompressés.
 *
 * Un PDF pdfkit place les instructions de dessin dans des flux FlateDecode. Les
 * décompresser et les concaténer donne exactement ce que le moteur de rendu
 * exécutera, sans les dates de métadonnées ni l'ordre des objets.
 */
function contentDigest(pdf: Buffer): { digest: string; streams: number } {
  const parts: Buffer[] = [];
  const marker = Buffer.from("stream");
  const endMarker = Buffer.from("endstream");
  let from = 0;
  let streams = 0;

  for (;;) {
    const start = pdf.indexOf(marker, from);
    if (start === -1) break;
    const end = pdf.indexOf(endMarker, start);
    if (end === -1) break;

    // Les sauts de ligne qui suivent « stream » ne font pas partie des données.
    let dataStart = start + marker.length;
    if (pdf[dataStart] === 0x0d) dataStart += 1;
    if (pdf[dataStart] === 0x0a) dataStart += 1;

    const raw = pdf.subarray(dataStart, end);
    try {
      parts.push(inflateSync(raw));
      streams += 1;
    } catch {
      // Un flux non compressé ou non textuel — ignoré.
    }
    from = end + endMarker.length;
  }

  return { digest: sha256(Buffer.concat(parts)), streams };
}

// ─── Exécution ─────────────────────────────────────────────

async function main() {
  const outputDir = process.argv[2] ?? path.join(process.cwd(), ".pdf-golden");
  mkdirSync(outputDir, { recursive: true });

  const report: string[] = [];
  report.push(`# Empreintes PDF de facture`);
  report.push(`# fichier | contenu | flux | nom`);

  for (const variant of VARIANTS) {
    const pdf = await renderInvoicePdf(variant.invoice);
    const file = path.join(outputDir, `${variant.slug}.pdf`);
    writeFileSync(file, pdf);

    const content = contentDigest(pdf);

    report.push(
      [
        sha256(pdf).slice(0, 16),
        content.digest.slice(0, 16),
        String(content.streams).padStart(3),
        variant.slug,
      ].join(" | ")
    );
  }

  /**
   * L'empreinte combinée : un seul nombre à comparer avant et après. Elle porte
   * sur le contenu de chaque variante, dans l'ordre, donc une régression dans
   * une seule d'entre elles la change.
   */
  report.push("");
  report.push(`variantes      : ${VARIANTS.length}`);
  report.push(`sortie         : ${outputDir}`);

  console.log(report.join("\n"));

  // Recalculée sur les octets des fichiers réellement écrits, et non sur les
  // valeurs en mémoire : c'est la sortie du disque qui fait foi.
  const { readFileSync } = await import("node:fs");
  const combinedReal = sha256(
    VARIANTS.map((v) =>
      contentDigest(readFileSync(path.join(outputDir, `${v.slug}.pdf`))).digest
    ).join("")
  );
  console.log(`EMPREINTE_CONTENU_COMBINEE=${combinedReal}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
