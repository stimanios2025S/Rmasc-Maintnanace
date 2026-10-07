/**
 * Maintenance RMASC – Gestion du personnel
 *
 * GET  /api/personnel – l'équipe, filtrable par rôle, état et recherche
 * POST /api/personnel – embaucher : crée le compte et rend son accès une fois
 *
 * POURQUOI CE MODULE EXISTE
 * Jusqu'ici, la seule façon d'ouvrir un compte de salarié était de lancer
 * `prisma/seed.ts` ou d'écrire en base. Une entreprise ne peut pas embaucher
 * comme ça : un recrutement demandait une intervention technique sur le
 * serveur, ce qui est à la fois une dépendance et un risque.
 *
 * ADMINISTRATEUR SEUL, ET PAS RESPONSABLE
 * Le point décisif n'est pas la hiérarchie, c'est le rôle. Créer un compte,
 * c'est *choisir son rôle* — et si un responsable peut créer un compte
 * administrateur, alors il peut se donner les droits d'administrateur. Fermer
 * ce module à l'administrateur supprime la question au lieu d'avoir à
 * l'arbitrer. C'est la même règle que `/administration/clients`, pour une
 * raison voisine.
 *
 * LE COMPTE CLIENT N'EST PAS ICI
 * `BUILDING_OWNER` est absent de `STAFF_ROLES`. Un compte client s'ouvre depuis
 * `/administration/clients`, qui crée en même temps son premier immeuble et son
 * accès au portail ; le proposer ici produirait un client sans dossier.
 *
 * AUCUNE SUPPRESSION, SEULEMENT UNE DÉSACTIVATION
 * Un salarié qui part garde ses interventions, ses rapports signés et les
 * factures qu'il a émises. Supprimer la ligne les laisserait orphelins ou
 * refuserait l'écriture (`Invoice.issuedById` est en `Restrict`), et l'historique
 * d'une entreprise ne se réécrit pas parce qu'un salarié a démissionné. `isActive`
 * ferme l'accès sans effacer ce qu'il a fait.
 */

import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db/prisma";
import {
  conflict,
  handleRouteError,
  jsonOk,
  parseBooleanParam,
  parseEnumParam,
  readJson,
} from "@/lib/api/http";
import { requireRole } from "@/lib/api/guard";
import { generatePassword } from "@/lib/auth/passwords";
import { STAFF_ROLES, TECHNICIAN_STATUSES } from "@/types";
import type { Prisma } from "@prisma/client";
import { CreateStaffSchema, normalisePhone } from "@/lib/personnel/schemas";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoPersonnel } from "@/lib/demo/responses";

/** Le nombre de tours de bcrypt, aligné sur le reste de l'application. */
const BCRYPT_ROUNDS = 12;

/**
 * Ce qu'une fiche du personnel rend au bureau.
 *
 * Le hachage n'y est jamais : il n'a aucune raison de quitter le serveur, même
 * vers un écran d'administration. La charge de travail est comptée plutôt que
 * stockée, comme partout ailleurs — un compteur en colonne se désynchronise à
 * la première transition oubliée.
 */
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
  lastPositionAt: true,
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

// ─── GET ────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");
    const { searchParams } = new URL(request.url);

    const role = parseEnumParam(searchParams, "role", STAFF_ROLES);
    const status = parseEnumParam(searchParams, "status", TECHNICIAN_STATUSES);
    const isActive = parseBooleanParam(searchParams, "active");
    const q = searchParams.get("q")?.trim();

    /**
     * Le filtre de rôle est toujours présent, même sans paramètre.
     *
     * Sans lui, la liste rendrait aussi les comptes clients : `User` porte les
     * deux populations, et un écran intitulé « Personnel » qui afficherait les
     * clients de l'entreprise ne serait pas seulement bruyant, il mélangerait
     * deux choses que ce module a précisément pour rôle de distinguer.
     */
    const where: Prisma.UserWhereInput = {
      role: role ? role : { in: [...STAFF_ROLES] },
      ...(status ? { status } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" as const } },
              { email: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    const members = await prisma.user.findMany({
      where,
      select: STAFF_SELECT,
      // Le rôle d'abord : Postgres ordonne les énumérations dans l'ordre de
      // déclaration, donc les administrateurs, puis les responsables, puis les
      // techniciens — l'équipe se lit par fonction sans avoir à filtrer.
      orderBy: [{ role: "asc" }, { name: "asc" }],
    });

    return jsonOk({ members, total: members.length });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/personnel");
      const { searchParams } = new URL(request.url);
      return jsonOk(
        demoPersonnel({
          role: searchParams.get("role"),
          status: searchParams.get("status"),
          active: parseBooleanParam(searchParams, "active") ?? null,
          q: searchParams.get("q"),
        })
      );
    }
    return handleRouteError(error);
  }
}

// ─── POST ───────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    await requireRole("ADMIN");
    const parsed = CreateStaffSchema.parse(await readJson(request));

    const phone = normalisePhone(parsed.phone);
    if (!phone.ok) throw conflict(phone.message);

    // Vérifié avant l'insertion pour que l'appelant reçoive une phrase qui
    // nomme le problème. Sans cela, la contrainte d'unicité remonte en
    // « La ressource existe déjà », qui ne dit pas quel champ a collisionné.
    const existing = await prisma.user.findUnique({
      where: { email: parsed.email },
      select: { id: true },
    });
    if (existing) {
      throw conflict(
        "Un compte utilise déjà cette adresse e-mail. Si c'est un ancien " +
          "salarié, réactivez son compte au lieu d'en créer un second."
      );
    }

    /**
     * Engendré ici, haché, et rendu en clair une seule fois.
     *
     * Le hachage est calculé avant l'écriture plutôt que pendant : bcrypt à 12
     * tours prend quelques centaines de millisecondes, et les passer en tenant
     * une transaction ouverte immobiliserait une connexion pour rien.
     */
    const password = generatePassword();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const member = await prisma.user.create({
      data: {
        name: parsed.name,
        email: parsed.email,
        passwordHash,
        phone: phone.phone,
        role: parsed.role,
        specialties: parsed.specialties,
        defaultZone: parsed.defaultZone?.length ? parsed.defaultZone : null,
        isActive: true,
        // `AVAILABLE` par défaut, y compris pour un compte de bureau : la
        // colonne décrit les techniciens, mais lui donner une autre valeur pour
        // un administrateur ferait dépendre les écrans de dispatch de la
        // lecture d'un rôle. Voir la note sur `AssignableUserWhere`.
        status: "AVAILABLE",
      },
      select: STAFF_SELECT,
    });

    // Le mot de passe en clair ne repart que dans cette réponse, et n'est
    // jamais relisible ensuite.
    return jsonOk({ member, password }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
