/**
 * Ce que les deux registres ont en commun : lire une période et une recherche.
 *
 * POURQUOI CE FICHIER EXISTE
 * Le registre des rapports et celui des factures posent la même question —
 * « qu'est-ce qui s'est passé entre telle date et telle date ? » — sur deux
 * tables différentes. La lecture des bornes de date est écrite une fois ici, et
 * non dans chaque route, parce qu'elle porte la seule erreur possible sur ce
 * sujet : le décalage d'un jour, qui ne se voit qu'à la fin du mois quand un
 * total ne tombe pas juste.
 *
 * LA BORNE HAUTE EST EXCLUSIVE, ET C'EST DÉLIBÉRÉ
 * Un `<input type="date">` rend un jour, pas un instant. « Jusqu'au 8 octobre »
 * veut dire *toute* la journée du 8, y compris la facture émise à 17 h 40. La
 * route ne peut donc pas filtrer `<= 8 octobre 00:00` : elle filtrerait
 * jusqu'au 7 au soir. La borne est convertie en « début du 9 », exclu, ce qui
 * inclut le 8 en entier sans avoir à écrire une seconde de fin — et une seconde
 * de fin est justement ce qu'on écrit mal.
 *
 * LES DATES SONT LOCALES
 * Comme `fromDateInput` dans `lib/maintenance/schedule.ts`, et pour la même
 * raison : `new Date("2026-10-08")` est minuit UTC, ce qui devient le 7 octobre
 * pour tout utilisateur à l'ouest de Greenwich. Construire la date avec ses
 * composants laisse le navigateur et le serveur d'accord sur le jour dont ils
 * parlent.
 */

import { badRequest } from "@/lib/api/http";

/** Les bornes d'une période. `null` veut dire « pas de borne de ce côté ». */
export interface Period {
  /** Début du jour local demandé, inclus. */
  from: Date | null;
  /** Début du jour *suivant* la borne haute, exclu. Voir l'en-tête. */
  toExclusive: Date | null;
}

/** `yyyy-mm-dd` au jour local, à l'heure donnée. `null` si le format diffère. */
function localDay(value: string, hour: number): Date | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!parts) return null;

  const date = new Date(
    Number(parts[1]),
    Number(parts[2]) - 1,
    Number(parts[3]),
    hour,
    0,
    0,
    0
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Lit `?from=` et `?to=`.
 *
 * Une valeur illisible est refusée et non ignorée : `?from=2026-13-45` qui
 * rendrait le registre complet au lieu de la période demandée donnerait un
 * export qui a l'air filtré et ne l'est pas. Le refus nomme la clé fautive.
 *
 * Un paramètre absent n'est pas une erreur — c'est « pas de borne ».
 */
export function parsePeriod(searchParams: URLSearchParams): Period {
  const rawFrom = searchParams.get("from");
  const rawTo = searchParams.get("to");

  let from: Date | null = null;
  if (rawFrom) {
    from = localDay(rawFrom, 0);
    if (!from) {
      throw badRequest(
        `Date de début illisible : « ${rawFrom} ». Format attendu : AAAA-MM-JJ.`
      );
    }
  }

  let toExclusive: Date | null = null;
  if (rawTo) {
    const lastDay = localDay(rawTo, 0);
    if (!lastDay) {
      throw badRequest(
        `Date de fin illisible : « ${rawTo} ». Format attendu : AAAA-MM-JJ.`
      );
    }
    // Le lendemain du jour demandé, même heure d'hiver ou d'été : `setDate`
    // travaille sur le calendrier local, pas sur une addition de 86 400 000 ms
    // qui se tromperait d'une heure aux changements d'heure.
    toExclusive = new Date(lastDay);
    toExclusive.setDate(toExclusive.getDate() + 1);
  }

  return { from, toExclusive };
}

/**
 * Construit un filtre `DateTime` pour Prisma à partir d'une période.
 *
 * Renvoie `undefined` quand la période est vide, pour que l'appelant puisse
 * l'étaler dans un `where` sans avoir à tester chaque borne.
 */
export function dateRangeFilter(
  period: Period
): { gte?: Date; lt?: Date } | undefined {
  if (!period.from && !period.toExclusive) return undefined;
  return {
    ...(period.from ? { gte: period.from } : {}),
    ...(period.toExclusive ? { lt: period.toExclusive } : {}),
  };
}

/**
 * La longueur maximale d'un terme de recherche.
 *
 * La recherche traverse un `contains` non indexé sur plusieurs colonnes ; une
 * chaîne d'un mégaoctet n'est pas une requête, c'est une charge. La troncature
 * est silencieuse parce qu'un terme de 200 caractères ne trouve déjà plus rien.
 */
const MAX_SEARCH_LENGTH = 200;

/**
 * Lit `?q=`, le terme de recherche libre.
 *
 * Renvoie `undefined` plutôt qu'une chaîne vide : `contains: ""` en Prisma
 * correspond à *tout*, ce qui donnerait un filtre qui n'en est pas un — et un
 * `?q=` vide dans l'adresse suffirait à le déclencher.
 */
export function parseSearchTerm(
  searchParams: URLSearchParams,
  key = "q"
): string | undefined {
  const raw = searchParams.get(key);
  if (raw === null) return undefined;
  const trimmed = raw.trim().slice(0, MAX_SEARCH_LENGTH);
  return trimmed === "" ? undefined : trimmed;
}
