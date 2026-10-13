/**
 * Les règles de la transmission au magasin central.
 *
 * POURQUOI CE FICHIER N'IMPORTE RIEN DE NODE
 * Le module qui signe les requêtes (`lib/stock/client.ts`) a besoin de
 * `node:crypto`. Cet écran-ci doit savoir *quels* boutons offrir, et il tourne
 * dans le navigateur. Si les deux vivaient dans le même fichier, importer la
 * règle ferait entrer `node:crypto` dans le bundle client. La règle est donc ici,
 * pure, et le transport là-bas. C'est la même séparation que `lib/parts/status.ts`
 * et `lib/iot/metric-catalogue.ts`.
 *
 * UNE SEULE DÉFINITION PAR RÈGLE
 * Le chemin, l'identifiant d'application et le refus sont écrits une fois. La
 * route les applique et l'écran les affiche : un écran qui offrirait un bouton
 * que la route refuse est le défaut que ce dépôt corrige à chaque fois.
 */

import type { PartRequirementStatus, PartUrgency } from "@/types";

/**
 * Le chemin signé, exactement tel que le magasin central le vérifie.
 *
 * Sans query string : la signature porte le `pathname`, et le magasin central a
 * délibérément exclu la query de la signature. Ajouter un paramètre ici ferait
 * donc échouer toutes les requêtes.
 */
export const STOCK_DEMANDE_PATH = "/api/v1/external/demandes";

/**
 * `AppSource` du magasin central. `MAINTENANCE` y est déclaré, et c'est nous.
 *
 * Envoyer autre chose classerait la demande dans le mauvais atelier, et le
 * magasinier la chercherait du mauvais côté.
 */
export const STOCK_SOURCE_APP = "MAINTENANCE";

/**
 * La priorité telle que le magasin central la nomme.
 *
 * Il accepte des synonymes (`URGENT`, `HAUTE`, `HIGH`…), mais s'appuyer sur les
 * synonymes serait s'appuyer sur une tolérance plutôt que sur le vocabulaire.
 * On envoie les deux seules valeurs canoniques.
 *
 * La correspondance est volontairement grossière : notre urgence dit *si
 * l'appareil est à l'arrêt*, la leur dit *à quel point il faut se presser*. Une
 * pièce qui immobilise un appareil est urgente pour eux aussi ; tout le reste
 * attend la tournée normale, et c'est ce que `NORMALE` veut dire.
 */
const PRIORITY_BY_URGENCY: Record<PartUrgency, string> = {
  IMMEDIATE: "URGENTE",
  PREVENTIVE: "NORMALE",
};

export function stockPriorityFor(urgency: PartUrgency): string {
  return PRIORITY_BY_URGENCY[urgency] ?? "NORMALE";
}

/** Ce qu'il faut savoir d'une demande pour décider si elle peut partir. */
export interface TransmittableRequirement {
  status: PartRequirementStatus;
  quantity: number;
  replacementPartName: string;
  stockReference: string | null;
  /** Nombre de lignes déjà envoyées, pour distinguer « partie » de « à envoyer ». */
  stockSentAt?: Date | string | null;
}

/**
 * Ce qui empêche une demande de partir, ou `null` si elle peut partir.
 *
 * L'ÉTAT D'ABORD, ET C'EST `APPROVED` QUI COMPTE
 * Le magasin central ne doit pas recevoir un besoin que le bureau n'a pas
 * validé : faire commander une pièce est un engagement de dépense, et c'est la
 * règle qui gouverne déjà `PENDING → APPROVED`. La transmission n'est donc pas
 * un raccourci, c'est la suite du même chemin.
 *
 * ET LA TRANSMISSION **EST** LE PASSAGE À `ORDERED`
 * Le magasin central est celui qui passe la commande. Une transmission réussie
 * fait donc avancer la demande dans son propre état — les deux machines à états
 * disent alors la même chose, au lieu de se contredire. C'est pour cela que le
 * refus ci-dessous n'exige pas `ORDERED` : on y arrive en transmettant.
 *
 * LA QUANTITÉ DOIT ÊTRE UN ENTIER POSITIF
 * Le magasin central rejette une ligne dont la quantité n'est pas un nombre
 * strictement positif. Le refus est écrit ici pour que le bouton ne soit pas
 * offert, plutôt que pour découvrir le rejet après l'envoi.
 */
export function transmissionRefusal(
  row: TransmittableRequirement
): string | null {
  /**
   * Déjà transmise. La référence est nommée, parce qu'elle est la seule chose
   * qui permette d'aller la chercher dans l'autre application : « déjà envoyée »
   * sans référence oblige à fouiller l'historique à la main.
   */
  if (row.stockReference) {
    return `Déjà transmise au magasin central sous la référence ${row.stockReference}.`;
  }

  if (row.status === "PENDING") {
    return (
      "La demande n'est pas encore validée par le bureau. Validez-la avant de " +
      "la transmettre au magasin central."
    );
  }

  if (row.status === "REJECTED") {
    return (
      "La demande est refusée. Rouvrez-la et faites-la valider avant de la " +
      "transmettre."
    );
  }

  /**
   * `FULFILLED` est refusé : la pièce est posée. Transmettre une demande déjà
   * satisfaite ferait commander une pièce qui n'est plus attendue.
   */
  if (row.status === "FULFILLED") {
    return "La pièce est déjà posée. Il n'y a plus rien à commander.";
  }

  if (!Number.isInteger(row.quantity) || row.quantity <= 0) {
    return "La quantité doit être un nombre entier supérieur à zéro.";
  }

  if (!row.replacementPartName.trim()) {
    return "La pièce à commander n'est pas nommée.";
  }

  return null;
}

/** Vrai quand la demande peut partir. Le pendant du refus, pour l'écran. */
export function canTransmit(row: TransmittableRequirement): boolean {
  return transmissionRefusal(row) === null;
}

/**
 * L'état dans lequel une transmission réussie fait entrer la demande.
 *
 * Écrit ici plutôt que dans la route : l'écran annonce « sera marquée
 * commandée » avant que l'utilisateur clique, et il doit annoncer la même chose
 * que ce que la route écrira.
 */
export const STATUS_AFTER_TRANSMISSION: PartRequirementStatus = "ORDERED";
