/**
 * Maintenance RMASC – Rotation des mots de passe de démonstration.
 *
 *   npx tsx scripts/rotate-demo-passwords.ts            # constat seulement
 *   npx tsx scripts/rotate-demo-passwords.ts --apply     # remplace réellement
 *
 * POURQUOI CE SCRIPT EXISTE
 * Le mot de passe `password123` a été publié sur la page de connexion de
 * production, en clair, sous les boutons d'accès rapide. Retirer les boutons
 * ferme l'attaque en un clic ; il ne ferme pas l'exposition, parce que le mot de
 * passe lui-même reste valide. Ce script remplace ceux qui l'utilisent encore.
 *
 * IL NE DEMANDE PAS QUELS COMPTES SONT CONCERNÉS, IL LES TROUVE
 * Un compte est concerné si `bcrypt.compare` reconnaît le mot de passe connu sur
 * son hachage. Cela couvre les comptes qu'on aurait oubliés — et un compte
 * oublié est exactement ce qu'une liste écrite à la main laisse derrière elle.
 *
 * LE CONSTAT EST LE COMPORTEMENT PAR DÉFAUT, ET C'EST DÉLIBÉRÉ
 * Changer un mot de passe ferme l'accès de quelqu'un. Sur une production
 * utilisée par un responsable et trois techniciens, il ne faut pas que cela
 * arrive parce qu'on a lancé une commande pour voir ce qu'elle disait. `--apply`
 * est donc exigé, et le constat nomme les comptes sans rien changer.
 *
 * LE GÉNÉRATEUR EST CELUI DE L'APPLICATION, PAS UNE SECONDE COPIE
 * `src/lib/auth/passwords.ts` porte déjà la règle : quatorze caractères, un
 * alphabet sans `I`, `l`, `1`, `O` ni `0`, tirés par `crypto.randomInt`. Une
 * copie ici finirait par diverger, et deux générateurs pour une règle est
 * exactement ce que ce dépôt refuse ailleurs. Il est réutilisé tel quel.
 *
 * LE MOT DE PASSE EN CLAIR N'EST AFFICHÉ QU'UNE FOIS
 * Seul le hachage part en base. La valeur n'existe que sur la sortie de ce
 * script, et rien ne permet de la relire ensuite : un compte dont on perd le
 * nouveau mot de passe en reçoit un autre par `npm run personnel` ou par l'API.
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

import { generatePassword } from "../src/lib/auth/passwords";

/** Le mot de passe publié sur la page de connexion de production. */
const COMPROMISED = "password123";

/** Coût du hachage, aligné sur `prisma/seed.ts` et sur l'API du personnel. */
const BCRYPT_ROUNDS = 12;

async function main() {
  const apply = process.argv.includes("--apply");

  /**
   * Permet de viser un autre mot de passe compromis sans réécrire le script.
   * `--known=valeur`
   */
  const override = process.argv
    .find((arg) => arg.startsWith("--known="))
    ?.slice("--known=".length);
  const compromised = override || COMPROMISED;

  const prisma = new PrismaClient();

  try {
    await prisma.$connect();

    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        passwordHash: true,
      },
      orderBy: { role: "asc" },
    });

    if (users.length === 0) {
      console.error("Aucun compte en base. Rien à faire.");
      process.exitCode = 1;
      return;
    }

    /**
     * La comparaison est faite par bcrypt, hachage par hachage : le mot de passe
     * n'est jamais en base, donc il n'y a pas d'autre façon de savoir.
     */
    const affected: typeof users = [];
    for (const user of users) {
      if (!user.passwordHash) continue;
      if (await bcrypt.compare(compromised, user.passwordHash)) {
        affected.push(user);
      }
    }

    console.log(`Comptes en base :            ${users.length}`);
    console.log(`Utilisant encore "${compromised}" : ${affected.length}\n`);

    if (affected.length === 0) {
      console.log(
        "Aucun compte n'utilise ce mot de passe. Rien à remplacer."
      );
      return;
    }

    for (const user of affected) {
      const flag = user.isActive ? "" : " (compte désactivé)";
      console.log(`  ${user.role.padEnd(20)} ${user.email}${flag}`);
    }

    if (!apply) {
      console.log(
        "\nCONSTAT SEULEMENT — rien n'a été modifié.\n" +
          "Relancez avec --apply pour remplacer ces mots de passe.\n" +
          "Les nouveaux seront affichés une seule fois : notez-les avant de fermer."
      );
      return;
    }

    console.log("\nRemplacement :\n");

    /**
     * Un mot de passe par compte, tiré indépendamment. Réutiliser le même pour
     * tous ramènerait le problème d'origine : un secret partagé qui fuit d'un
     * seul côté ouvre tous les autres.
     */
    for (const user of affected) {
      const password = generatePassword();
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS) },
      });
      console.log(`  ${user.role.padEnd(20)} ${user.email}\n  ${" ".repeat(20)} ${password}\n`);
    }

    console.log(
      "Ces mots de passe ne sont plus affichables. Transmettez-les maintenant,\n" +
        "et changez-les depuis l'application si vous voulez qu'eux seuls les connaissent."
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
