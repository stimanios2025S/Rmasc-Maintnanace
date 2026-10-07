/**
 * Maintenance RMASC – Modifier une fiche du personnel
 *
 * PATCH /api/personnel/[id]
 *
 * LES DEUX GARDES QUI COMPTENT
 *
 * 1. On ne se retire pas ses propres droits.
 *    Un administrateur qui change son propre rôle se ferme la porte derrière
 *    lui : la requête est acceptée, l'écriture passe, et l'application n'a plus
 *    d'administrateur. Personne ne s'en aperçoit avant d'en avoir besoin.
 *
 * 2. On ne retire pas le dernier administrateur actif.
 *    La même porte, atteinte autrement — en rétrogradant un collègue, ou en le
 *    désactivant. Le compte est compté au moment de l'écriture, et non supposé :
 *    « il en reste un » est une affirmation sur l'état de la base, pas sur
 *    l'intention de celui qui clique.
 *
 * Les deux refusent *l'écriture qui produirait* l'état sans administrateur, et
 * pas une action en particulier : rétrograder, désactiver ou changer un rôle
 * passent donc tous par la même vérification, au lieu de trois règles qui
 * finiraient par diverger.
 *
 * UN COMPTE CLIENT N'EST PAS MODIFIABLE ICI
 * `BUILDING_OWNER` est hors de `STAFF_ROLES`, et la recherche de la cible le
 * filtre. Sans cela, cette route permettrait de changer le rôle d'un client —
 * c'est-à-dire de transformer un compte client en compte d'administration, ce
 * qui est exactement l'élévation de privilèges que l'ouverture de ce module à
 * l'administrateur seul cherche à empêcher.
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import {
  conflict,
  handleRouteError,
  jsonOk,
  notFound,
  readJson,
} from "@/lib/api/http";
import { requireRole } from "@/lib/api/guard";
import type { Prisma } from "@prisma/client";
import { STAFF_ROLES } from "@/types";
import { UpdateStaffSchema, normalisePhone } from "@/lib/personnel/schemas";

const STAFF_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  status: true,
  isActive: true,
  specialties: true,
  defaultZone: true,
  createdAt: true,
  _count: {
    select: {
      assignedWorkOrders: {
        where: { status: { in: ["ASSIGNED", "IN_PROGRESS", "ON_HOLD"] } },
      },
      assignedIncidents: {
        where: { status: { in: ["ESCALATED", "TECHNICIAN_ASSIGNED", "IN_PROGRESS"] } },
      },
    },
  },
} as const satisfies Prisma.UserSelect;

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireRole("ADMIN");
    const parsed = UpdateStaffSchema.parse(await readJson(request));

    const target = await prisma.user.findFirst({
      where: { id: params.id, role: { in: [...STAFF_ROLES] } },
      select: { id: true, name: true, role: true, isActive: true },
    });
    if (!target) {
      // Un client, un compte inexistant et un identifiant inventé donnent tous
      // la même réponse : cette route ne dit pas si l'identifiant existe
      // ailleurs dans la table.
      throw notFound(`Compte du personnel introuvable : ${params.id}`);
    }

    const nextRole = parsed.role ?? target.role;
    const nextIsActive = parsed.isActive ?? target.isActive;

    if (target.id === session.user.id && nextRole !== target.role) {
      throw conflict(
        "Vous ne pouvez pas modifier votre propre rôle. Demandez à un autre " +
          "administrateur de le faire — la règle existe pour qu'un compte ne " +
          "puisse pas se fermer lui-même la porte d'administration."
      );
    }

    const losesAdmin =
      target.role === "ADMIN" && (nextRole !== "ADMIN" || !nextIsActive);

    if (losesAdmin) {
      const remainingAdmins = await prisma.user.count({
        where: { role: "ADMIN", isActive: true, id: { not: target.id } },
      });

      if (remainingAdmins === 0) {
        throw conflict(
          `« ${target.name} » est le dernier administrateur actif. Le rétrograder ` +
            "ou le désactiver laisserait l'application sans personne capable " +
            "d'ouvrir un compte, d'ajouter un immeuble ou de configurer un " +
            "accès. Nommez d'abord un autre administrateur."
        );
      }
    }

    const data: Prisma.UserUpdateInput = {};

    if (parsed.name !== undefined) data.name = parsed.name;

    if (parsed.email !== undefined) {
      const taken = await prisma.user.findFirst({
        where: { email: parsed.email, id: { not: target.id } },
        select: { id: true },
      });
      if (taken) throw conflict("Un autre compte utilise déjà cette adresse e-mail.");
      data.email = parsed.email;
    }

    if (parsed.phone !== undefined) {
      const phone = normalisePhone(parsed.phone);
      if (!phone.ok) throw conflict(phone.message);
      data.phone = phone.phone;
    }

    if (parsed.role !== undefined) data.role = parsed.role;
    if (parsed.isActive !== undefined) data.isActive = parsed.isActive;
    if (parsed.status !== undefined) data.status = parsed.status;
    if (parsed.specialties !== undefined) data.specialties = parsed.specialties;

    // `null` efface le secteur, `undefined` le laisse tel quel : deux intentions
    // distinctes qu'un `??` confondrait.
    if (parsed.defaultZone !== undefined) {
      data.defaultZone = parsed.defaultZone?.length ? parsed.defaultZone : null;
    }

    const member = await prisma.user.update({
      where: { id: target.id },
      data,
      select: STAFF_SELECT,
    });

    /**
     * Désactiver ferme les sessions ouvertes.
     *
     * `isActive` seul ne coupe rien : la session NextAuth vit dans un cookie
     * signé et reste valide jusqu'à son expiration. Un salarié qu'on vient de
     * désactiver continuerait donc d'utiliser l'application jusqu'à ce qu'il
     * ferme son navigateur — ce qui n'est pas ce que « désactiver » veut dire.
     *
     * Après l'écriture, et non dedans : supprimer les sessions d'un compte
     * qu'on vient d'activer n'aurait aucun sens, et cette seconde écriture ne
     * fait pas partie du même fait.
     */
    if (parsed.isActive === false) {
      await prisma.session.deleteMany({ where: { userId: target.id } });
    }

    return jsonOk({ member });
  } catch (error) {
    return handleRouteError(error);
  }
}
