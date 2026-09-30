/**
 * Numéros de téléphone, pour les canaux qui sortent de l'application.
 *
 * POURQUOI CE FICHIER EXISTE
 * Un numéro de téléphone est écrit par un humain, dans un formulaire, et lu par
 * une machine. Les deux ne sont d'accord sur rien : « +213 661 23 45 67 »,
 * « 00213661234567 » et « 0661234567 » désignent le même téléphone, et un
 * opérateur n'en accepte qu'une seule écriture. La traduction se fait ici, une
 * fois, plutôt qu'à chaque endroit qui envoie un message.
 *
 * LA RÈGLE QUI COMPTE : ON NE DEVINE PAS UN PAYS
 * « 0661234567 » sans indicatif ne veut rien dire hors d'Algérie, et l'envoyer
 * tel quel est la façon dont un message atterrit sur le téléphone d'un inconnu.
 * Quand le numéro n'est pas en forme internationale, cette fonction **refuse**
 * au lieu de compléter au hasard — sauf si l'exploitant a déclaré son pays dans
 * `WHATSAPP_DEFAULT_COUNTRY_CODE`, auquel cas elle complète avec la seule valeur
 * qu'il a lui-même donnée. Voir `.env.example`.
 */

/**
 * Les bornes d'un numéro en forme internationale.
 *
 * E.164 plafonne à 15 chiffres ; en dessous de 8, ce n'est plus un numéro mais
 * une saisie incomplète. Les deux bornes sont larges à dessein : ce n'est pas à
 * ce fichier de décider quels plans de numérotation nationaux sont valides, il
 * écarte seulement ce qui ne peut pas en être un.
 */
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

/**
 * Met un numéro écrit par un humain en forme internationale, chiffres seuls.
 *
 * Renvoie `null` quand ce qui reste ne peut pas être un numéro — c'est un
 * résultat normal, pas une erreur : l'appelant doit alors dire « numéro
 * inutilisable » plutôt que d'envoyer à une adresse inventée.
 *
 * `defaultCountryCode` vient de `WHATSAPP_DEFAULT_COUNTRY_CODE`. Il n'est lu
 * qu'ici et il est passé en paramètre plutôt que lu dans l'environnement, pour
 * que cette fonction reste des maths sur une chaîne de caractères.
 */
export function toWhatsAppNumber(
  raw: string | null | undefined,
  defaultCountryCode?: string | null
): string | null {
  if (!raw) return null;

  // Tout ce qui n'est pas un chiffre part : espaces, points, tirets,
  // parenthèses, et le « + », que l'opérateur attend séparément des chiffres.
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return null;

  // « 00 » est l'autre façon d'écrire un « + » international.
  if (digits.startsWith("00")) digits = digits.slice(2);

  // Un numéro écrit à la nationale ne peut pas partir tel quel : les chiffres
  // ne veulent rien dire sans leur pays. On complète uniquement si l'exploitant
  // nous a donné son pays, sinon on refuse plutôt que de deviner.
  if (digits.startsWith("0")) {
    const code = (defaultCountryCode ?? "").replace(/\D/g, "");
    if (!code) return null;
    digits = code + digits.replace(/^0+/, "");
  }

  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;

  return digits;
}

/**
 * « +213661234567 » devient « +213•••••4567 ».
 *
 * Les journaux finissent collés dans des conversations et des tickets. Le
 * destinataire est un membre du personnel, pas un client : ce n'est donc pas
 * une obligation de confidentialité, c'est qu'un numéro de portable personnel
 * dans une ligne de journal partagée est du bruit au mieux et une fuite au
 * pire. Les quatre derniers chiffres suffisent à confirmer qui a été prévenu.
 */
export function maskPhone(number: string): string {
  const trimmed = number.trim();
  if (trimmed.length <= 8) return "••••";
  return `${trimmed.slice(0, 4)}${"•".repeat(
    trimmed.length - 8
  )}${trimmed.slice(-4)}`;
}
