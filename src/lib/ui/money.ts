/**
 * Affichage des montants en dinars.
 *
 * Un seul endroit, parce que le montant à facturer apparaît maintenant sur
 * trois écrans — le board, la fiche du bon, la file d'attente du technicien —
 * et deux formats concurrents pour le même chiffre finissent toujours par
 * diverger. Le board portait déjà cette fonction en local ; elle est remontée
 * ici quand la fiche a eu besoin de la même.
 *
 * POURQUOI ELLE ACCEPTE `string`
 * Les montants traversent trois représentations selon l'endroit d'où ils
 * viennent : un `Decimal` de Prisma sérialisé en JSON (donc une chaîne,
 * « 18500 »), un `number` côté démo, et le contenu d'un champ de saisie. Refuser
 * la chaîne obligerait chaque appelant à convertir avant d'appeler, et une
 * conversion oubliée est un montant qui s'affiche « NaN » sur une facture.
 */

/**
 * Formate un montant, ou renvoie `null` s'il n'y a rien à afficher.
 *
 * `null` est une réponse, pas un échec : l'absence de montant est un état réel
 * — intervention couverte par le contrat, ou rapport dont le technicien a laissé
 * le champ vide — et l'appelant doit pouvoir dire « pas de montant » plutôt que
 * « 0 DZD », qui est une somme qu'on pourrait croire facturée.
 *
 * Les centimes ne s'affichent que s'il y en a. Le dinar n'a pas de subdivision
 * en usage courant, et « 18 500,00 DZD » sur un bon de terrain est du bruit ;
 * la colonne garde pourtant deux décimales, pour le jour où un tarif arrivera
 * avec des centimes.
 */
/**
 * Lit un montant tel qu'une personne le tape.
 *
 * Un clavier de téléphone réglé sur `decimal` produit une virgule sur un
 * combiné français, et « 18500,50 » n'est pas un nombre que `Number()` accepte.
 * Les espaces partent aussi : « 18 500 » est l'écriture d'une facture, et la
 * refuser serait le formulaire qui pinaille sur la seule chose qu'il existe pour
 * recueillir.
 *
 * Renvoie `null` quand il n'y a rien à lire — champ vide, texte, ou négatif.
 * L'appelant décide si c'est une erreur : au bureau un montant illisible bloque
 * la validation, sur un rapport non facturable il n'y a rien à lire du tout.
 */
export function parseDzdInput(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, "").replace(",", ".");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

export function formatDzd(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return null;
  const hasCents = Math.round(value * 100) % 100 !== 0;
  return `${value.toLocaleString("fr-FR", {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  })} DZD`;
}
