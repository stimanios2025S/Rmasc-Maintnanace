/**
 * Maintenance RMASC – Régénérer l'accès d'un salarié
 *
 * POST /api/personnel/[id]/password
 *
 * Le mot de passe existant n'est pas modifiable : il n'est stocké que haché, et
 * personne — pas même un administrateur — ne peut le relire. Régénérer est donc
 * la seule façon de rendre un accès à quelqu'un qui l'a perdu, et c'est aussi
 * la bonne : l'ancien cesse de fonctionner dans le même mouvement.
 *
 * LES SESSIONS OUVERTES SONT FERMÉES
 * Un mot de passe qu'on remplace parce qu'il a fuité ne sert à rien si la
 * session ouverte avec lui continue de fonctionner. `Session` est la table que
 * NextAuth consulte à chaque requête ; la vider coupe l'accès immédiatement, sur
 * tous les appareils, y compris celui de quelqu'un qui n'a rien demandé.
 *
 * C'est une conséquence à dire à l'écran, parce qu'elle est visible : un
 * salarié qui utilisait l'application en est éjecté. Un administrateur qui
 * régénère son *propre* accès se déconnecte donc lui-même.
 */

import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError, jsonOk, notFound } from "@/lib/api/http";
import { requireRole } from "@/lib/api/guard";
import { generatePassword } from "@/lib/auth/passwords";
import { STAFF_ROLES } from "@/types";

const BCRYPT_ROUNDS = 12;

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireRole("ADMIN");

    const target = await prisma.user.findFirst({
      where: { id: params.id, role: { in: [...STAFF_ROLES] } },
      select: { id: true, name: true },
    });
    if (!target) throw notFound(`Compte du personnel introuvable : ${params.id}`);

    const password = generatePassword();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    await prisma.user.update({
      where: { id: target.id },
      data: { passwordHash },
      select: { id: true },
    });

    const revoked = await prisma.session.deleteMany({
      where: { userId: target.id },
    });

    return jsonOk({
      name: target.name,
      // En clair, une seule fois. Le hachage ne quitte jamais le serveur.
      password,
      sessionsRevoked: revoked.count,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
