/**
 * Les règles de vie d'un devis.
 *
 * POURQUOI UN FICHIER À PART, SANS DÉPENDANCE
 * Comme `lib/parts/status.ts` et `boundsViolation` : la route refuse une
 * transition, l'écran décide quels boutons offrir, et le document imprime l'état
 * courant. Trois endroits, une seule règle — sinon le bouton qui échoue est ce
 * que l'utilisateur voit de la divergence.
 *
 * Pure, donc exerçable sans base de données : c'est la seule partie du module
 * devis qu'on peut éprouver sur une machine sans PostgreSQL.
 */

import type { QuoteStatus } from "@/types";

/** Ce qu'une ligne doit porter pour qu'un devis puisse être remis. */
export interface PricableLine {
  designation: string;
  quantity: number;
  unitPrice: number;
}

/**
 * Ce qui empêche une transition, ou `null` si elle est permise.
 *
 * TROIS RÈGLES, ET CHACUNE CORRIGE UNE FAÇON DE MENTIR AU CLIENT
 *
 *  1. **On ne remet pas un devis vide.** `SENT` exige au moins une ligne
 *     désignée et un total supérieur à zéro. Une offre sans montant n'est pas
 *     une offre : c'est une demande que le bureau n'a pas traitée, et l'envoyer
 *     ferait attendre le client pour rien.
 *
 *  2. **On ne décide que ce qu'on a reçu.** `ACCEPTED` et `REFUSED` ne
 *     s'obtiennent que depuis `SENT`. Un accord enregistré sur une offre jamais
 *     remise est un accord que le client ne se souvient pas d'avoir donné —
 *     et c'est celui qu'on brandit trois mois plus tard.
 *
 *  3. **On peut revenir en arrière, sauf depuis un accord.** Un devis accepté
 *     engage : le remettre en brouillon effacerait la trace de l'accord. Pour
 *     le reprendre, il faut le refuser puis le rouvrir — deux gestes explicites,
 *     tous deux datés. C'est la même logique que la facture réglée qu'on ne peut
 *     pas annuler directement.
 */
export function quoteTransitionRefusal(
  from: QuoteStatus,
  to: QuoteStatus,
  lines: readonly PricableLine[]
): string | null {
  // Rejouer l'état courant n'est pas une transition. Test en tête, comme pour
  // les pièces : sans lui, les règles ci-dessous refuseraient `SENT → SENT`.
  if (from === to) return null;

  if (to === "SENT") {
    if (lines.length === 0) {
      return (
        "Un devis sans ligne ne peut pas être remis : ajoutez au moins une " +
        "prestation ou une fourniture avant de l'envoyer."
      );
    }
    const hasAmount = lines.some(
      (line) =>
        line.designation.trim() !== "" &&
        Number.isFinite(line.quantity) &&
        Number.isFinite(line.unitPrice) &&
        line.quantity > 0 &&
        line.unitPrice > 0
    );
    if (!hasAmount) {
      return (
        "Aucune ligne ne porte de montant : un devis à zéro dinar n'est pas " +
        "une offre."
      );
    }
  }

  if ((to === "ACCEPTED" || to === "REFUSED") && from !== "SENT") {
    return (
      "Un devis ne peut être accepté ou refusé qu'une fois remis au client. " +
      "Marquez-le d'abord comme envoyé."
    );
  }

  if (from === "ACCEPTED" && to === "REQUESTED") {
    return (
      "Un devis accepté engage l'entreprise : il ne se remet pas en brouillon. " +
      "Refusez-le, puis rouvrez la demande — la trace de l'accord est conservée."
    );
  }

  return null;
}

/**
 * Les états depuis lesquels un devis peut encore être corrigé.
 *
 * Sert à l'écran : une fois l'offre remise, ses lignes ne se touchent plus — le
 * client a un papier, et le modifier en base rendrait le papier faux. On ne
 * corrige pas une offre remise : on la refuse et on en émet une autre, ce que
 * la règle ci-dessus impose déjà.
 */
export function isEditable(status: QuoteStatus): boolean {
  return status === "REQUESTED";
}

/**
 * Les états qui attendent une action du bureau.
 *
 * `REQUESTED` attend un chiffrage, `SENT` attend la réponse du client. Les deux
 * remontent dans le tableau, mais elles n'attendent pas la même personne — et
 * c'est la distinction que porte le filtre de l'écran.
 */
export function awaitsOffice(status: QuoteStatus): boolean {
  return status === "REQUESTED";
}

/**
 * L'état d'un devis, dans l'ordre où un bureau le cherche.
 *
 * Demande d'abord : c'est ce qui n'est pas fait. Puis les offres en attente de
 * réponse, puis les issues. Cet ordre n'est pas celui du cycle de vie — il est
 * celui du travail en retard, et c'est celui qui sert.
 */
export const QUOTE_STATUS_WEIGHT: Record<QuoteStatus, number> = {
  REQUESTED: 0,
  SENT: 1,
  ACCEPTED: 2,
  REFUSED: 3,
  CANCELLED: 4,
};
