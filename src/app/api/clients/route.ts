/**
 * ElevatorPulse – client account administration.
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
import { CLIENT_TYPES } from "@/types";

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
    password: z
      .string()
      .min(8, "Le mot de passe doit contenir au moins 8 caractères")
      .max(200, "Le mot de passe ne peut pas dépasser 200 caractères"),
    phone: z
      .string()
      .trim()
      .max(40, "Le téléphone ne peut pas dépasser 40 caractères")
      .optional(),
    clientType: z.enum(CLIENT_TYPES, {
      errorMap: () => ({
        message: "Type de client invalide : « CONTRACTED » ou « NON_CONTRACTED »",
      }),
    }),
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

    const client = await prisma.user.create({
      data: {
        name: parsed.name,
        email: parsed.email,
        passwordHash: await bcrypt.hash(parsed.password, BCRYPT_ROUNDS),
        phone: parsed.phone && parsed.phone.length > 0 ? parsed.phone : null,
        // Hard-coded rather than taken from the body: this endpoint opens
        // *customer* accounts. Letting a caller pass a role would make it a
        // privilege-escalation route, since ADMIN is a role.
        role: "BUILDING_OWNER",
        clientType: parsed.clientType,
        isActive: true,
      },
      select: CLIENT_SELECT,
    });

    return jsonOk(client, 201);
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

    return jsonOk(client);
  } catch (error) {
    return handleRouteError(error);
  }
}
