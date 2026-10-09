/**
 * Les comptes d'un devis.
 *
 * POURQUOI CE MODULE EST SANS DÉPENDANCE
 * Les mêmes totaux sont calculés à deux endroits : à l'écran, pendant que le
 * bureau tape ses lignes, et à la génération du PDF. Les écrire deux fois
 * garantirait qu'un jour l'écran affiche un total que le document ne porte pas —
 * et c'est le client qui s'en apercevrait.
 *
 * Il ne peut pas non plus s'appuyer sur `Prisma.Decimal`, que le serveur utilise
 * pour l'argent : l'écran de chiffrage est un composant client, et importer le
 * moteur de base de données dans le navigateur est le piège que ce dépôt évite
 * depuis `metric-catalogue`.
 *
 * LES CENTIMES EN ENTIERS, PAS DES FLOTTANTS
 * `0.1 + 0.2` ne fait pas `0.3` en virgule flottante, et un devis dont le total
 * s'écarte d'un centime est un devis qu'un client conteste. Tout est donc
 * ramené en centimes entiers, multiplié en entiers, et arrondi une seule fois
 * par ligne.
 *
 * LES TOTAUX NE SONT PAS STOCKÉS
 * Les lignes portent une quantité et un prix unitaire ; le reste se recalcule.
 * Un total figé à côté de lignes modifiables finit toujours par ne plus
 * correspondre à leur somme — c'est la même raison qui a fait de
 * `WorkOrder.partsReplaced` une source et de la facture une copie.
 */

/**
 * Le taux de TVA, en pourcentage.
 *
 * 19 %, et c'est le formulaire de l'entreprise qui le fixe — For: APP/DA/04/14
 * porte la ligne « TVA (19%) » en dur. Le schéma des factures dit l'inverse
 * pour son propre compte (« Aucune TVA et aucun taux : le régime n'est pas
 * tranché ») ; il n'est pas touché par ce module, et une facture déjà émise ne
 * change pas de montant parce qu'un devis a été créé.
 *
 * Écrit ici comme une constante nommée, et non en `0.19` dispersé : le jour où
 * le taux bouge, c'est une ligne, et les devis déjà émis gardent le taux qu'ils
 * portaient puisqu'aucun montant n'est recalculé après coup.
 */
export const VAT_RATE_PERCENT = 19;

/** Une ligne, réduite à ce qui produit un montant. */
export interface QuoteLineAmounts {
  quantity: number;
  unitPrice: number;
}

export interface QuoteTotals {
  /** Somme des montants hors taxes, en dinars. */
  totalHt: number;
  /** La TVA sur ce total. */
  vatAmount: number;
  /** Total toutes taxes comprises. */
  totalTtc: number;
}

const centimes = (value: number): number => Math.round(value * 100);
const dinars = (value: number): number => value / 100;

/**
 * Le montant hors taxes d'une ligne.
 *
 * Quantité × prix unitaire, arrondi au centime. La multiplication se fait sur
 * des entiers — des centimes de quantité par des centimes de prix, divisés par
 * cent —, ce qui n'introduit qu'un seul arrondi, à la fin.
 *
 * Une quantité ou un prix non fini vaut zéro plutôt que `NaN` : une ligne à
 * moitié saisie doit s'afficher à zéro pendant qu'on la tape, et `NaN` se
 * propage à tout le devis en une seule frappe.
 */
export function lineAmountHt(line: QuoteLineAmounts): number {
  const qty = Number.isFinite(line.quantity) ? line.quantity : 0;
  const price = Number.isFinite(line.unitPrice) ? line.unitPrice : 0;
  return dinars(Math.round((centimes(qty) * centimes(price)) / 100));
}

/** Les trois totaux du devis, à partir de ses lignes. */
export function computeQuoteTotals(
  lines: readonly QuoteLineAmounts[]
): QuoteTotals {
  const totalHtCentimes = lines.reduce(
    (sum, line) => sum + Math.round(lineAmountHt(line) * 100),
    0
  );
  const vatCentimes = Math.round(
    (totalHtCentimes * VAT_RATE_PERCENT) / 100
  );

  return {
    totalHt: dinars(totalHtCentimes),
    vatAmount: dinars(vatCentimes),
    totalTtc: dinars(totalHtCentimes + vatCentimes),
  };
}

/**
 * Formate un montant pour l'affichage et pour le document.
 *
 * `formatDzd` de `lib/ui/money.ts` n'est pas réutilisé : il écrit « DZD », et
 * le formulaire de devis parle en « DA ». Deux écritures pour la même monnaie
 * sur deux documents de la même entreprise se remarqueraient — mais c'est le
 * formulaire qui fait foi ici, et c'est `formatDzd` qui porte l'autre usage.
 *
 * Les centimes ne s'affichent que s'il y en a : « 18 500 DA » se lit, « 18
 * 500,00 DA » sur un devis de dépannage est du bruit.
 */
export function formatDa(amount: number): string {
  if (!Number.isFinite(amount)) return "—";
  const hasCents = Math.round(amount * 100) % 100 !== 0;
  return `${amount.toLocaleString("fr-FR", {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  })} DA`;
}

/**
 * Lit un montant ou une quantité tel qu'une personne le tape.
 *
 * Virgule décimale et espaces de milliers, comme `parseDecimalInput` de
 * `lib/ui/numbers.ts` — mais `null` pour un champ vide, ce qui est la bonne
 * réponse pendant la saisie : une ligne qu'on n'a pas encore remplie n'est pas
 * une ligne à zéro.
 *
 * Refuse le négatif : un devis se corrige par une ligne, pas par un montant en
 * dessous de zéro.
 */
export function parseAmountInput(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, "").replace(",", ".").trim();
  if (cleaned === "") return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100) / 100;
}
