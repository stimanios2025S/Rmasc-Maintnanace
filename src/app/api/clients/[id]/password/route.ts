/**
 * Maintenance RMASC – réémission de l'accès d'un compte client.
 *
 * POST /api/clients/:id/password – engendre un nouveau mot de passe
 *
 * POURQUOI CETTE ROUTE EXISTE
 * Le mot de passe n'est jamais stocké en clair et n'est affiché qu'une fois, au
 * moment de la création. Sans cette route, un client qui l'a perdu n'aurait
 * aucun recours : le produit n'envoie pas d'e-mail, et un administrateur ne peut
 * pas relire un hachage. Le compte serait définitivement fermé pour son
 * titulaire. Ce n'est pas une fonctionnalité de confort, c'est la sortie de
 * secours du choix fait à la création.
 *
 * LES SESSIONS OUVERTES SONT FERMÉES
 * Réémettre un mot de passe a deux motifs : le client l'a oublié, ou quelqu'un
 * d'autre l'a. Dans le second cas, laisser vivre les sessions déjà ouvertes
 * reviendrait à changer la serrure en laissant la porte ouverte — celui qu'on
 * cherche à éloigner est précisément celui qui est déjà entré. Les deux
 * sessions du compte sont donc supprimées dans la même transaction.
 *
 * La valeur en clair n'existe que le temps de cette réponse. Elle n'est ni
 * journalisée, ni stockée, ni renvoyée ailleurs.
 *
 * ADMIN UNIQUEMENT.
 */

import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError, jsonOk, notFound } from "@/lib/api/http";
import { requireRole } from "@/lib/api/guard";
import { generateClientPassword } from "@/lib/auth/passwords";

/** Le même coût que la création et que le seed — voir `POST /api/clients`. */
const BCRYPT_ROUNDS = 12;

type Params = { params: { id: string } };

export async function POST(_request: NextRequest, { params }: Params) {
  try {
    await requireRole("ADMIN");

    const client = await prisma.user.findFirst({
      where: { id: params.id, role: "BUILDING_OWNER" },
      select: { id: true, name: true, email: true },
    });
    if (!client) throw notFound(`Compte client introuvable : ${params.id}`);

    const password = generateClientPassword();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: client.id },
        data: { passwordHash },
        select: { id: true },
      }),
      prisma.session.deleteMany({ where: { userId: client.id } }),
    ]);

    // Ni le mot de passe ni son hachage ne figurent dans ce qui suit : le nom et
    // l'adresse servent à l'écran à dire *à qui* l'accès vient d'être réémis,
    // ce qui n'est pas la même chose que « un accès a été réémis ».
    return jsonOk({ client, password });
  } catch (error) {
    return handleRouteError(error);
  }
}
