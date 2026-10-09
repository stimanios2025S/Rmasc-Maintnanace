/**
 * Lecture des nombres saisis à la main dans un champ de formulaire.
 *
 * Le même problème se pose pour un montant et pour une coordonnée, et c'est le
 * même code : un clavier de téléphone réglé sur `decimal` produit une virgule,
 * une facture s'écrit « 18 500 », et une carte affiche « 36,7538 ». Refuser ces
 * écritures serait demander à l'utilisateur de taper autrement ce qu'il a sous
 * les yeux.
 *
 * Ce module existe parce que la fonction avait commencé à être recopiée — une
 * fois pour le montant du rapport, une fois pour l'ouverture d'un compte, et une
 * troisième se préparait pour la fiche du client. Trois copies d'une règle de
 * lecture, c'est trois occasions de diverger sur ce que « saisie invalide »
 * veut dire.
 *
 * Ce n'est PAS un analyseur permissif : il ne devine rien, il ne retire pas les
 * unités, il ne comprend pas « environ 12 ». Il accepte la ponctuation décimale
 * que le pays utilise, et rejette tout le reste.
 */

export interface ParseNumberOptions {
  /**
   * Autorise un signe moins.
   *
   * Faux par défaut : un montant négatif n'existe pas dans ce produit — une
   * facture se rembourse par un avoir, pas par un nombre en dessous de zéro — et
   * accepter le signe laisserait passer des saisies qui n'ont pas de sens. Une
   * latitude, elle, est négative dans tout l'hémisphère sud.
   */
  allowNegative?: boolean;
}

/**
 * Lit un nombre, ou renvoie `null` s'il n'y a rien de lisible.
 *
 * `null` couvre trois cas que l'appelant doit distinguer lui-même : le champ
 * vide (souvent légitime — un site sans coordonnées), le texte qui n'est pas un
 * nombre, et la valeur hors des bornes autorisées. Ici on ne sait pas laquelle
 * de ces situations est une erreur ; c'est le formulaire qui le sait.
 */
export function parseDecimalInput(
  raw: string,
  options: ParseNumberOptions = {}
): number | null {
  const cleaned = raw.replace(/\s/g, "").replace(",", ".");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  if (!options.allowNegative && value < 0) return null;
  return value;
}

/**
 * Une mesure, telle qu'elle s'imprime sur une feuille de contrôle.
 *
 * POURQUOI CETTE FONCTION EXISTE
 * Un `float` traverse le JSON avec tout ce que la virgule flottante a produit.
 * Un relevé calculé — `11,2 + 2 × 0,35` — arrive donc sous la forme
 * `11.899999999999999`, et c'est ce que la fiche d'entretien a imprimé : quinze
 * décimales sur un document qu'un technicien signe et qu'un contrôle lit.
 *
 * Le défaut n'a été vu qu'en prenant la feuille en capture d'écran. Aucun
 * contrôle de texte ne l'aurait montré — la valeur est bien là, elle est
 * seulement écrite avec la précision du binaire plutôt qu'avec celle d'un
 * appareil de mesure.
 *
 * Deux décimales suffisent à tout ce qu'un ascenseur se mesure : des ohms, des
 * millimètres, des mètres par seconde. Un relevé qui en porte davantage n'est
 * pas plus précis, il est illisible.
 *
 * La conversion est faite *ici* et non dans la donnée de démonstration, dont la
 * valeur biscornue est conservée exprès : elle sert de cas de contrôle, et
 * l'arrondir à la source aurait caché le défaut au lieu de le corriger.
 */
export function formatMeasurement(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return rounded.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
}
