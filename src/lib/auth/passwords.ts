/**
 * Génération des mots de passe d'accès.
 *
 * Le même générateur sert aux comptes clients et aux comptes du personnel. Il
 * n'y a aucune raison d'en avoir deux : la propriété qui compte — un secret
 * long, tiré au hasard, jamais utilisé ailleurs et jamais stocké en clair — ne
 * dépend pas de qui se connecte avec.
 *
 * POURQUOI LE SYSTÈME LE TIRE ET PAS LE BUREAU
 * Un mot de passe qu'un employé invente est un mot de passe qu'un employé
 * connaît, et qu'il choisit pour pouvoir le retenir — donc court, ou réutilisé
 * d'un autre compte, ou dérivé du nom du client. Le générer ici, c'est garantir
 * qu'il est long et qu'il n'a jamais servi ailleurs. Le bureau le transmet, il
 * ne le compose pas.
 *
 * IL N'EST JAMAIS STOCKÉ EN CLAIR
 * Seul le hachage bcrypt part en base. La valeur en clair existe le temps d'une
 * réponse HTTP et n'apparaît qu'une fois à l'écran. C'est la contrepartie du
 * choix : personne — pas même un administrateur — ne peut relire un mot de
 * passe existant. Un client qui l'a perdu en reçoit un nouveau, et l'ancien
 * cesse de fonctionner.
 *
 * L'ALPHABET EXCLUT LES CARACTÈRES AMBIGUS
 * `I`, `l`, `1`, `O` et `0` sont écartés. Ce mot de passe est lu à voix haute au
 * téléphone ou recopié depuis un écran, et « est-ce un I majuscule, un l
 * minuscule ou un un ? » est une question qu'un alphabet de 56 caractères
 * suffit à ne jamais poser — la perte d'entropie est négligeable devant un mot
 * de passe qu'on finit par noter sur un papier collé au mur.
 *
 * Module serveur : `node:crypto` n'a rien à faire dans un bundle navigateur.
 */

import { randomInt } from "node:crypto";

/**
 * 56 caractères : les 26 lettres et les 10 chiffres, moins les ressemblances.
 * `randomInt` plutôt que `Math.random()` — un générateur non cryptographique
 * produirait ici des mots de passe devinables à partir d'autres mots de passe.
 */
const ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** 14 caractères sur 56 ≈ 81 bits d'entropie. Hors de portée d'une attaque. */
const DEFAULT_LENGTH = 14;

export function generatePassword(length: number = DEFAULT_LENGTH): string {
  let password = "";
  for (let i = 0; i < length; i++) {
    password += ALPHABET[randomInt(ALPHABET.length)];
  }
  return password;
}
