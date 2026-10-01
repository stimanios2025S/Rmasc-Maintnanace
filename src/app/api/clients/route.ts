/**
 * Maintenance RMASC – client account administration.
 *
 * GET    /api/clients   – list the customer accounts
 * POST   /api/clients   – create one, contracted or not
 * PATCH  /api/clients   – change an existing account's contract status
 *
 * WHY THIS FILE EXISTS
 * Until now no route could create a user at all. The only accounts in the
 * product were the six the seed script writes, which meant an administrator
 * had no way to onboard a customer and no way to record whether that customer
 * held a maintenance contract. This is that missing piece.
 *
 * ADMIN ONLY. The brief was explicit — the administrator is the one who opens
 * accounts — so every verb here is gated to ADMIN rather than to
 * MANAGEMENT_ROLES. Widening it to maintenance managers is a one-line change
 * in each handler if that turns out to be too strict in practice.
 *
 * ON THE MISSING VERBS
 * There is deliberately no DELETE. Deleting a client cascades to their
 * buildings, elevators, incidents and sheets, so an offboarding mistake here
 * would destroy a customer's entire history with no way back. Deactivating the
 * account (`isActive: false`) is the operation that is actually wanted, and it
 * is already honoured by the sign-in path.
 */

import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  conflict,
  handleRouteError,
  jsonOk,
  parseEnumParam,
  readJson,
} from "@/lib/api/http";
import { requireRole } from "@/lib/api/guard";
import { generateClientPassword } from "@/lib/auth/passwords";
import { CLIENT_TYPES, SLA_TIERS } from "@/types";

/** Matches the cost factor the seed uses, so both produce interchangeable hashes. */
const BCRYPT_ROUNDS = 12;

// ─── Schemas ────────────────────────────────────────────────

/**
 * `clientType` is required rather than defaulted.
 *
 * Defaulting it to CONTRACTED would be kinder to a caller who forgot, and
 * wrong: the two types open genuinely different portals, and a mis-typed
 * account silently gets the wrong one. Making the choice explicit means the
 * administrator states it, which is exactly what was asked for.
 */
/**
 * Le premier site, quand l'administrateur le déclare en même temps que le
 * compte.
 *
 * Un sous-ensemble de ce qu'accepte `POST /api/buildings`, et volontairement :
 * l'ouverture d'un compte se fait avec ce qu'on a sous les yeux — une adresse et
 * un contact. L'état, le code postal et le rayon de géorepérage se règlent plus
 * tard, depuis la fiche du client, qui appelle la route complète.
 *
 * Pas d'ascenseurs non plus. Un appareil ne s'enregistre que lorsque ses
 * caractéristiques techniques sont relevées — voir la note sur `Elevator` — et
 * les inventer pour remplir un formulaire mettrait des valeurs fabriquées
 * derrière les seuils d'alerte et le calcul de durée de vie des pièces.
 */
const FirstBuildingSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Le nom de l'immeuble est obligatoire")
      .max(200),
    address: z
      .string()
      .trim()
      .min(1, "L'adresse de l'immeuble est obligatoire")
      .max(300),
    city: z.string().trim().min(1, "La ville est obligatoire").max(100),
    contactPerson: z
      .string()
      .trim()
      .min(1, "Le contact sur site est obligatoire")
      .max(200),
    contactEmail: z
      .string()
      .trim()
      .email("Adresse e-mail du contact invalide")
      .optional(),
    contactPhone: z.string().trim().max(50).optional(),
    slaTier: z.enum(SLA_TIERS).default("STANDARD"),
    /**
     * La position du site, telle qu'elle sera utilisée par le géorepérage des
     * pointages. Les deux ensemble ou aucune : une latitude seule place le site
     * sur un méridien, et le contrôle de distance qui s'en sert accepterait
     * alors un pointage à des milliers de kilomètres.
     */
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.latitude === undefined) === (value.longitude === undefined),
    {
      message:
        "La latitude et la longitude doivent être fournies ensemble, ou pas du tout",
      path: ["longitude"],
    }
  );

const CreateClientSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Le nom est obligatoire")
      .max(120, "Le nom ne peut pas dépasser 120 caractères"),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email("Adresse e-mail invalide")
      .max(200, "L'adresse e-mail ne peut pas dépasser 200 caractères"),
    phone: z
      .string()
      .trim()
      .max(40, "Le téléphone ne peut pas dépasser 40 caractères")
      .optional(),
    /**
     * L'adresse du client — siège, facturation — distincte de celle de ses
     * immeubles. Voir la note sur `User.address`.
     */
    address: z
      .string()
      .trim()
      .max(300, "L'adresse ne peut pas dépasser 300 caractères")
      .optional(),
    clientType: z.enum(CLIENT_TYPES, {
      errorMap: () => ({
        message: "Type de client invalide : « CONTRACTED » ou « NON_CONTRACTED »",
      }),
    }),
    /** Le premier site du client, si l'administrateur le connaît déjà. */
    building: FirstBuildingSchema.optional(),
    /**
     * Aucun mot de passe dans ce schéma, et c'est délibéré.
     *
     * Il était accepté ici jusqu'ici, ce qui laissait le bureau choisir — donc
     * choisir faible, ou réutiliser. La route en engendre un et le renvoie une
     * seule fois ; voir `src/lib/auth/passwords.ts`. Un appel qui en envoie un
     * reçoit un 400 plutôt que de le voir ignoré en silence.
     */
  })
  .strict();

/**
 * Only the contract status is editable.
 *
 * It is the one field that decides which portal an account receives, so it is
 * the one an administrator is most likely to need to correct — and, unlike a
 * name or an e-mail, changing it cannot break how the customer signs in.
 */
const UpdateClientSchema = z
  .object({
    id: z.string().trim().min(1),
    clientType: z.enum(CLIENT_TYPES),
  })
  .strict();

// ─── Projections ────────────────────────────────────────────

/**
 * Everything the admin screen shows about an account, and nothing else.
 * `passwordHash` is never selected — the safest way not to leak a field is not
 * to read it.
 */
const CLIENT_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  address: true,
  clientType: true,
  isActive: true,
  createdAt: true,
  // Shown side by side so the two categories are distinguishable at a glance
  // and not only by a badge: a contracted client with no building is a data
  // problem worth seeing, and a non-contracted one never has any.
  _count: { select: { ownedBuildings: true, technicalSheets: true } },
} as const;

// ─── GET ────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");
    const { searchParams } = new URL(request.url);

    // Optional filter, so the screen can offer "Avec contrat" / "Sans contrat"
    // as separate tabs without a second endpoint.
    const clientType = parseEnumParam(searchParams, "clientType", CLIENT_TYPES);

    const clients = await prisma.user.findMany({
      where: {
        role: "BUILDING_OWNER",
        ...(clientType ? { clientType } : {}),
      },
      select: CLIENT_SELECT,
      orderBy: [{ createdAt: "desc" }],
    });

    return jsonOk({ clients, total: clients.length });
  } catch (error) {
    return handleRouteError(error);
  }
}

// ─── POST ───────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    await requireRole("ADMIN");
    const body = await readJson(request);
    const parsed = CreateClientSchema.parse(body);

    // Checked before the insert so the caller gets a sentence naming the
    // problem. Without it the unique constraint surfaces as the generic
    // "La ressource existe déjà", which does not say which field collided.
    const existing = await prisma.user.findUnique({
      where: { email: parsed.email },
      select: { id: true },
    });
    if (existing) {
      throw conflict("Un compte utilise déjà cette adresse e-mail.");
    }

    /**
     * Engendré ici, haché, et renvoyé en clair une seule fois.
     *
     * Le hachage est calculé avant la transaction plutôt que dedans : bcrypt à
     * 12 tours prend quelques centaines de millisecondes, et les passer en
     * tenant une transaction ouverte immobilise une connexion pour rien.
     */
    const password = generateClientPassword();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    /**
     * Le compte et son premier immeuble sont créés ensemble ou pas du tout.
     *
     * Deux écritures séparées laisseraient, sur une erreur au milieu, un compte
     * client ouvert sur un parc vide — l'état exact que l'écran des clients
     * signale comme une anomalie de données, et qu'un administrateur devrait
     * alors réparer à la main sans savoir ce qui a échoué.
     */
    const client = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          name: parsed.name,
          email: parsed.email,
          passwordHash,
          phone: parsed.phone && parsed.phone.length > 0 ? parsed.phone : null,
          address:
            parsed.address && parsed.address.length > 0 ? parsed.address : null,
          // Hard-coded rather than taken from the body: this endpoint opens
          // *customer* accounts. Letting a caller pass a role would make it a
          // privilege-escalation route, since ADMIN is a role.
          role: "BUILDING_OWNER",
          clientType: parsed.clientType,
          isActive: true,
        },
        select: { id: true },
      });

      if (parsed.building) {
        await tx.building.create({
          data: {
            name: parsed.building.name,
            address: parsed.building.address,
            city: parsed.building.city,
            // The same default `POST /api/buildings` applies. Written out here
            // rather than left to the column's own default, so the two entry
            // points to the same table cannot drift apart on a value neither
            // form asks for.
            country: "DZ",
            contactPerson: parsed.building.contactPerson,
            contactEmail: parsed.building.contactEmail ?? null,
            contactPhone: parsed.building.contactPhone ?? null,
            slaTier: parsed.building.slaTier,
            latitude: parsed.building.latitude ?? null,
            longitude: parsed.building.longitude ?? null,
            ownerId: created.id,
          },
          select: { id: true },
        });
      }

      // Re-read rather than reusing the create's payload: `CLIENT_SELECT`
      // carries a `_count` of owned buildings, and the one returned by the
      // insert was computed before this transaction's building existed — the
      // response would announce a client with no site. Correct, and one query.
      return tx.user.findUniqueOrThrow({
        where: { id: created.id },
        select: CLIENT_SELECT,
      });
    });

    return jsonOk({ client, password }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}

// ─── PATCH ──────────────────────────────────────────────────

/**
 * Moves a customer between the two portals.
 *
 * An administrator who mistypes the type at creation would otherwise have no
 * way to fix it — the account would be stuck on the wrong portal with no
 * remedy short of editing the database by hand.
 *
 * The change takes effect at the customer's next sign-in: the type rides on
 * the JWT, which is issued once and not refreshed (see the note in
 * `src/lib/auth/options.ts`).
 */
export async function PATCH(request: NextRequest) {
  try {
    await requireRole("ADMIN");
    const body = await readJson(request);
    const parsed = UpdateClientSchema.parse(body);

    // Scoped to client accounts so this can never be used to touch a staff
    // row's role or contract status.
    const target = await prisma.user.findFirst({
      where: { id: parsed.id, role: "BUILDING_OWNER" },
      select: { id: true },
    });
    if (!target) {
      throw conflict("Ce compte client est introuvable.");
    }

    const client = await prisma.user.update({
      where: { id: parsed.id },
      data: { clientType: parsed.clientType },
      select: CLIENT_SELECT,
    });

    // Enveloppé comme la création, qui répond `{ client, password }`. Deux
    // formes pour la même ressource dans le même fichier, c'est la dérive qui
    // finit par faire lire `data.email` là où il faut lire `data.client.email`.
    return jsonOk({ client });
  } catch (error) {
    return handleRouteError(error);
  }
}
