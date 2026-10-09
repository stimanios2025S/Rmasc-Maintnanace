/**
 * Le montant d'un devis, en toutes lettres.
 *
 * POURQUOI CE N'EST PAS UNE COQUETTERIE
 * Le formulaire de l'entreprise porte la ligne « Arrêté le présent devis à la
 * somme de : ………… DA », et c'est une mention d'usage sur une offre : elle rend
 * le montant difficile à falsifier — un chiffre se retouche, une phrase se
 * relit. Le document doit donc l'imprimer, et le faire correctement.
 *
 * LES DIFFICULTÉS DU FRANÇAIS SONT TOUTES TRAITÉES
 * Ce ne sont pas des cas rares, ce sont la langue : `soixante et onze` prend
 * « et », `quatre-vingts` prend un « s » quand rien ne le suit et le perd
 * devant `mille`, `cent` fait de même, `mille` est invariable et ne se dit
 * jamais « un mille ». Une conversion approximative se verrait sur la première
 * offre ronde, et une faute sur un montant écrit en lettres est exactement ce
 * qu'un contrôle relève.
 *
 * LE MODULE EST PUR
 * Aucune dépendance, donc exerçable sans base de données ni navigateur — ce qui
 * compte, parce qu'une erreur ici ne se voit qu'à l'impression.
 */

const UNITS = [
  "zéro",
  "un",
  "deux",
  "trois",
  "quatre",
  "cinq",
  "six",
  "sept",
  "huit",
  "neuf",
  "dix",
  "onze",
  "douze",
  "treize",
  "quatorze",
  "quinze",
  "seize",
  "dix-sept",
  "dix-huit",
  "dix-neuf",
];

/** Les dizaines régulières. Soixante-dix, quatre-vingts et quatre-vingt-dix
 *  sont traités à part : leur construction n'est pas régulière. */
const TENS = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante"];

/** 0 à 99. */
function below100(n: number): string {
  if (n < 20) return UNITS[n];

  const ten = Math.floor(n / 10);
  const unit = n % 10;

  if (ten === 7) {
    // soixante-dix, soixante et onze, soixante-douze…
    return unit === 1 ? "soixante et onze" : `soixante-${UNITS[10 + unit]}`;
  }
  if (ten === 9) {
    // quatre-vingt-dix, quatre-vingt-onze…
    return `quatre-vingt-${UNITS[10 + unit]}`;
  }
  if (ten === 8) {
    // « quatre-vingts » prend le s quand rien ne suit.
    return unit === 0 ? "quatre-vingts" : `quatre-vingt-${UNITS[unit]}`;
  }

  const tensWord = TENS[ten];
  if (unit === 0) return tensWord;
  // vingt et un, trente et un… mais pas soixante et onze, traité plus haut.
  if (unit === 1) return `${tensWord} et un`;
  return `${tensWord}-${UNITS[unit]}`;
}

/** 0 à 999. */
function below1000(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;

  if (hundreds === 0) return below100(rest);
  if (hundreds === 1) {
    // « cent » seul, ou « cent un » — le s n'apparaît qu'au pluriel complet.
    return rest === 0 ? "cent" : `cent ${below100(rest)}`;
  }
  return rest === 0
    ? `${UNITS[hundreds]} cents`
    : `${UNITS[hundreds]} cent ${below100(rest)}`;
}

const SCALES = [
  { value: 1_000_000_000, one: "milliard", many: "milliards" },
  { value: 1_000_000, one: "million", many: "millions" },
] as const;

/**
 * Un entier, en lettres.
 *
 * `mille` est traité à part des deux autres échelles parce qu'il ne se comporte
 * pas comme elles : il est invariable (« deux mille », jamais « deux milles »),
 * et il ne prend pas d'article au singulier (« mille », jamais « un mille »),
 * alors qu'on dit « un million ».
 */
export function integerToWords(value: number): string {
  let rest = Math.round(Math.abs(value));
  if (rest === 0) return UNITS[0];

  const parts: string[] = [];

  for (const scale of SCALES) {
    const count = Math.floor(rest / scale.value);
    if (count === 0) continue;
    rest -= count * scale.value;
    const words = below1000(count);
    parts.push(`${words} ${count > 1 ? scale.many : scale.one}`);
  }

  const thousands = Math.floor(rest / 1000);
  if (thousands > 0) {
    rest -= thousands * 1000;
    parts.push(thousands === 1 ? "mille" : `${below1000(thousands)} mille`);
  }

  if (rest > 0) parts.push(below1000(rest));

  return parts.join(" ");
}

/** La première lettre en capitale : la phrase commence là. */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Le montant d'un devis, tel qu'il s'imprime.
 *
 * « Mille deux cent cinquante dinars algériens et cinquante centimes »
 *
 * La devise est comprise dans la phrase, parce que c'est ce que « le montant en
 * lettres » veut dire sur une offre : le document n'a pas à ajouter « DA »
 * derrière une phrase qui dit déjà « dinars ».
 *
 * Un montant rond ne mentionne pas les centimes — « … et zéro centime » se lirait
 * comme une hésitation. Un négatif est écrit « moins … » plutôt que rendu
 * silencieusement positif : il ne devrait pas s'en produire, et si l'un arrive,
 * la phrase doit le dire.
 */
export function amountInWords(amount: number): string {
  if (!Number.isFinite(amount)) return "—";

  const negative = amount < 0;
  const total = Math.round(Math.abs(amount) * 100);
  const whole = Math.floor(total / 100);
  const cents = total % 100;

  const currency = whole > 1 ? "dinars algériens" : "dinar algérien";

  const wholeWords = integerToWords(whole);
  /**
   * « Un million **de** dinars », mais « mille dinars ».
   *
   * Après `million` et `milliard`, le français exige la préposition ; après
   * `mille`, il la refuse. La règle dépend donc du *dernier* mot du nombre, et
   * non de sa taille : « un million deux cent cinquante mille dinars » n'en
   * prend pas, puisqu'il finit par « mille ».
   */
  const needsDe = /(million|millions|milliard|milliards)$/.test(wholeWords);

  let phrase = `${wholeWords} ${needsDe ? "de " : ""}${currency}`;
  if (cents > 0) {
    phrase += ` et ${integerToWords(cents)} centime${cents > 1 ? "s" : ""}`;
  }

  return (negative ? "moins " : "") + capitalise(phrase);
}
