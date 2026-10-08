/**
 * Les registres, en CSV.
 *
 * POURQUOI UN MODULE, ET PAS UN `join(";")` DANS CHAQUE ROUTE
 * Un export est lu par un comptable, pas par un développeur : il s'ouvre dans
 * Excel et sert à recouper des totaux. Trois choses y sont donc non négociables
 * et faciles à rater une par une :
 *
 *  1. **Le séparateur et l'encodage.** Excel en configuration française lit un
 *     CSV séparé par des points-virgules et attend un BOM UTF-8 pour ne pas
 *     afficher « RÃ©glÃ©e ». Un export en virgules sans BOM ouvre ses colonnes
 *     dans une seule et massacre les accents — et le premier réflexe est alors
 *     de re-saisir les données à la main.
 *
 *  2. **L'échappement.** Un nom de client contient un point-virgule, une raison
 *     sociale contient un guillemet, une adresse contient un retour à la ligne.
 *     Sans échappement, ces trois cas décalent toutes les colonnes suivantes
 *     sans que rien ne le signale.
 *
 *  3. **L'injection de formules.** Voir `csvCell` : c'est le point qu'on oublie,
 *     parce qu'il ne se voit pas dans le fichier — il se voit dans Excel.
 *
 * Le module n'a aucune dépendance et ne connaît rien des factures ni des
 * rapports : les routes lui donnent des colonnes, il rend du texte.
 */

import { NextResponse } from "next/server";

/**
 * Une colonne d'export : son en-tête, et comment lire la valeur sur une ligne.
 *
 * `null` et `undefined` veulent dire « rien à écrire », et deviennent une case
 * vide — jamais « null » ni « undefined », qui sont des mots que personne n'a
 * saisis et qu'un lecteur prendrait pour une valeur.
 */
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

/** Le séparateur, et pourquoi ce n'est pas la virgule. */
export const CSV_DELIMITER = ";";

/**
 * Un nombre écrit tel quel, `null` s'il n'en est pas un.
 *
 * Sert à deux choses : décider si une valeur peut être échappée sans risque, et
 * rendre les montants qu'Excel pourra additionner. Un montant écrit « 18 500 »
 * avec une espace insécable est du texte pour Excel : `SOMME` rend zéro, et le
 * comptable croit à un bug de l'application.
 */
function asPlainNumber(value: string | number): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  return /^-?\d+(\.\d+)?$/.test(value.trim()) ? value.trim() : null;
}

/**
 * Une case, échappée.
 *
 * L'INJECTION DE FORMULES
 * Excel et LibreOffice exécutent ce qui commence par `=`, `+`, `-` ou `@`. Ces
 * registres contiennent des chaînes que nous n'avons pas écrites — un nom de
 * client, une adresse, un titre de bon — donc une cellule peut commencer par
 * `=`. Une cellule `=HYPERLINK(...)` ou une formule DDE ne s'exécute pas dans
 * le fichier : elle s'exécute chez la personne qui l'ouvre, sur son poste.
 *
 * La parade est le préfixe `'`, qui force Excel à lire la case comme du texte.
 *
 * ELLE NE S'APPLIQUE PAS AUX NOMBRES, ET C'EST LE POINT DÉLICAT
 * Une des valeurs dangereuses est `-`, qu'un montant négatif commence par
 * nature. Préfixer un nombre le transformerait en texte : le total ne
 * s'additionnerait plus, pour protéger d'une formule qui ne peut pas exister
 * dans une case qui n'est qu'un nombre. Une case qui se lit comme un nombre
 * exact est donc laissée intacte ; tout le reste passe par la règle.
 *
 * Le point-virgule, le guillemet, le retour à la ligne et le retour chariot
 * imposent les guillemets doublés — sans quoi la case se termine au milieu
 * d'elle-même et décale toutes les colonnes suivantes.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";

  // Un nombre non fini n'a rien à écrire : « NaN » dans une colonne de montants
  // se lit comme une valeur, et fausse un total sans rien casser.
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }

  if (asPlainNumber(value) !== null) return value.trim();

  let text = value;

  // `\t` et `\r` mènent aussi à une formule dans certaines versions d'Excel, et
  // ne peuvent pas se trouver en tête d'une valeur légitime de ces registres.
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }

  if (
    text.includes(CSV_DELIMITER) ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r")
  ) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

/**
 * Le document complet, BOM compris.
 *
 * Le BOM est écrit ici et non par la route : c'est l'encodage du fichier, pas
 * une décision de transport, et l'oublier dans une seule des deux routes
 * donnerait deux exports qui ne s'ouvrent pas de la même façon.
 *
 * Les lignes sont séparées par `\r\n`. Excel le tolère mal, mais c'est ce que
 * dit la RFC 4180, et tout ce qui lit du CSV correctement le gère.
 */
export function toCsv<T>(
  columns: readonly CsvColumn<T>[],
  rows: readonly T[]
): string {
  const header = columns.map((column) => csvCell(column.header)).join(CSV_DELIMITER);
  const lines = rows.map((row) =>
    columns.map((column) => csvCell(column.value(row))).join(CSV_DELIMITER)
  );
  return `﻿${[header, ...lines].join("\r\n")}\r\n`;
}

/**
 * Le nom du fichier, sûr, et daté.
 *
 * Daté parce qu'un registre s'exporte plusieurs fois : « registre-factures.csv »
 * téléchargé en mars et en juin produit deux fichiers que le navigateur numérote
 * `(1)` et `(2)`, et personne ne sait plus lequel est lequel trois semaines plus
 * tard. La date du jour les sépare.
 *
 * Le préfixe est nettoyé comme un numéro de facture l'est dans la route du PDF :
 * un en-tête HTTP se construit par concaténation, et un guillemet ou un retour
 * à la ligne y injecterait une directive.
 */
export function csvFileName(prefix: string, at: Date = new Date()): string {
  const safe = prefix.replace(/[^A-Za-z0-9-]/g, "-").replace(/-+/g, "-");
  const stamp = at.toISOString().slice(0, 10);
  return `${safe || "registre"}-${stamp}.csv`;
}

/**
 * Une date, telle qu'un tableur la relit sans se tromper de mois.
 *
 * `AAAA-MM-JJ HH:MM`, et non `08/10/2026`. L'ordre jour/mois n'est pas
 * universel : Excel en configuration américaine lit `08/10/2026` comme le
 * 10 août, et une date fausse dans un registre de conformité est pire qu'une
 * date illisible. La forme ISO est comprise des deux côtés, et se trie
 * correctement même quand le tableur la garde en texte.
 *
 * L'heure est incluse : deux rapports du même jour ne se départagent pas
 * autrement, et un registre trié doit être stable.
 */
export function csvDateTime(date: Date | null | undefined): string {
  if (!date || Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * La réponse HTTP d'un export.
 *
 * `no-store`, comme le PDF d'une facture : un registre porte des noms de
 * clients, des adresses et des montants, et n'a rien à faire dans le cache
 * partagé d'un poste de bureau ou d'un proxy d'entreprise.
 */
export function csvResponse(filename: string, body: string): NextResponse {
  // `Buffer.byteLength` et non `body.length` : le BOM et les accents comptent
  // plusieurs octets, et un `Content-Length` en dessous tronque le fichier.
  const bytes = Buffer.byteLength(body, "utf8");

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(bytes),
      "Cache-Control": "private, no-store",
    },
  });
}

/**
 * Le plafond d'un export, et le refus qui va avec.
 *
 * Un export n'est pas paginé — c'est même son intérêt : il rend *tout* ce que
 * le filtre décrit, et non les cinquante premières lignes. Il lui faut donc une
 * borne, sans quoi un registre de dix ans tient en mémoire avant d'être écrit.
 *
 * La borne est franchie très rarement, et quand elle l'est, la route **refuse**
 * au lieu de couper. Un fichier tronqué en silence est le pire des deux : il a
 * l'air complet, il porte un en-tête et un total, et le comptable qui recoupe
 * avec lui cherche l'écart pendant une heure. Un refus qui demande de resserrer
 * la période est désagréable et honnête.
 */
export const MAX_EXPORT_ROWS = 10_000;
