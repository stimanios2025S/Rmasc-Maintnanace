/**
 * Les règles de vie d'une demande de pièce.
 *
 * POURQUOI CE FICHIER EST SÉPARÉ DU GÉNÉRATEUR PDF ET DE LA ROUTE
 * Parce que la même règle doit s'appliquer à deux endroits qui ne se parlent
 * pas : la route qui refuse une transition, et l'écran qui décide quels boutons
 * offrir. Un écran qui propose une action que la route refuse est un défaut que
 * ce dépôt corrige à chaque fois qu'il le rencontre ; la seule façon de ne pas
 * le réintroduire est de n'écrire la règle qu'une fois.
 *
 * C'est le même choix que `boundsViolation` dans `lib/iot/metric-catalogue.ts`,
 * et pour la même raison.
 */

import type { PartRequirementStatus, PartUrgency } from "@/types";

/**
 * Ce qui empêche une transition d'état, ou `null` si elle est permise.
 *
 * UNE SEULE RÈGLE, ET ELLE EST LA SEULE QUI COMPTE
 * Une pièce ne se pose qu'une fois la demande validée. C'est tout : le bureau
 * peut valider, refuser, revenir sur sa décision, rouvrir une demande refusée —
 * ces mouvements-là sont des avis, et un avis se change. `FULFILLED`, lui,
 * affirme un fait : la pièce est montée sur l'appareil. Il ne peut pas découler
 * directement d'une demande que personne n'a lue.
 *
 * Cette règle oblige à deux gestes là où le bureau en voudrait un seul — valider
 * puis marquer posée — et c'est voulu : les deux décisions sont différentes, et
 * six mois plus tard, la question « qui a autorisé cette dépense ? » n'a de
 * réponse que si les deux ont été enregistrées.
 *
 * `from === to` est permis et ne fait rien : l'écran n'a pas à distinguer
 * « je l'ai validée » de « elle l'était déjà ».
 */
export function transitionRefusal(
  from: PartRequirementStatus,
  to: PartRequirementStatus
): string | null {
  /**
   * Rejouer l'état courant n'est pas une transition.
   *
   * Ce test est en tête, et il a été ajouté après coup : sans lui, la règle
   * ci-dessous refuse `FULFILLED → FULFILLED`, puisque l'état de départ n'est
   * pas `APPROVED`. La route ne s'en apercevait pas — elle sort plus haut quand
   * les deux états sont égaux —, mais un écran qui demanderait à cette fonction
   * « quels boutons m'offrir » aurait proposé de poser une pièce déjà posée
   * sous forme de refus. C'est le genre d'écart qui n'apparaît qu'au second
   * appelant, et qui coûte alors une enquête.
   */
  if (from === to) return null;

  if (to === "FULFILLED" && from !== "APPROVED") {
    return (
      "Une pièce ne se pose qu'une fois la demande validée. Validez-la d'abord, " +
      "puis marquez-la posée."
    );
  }
  return null;
}

/**
 * Vrai quand la demande attend encore une décision du bureau.
 *
 * Sert au badge de l'écran et au compteur du bon de travail. Écrit ici plutôt
 * qu'en `status === "PENDING"` à chaque appel : le jour où un état s'ajoute
 * avant la décision, c'est une ligne à changer et non une recherche.
 */
export function awaitsDecision(status: PartRequirementStatus): boolean {
  return status === "PENDING";
}

/**
 * L'ordre dans lequel les demandes se lisent.
 *
 * L'urgence d'abord — une pièce qui immobilise un appareil passe avant une pièce
 * qui attendra la prochaine visite —, puis la plus ancienne. Une demande
 * urgente et vieille de trois semaines remonte donc en tête, ce qui est
 * exactement la ligne qu'un bureau doit voir en ouvrant le tableau.
 *
 * Renvoie un poids, et non un comparateur, pour que l'appelant puisse trier
 * aussi bien en mémoire que dans une clause `orderBy` si le besoin vient.
 */
export function urgencyWeight(urgency: PartUrgency): number {
  return urgency === "IMMEDIATE" ? 0 : 1;
}
