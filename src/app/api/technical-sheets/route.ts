/**
 * ElevatorPulse – Fiche Technique API
 *
 * GET  /api/technical-sheets   – list the sheets the caller may read
 * POST /api/technical-sheets   – record a completed « Fiche Technique »
 *
 * WHO MAY DO WHAT
 * A BUILDING_OWNER has no contract with us, which is exactly why this form
 * exists: the sheet is often the first thing we ever receive about an
 * installation. So any signed-in account may *submit* one, and `clientId` is
 * always the caller — a sheet belongs to the account that filled it in, and
 * nothing in the request body can point it at somebody else.
 *
 * Reading is asymmetric. Staff (OPS_ROLES) see every sheet, because the
 * maintenance team is who completes the technical columns on site. A
 * BUILDING_OWNER sees only their own — the same portfolio rule the rest of the
 * API applies, and the reason this file never trusts a `clientId` off the wire.
 *
 * WHAT IS VALIDATED, AND WHY IT IS SO LITTLE
 * Four fields are required; the other forty-odd are optional. That split is
 * deliberate and documented at length in `src/lib/technical-sheets/fields.ts`:
 * a client filling this in from the machine room knows the address and the
 * capacity, and does not know the braking resistor's resistance in ohms.
 * Requiring the full breakdown would mean never receiving a sheet at all. The
 * schema below is generated from that catalogue, so the two cannot drift.
 */

import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  conflict,
  handleRouteError,
  jsonOk,
  notFound,
  parsePagination,
  readJson,
} from "@/lib/api/http";
import { elevatorScopeFor, requireSession, OPS_ROLES } from "@/lib/api/guard";
import {
  ALL_FIELD_NAMES,
  OPTIONAL_FIELD_NAMES,
  REQUIRED_FIELD_NAMES,
  labelForField,
} from "@/lib/technical-sheets/fields";

// ─── Schemas ────────────────────────────────────────────────

/**
 * Built from the field catalogue rather than written out by hand.
 *
 * The four required names come from `REQUIRED_FIELD_NAMES` and every other
 * column from `OPTIONAL_FIELD_NAMES`, so adding a field to the catalogue
 * (and the Prisma model) is the only edit needed to accept it here. The
 * messages name the field by its French label, taken from the same catalogue,
 * so a validation error reads "Client est obligatoire" rather than naming a
 * database column.
 */
const shape: Record<string, z.ZodTypeAny> = {};

for (const name of REQUIRED_FIELD_NAMES) {
  shape[name] = z
    .string()
    .trim()
    .min(1, `${labelForField(name)} est obligatoire`)
    .max(200, `${labelForField(name)} ne peut pas dépasser 200 caractères`);
}

for (const name of OPTIONAL_FIELD_NAMES) {
  shape[name] = z.string().trim().max(300).optional();
}

const CreateTechnicalSheetSchema = z
  .object({
    ...shape,
    /**
     * The unit this sheet describes, when the client knows which one it is.
     * Optional because a non-contract client often has no elevator record
     * registered yet — the whole point of the form is to create that knowledge.
     */
    elevatorId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

// ─── Normalisation ──────────────────────────────────────────

/**
 * Turns the parsed body into a column map.
 *
 * An empty optional input arrives as `""` from a form whose fields were left
 * alone, and `""` is not the same thing as "not answered" — storing it would
 * make "we asked and they did not know" indistinguishable from "we never asked"
 * in the read-only view. Blank becomes NULL, and the four required fields are
 * already guaranteed non-blank by the schema above.
 */
function toColumns(input: Record<string, unknown>): Record<string, string | null> {
  const columns: Record<string, string | null> = {};
  for (const name of ALL_FIELD_NAMES) {
    const raw = input[name];
    const value = typeof raw === "string" ? raw.trim() : "";
    columns[name] = value.length > 0 ? value : null;
  }
  return columns;
}

// ─── GET ────────────────────────────────────────────────────

/**
 * The relations every response needs. `client` is what the staff view shows as
 * "submitted by"; `elevator` links the sheet back to a unit when one was given.
 */
const SHEET_INCLUDE = {
  client: { select: { id: true, name: true, email: true, phone: true } },
  elevator: {
    select: {
      id: true,
      elevatorCode: true,
      model: true,
      building: { select: { id: true, name: true, city: true } },
    },
  },
} satisfies Prisma.TechnicalSheetInclude;

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();
    const { searchParams } = new URL(request.url);
    const { page, limit, skip } = parsePagination(searchParams);

    // Staff read the whole board; a client reads their own submissions. The
    // role test is the only thing standing between a customer and every other
    // customer's address, so it is an allow-list rather than a deny-list.
    const role = session.user.role;
    const isStaff = !!role && OPS_ROLES.includes(role);
    const where: Prisma.TechnicalSheetWhereInput = isStaff
      ? {}
      : { clientId: session.user.id };

    const [sheets, total] = await Promise.all([
      prisma.technicalSheet.findMany({
        where,
        include: SHEET_INCLUDE,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.technicalSheet.count({ where }),
    ]);

    return jsonOk({ sheets, total, page, limit });
  } catch (error) {
    return handleRouteError(error);
  }
}

// ─── POST ───────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    const body = await readJson(request);
    const parsed = CreateTechnicalSheetSchema.parse(body);

    const { elevatorId, ...fieldValues } = parsed;

    // A supplied elevator must be one the caller can already see. Validating it
    // by scope rather than by existence is what stops a client from attaching
    // their sheet to another customer's unit by guessing an id.
    if (elevatorId) {
      const visible = await prisma.elevator.findFirst({
        where: { id: elevatorId, ...elevatorScopeFor(session) },
        select: { id: true },
      });
      if (!visible) throw notFound("Ascenseur introuvable");
    }

    // One sheet per unit. Checked here so the client gets a sentence it can act
    // on instead of the generic "already exists" that a P2002 would produce.
    if (elevatorId) {
      const existing = await prisma.technicalSheet.findUnique({
        where: { elevatorId },
        select: { id: true },
      });
      if (existing) {
        throw conflict(
          "Une fiche technique existe déjà pour cet ascenseur. " +
            "Contactez-nous pour la mettre à jour."
        );
      }
    }

    // The column map is built from the catalogue, so its keys match the model at
    // runtime but not in TypeScript's eyes — it only sees
    // `Record<string, string | null>`. The cast is the price of deriving the
    // field list from data rather than spelling out forty-odd assignments here;
    // the catalogue in `@/lib/technical-sheets/fields` is what keeps the map and
    // the model in step, and a name that drifts is rejected by `.strict()` on
    // the way in.
    const data = {
      // Never from the request body: a sheet belongs to the account that filled
      // it in. See the note at the top of this file.
      clientId: session.user.id,
      elevatorId: elevatorId ?? null,
      ...toColumns(fieldValues),
    } as unknown as Prisma.TechnicalSheetUncheckedCreateInput;

    const sheet = await prisma.technicalSheet.create({
      data,
      include: SHEET_INCLUDE,
    });

    return jsonOk(sheet, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
