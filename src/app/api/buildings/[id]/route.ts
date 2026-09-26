/**
 * ElevatorPulse – Single Building API
 *
 * PATCH /api/buildings/:id – Update a building's site settings
 *
 * WHAT CAN BE CHANGED HERE, AND WHY ONLY THIS
 * Two things: where the site is, and how close a technician must be for a
 * check-in to count. Both are facts an administrator establishes once, on site
 * or from a map, and neither can be derived from anything else in the system —
 * the address does not contain a position, and a radius that suits an
 * industrial estate is wrong for an apartment block. Everything else about a
 * building (its name, its SLA tier, its contacts) is set when it is created and
 * is not edited from a map.
 *
 * The schema is `.strict()`, so a field added here later is a deliberate act
 * rather than something that starts working by accident.
 *
 * WHY THE COORDINATES MUST ARRIVE TOGETHER
 * A latitude with no longitude is not half a position, it is a corrupt one: it
 * would be stored, read back by the map as "no coordinates", and leave a site
 * that looks configured in the database and absent from every screen. The rule
 * is enforced in the schema rather than in the handler so the caller gets a 400
 * naming the problem, not a silently ignored field.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError, notFound, readJson } from "@/lib/api/http";
import { MANAGEMENT_ROLES, requireRole } from "@/lib/api/guard";
import {
  MAX_GEOFENCE_RADIUS_M,
  MIN_GEOFENCE_RADIUS_M,
} from "@/lib/geo/geofence";
import type { Prisma } from "@prisma/client";

const UpdateBuildingSchema = z
  .object({
    /**
     * Null clears the value, returning the site to the fleet default.
     *
     * Worth allowing explicitly: a radius set once for a one-off job should be
     * removable, and without this the only way back to the default would be a
     * database edit. The bounds mirror the ones `effectiveRadiusM` enforces on
     * read, so the application never stores a figure it will then ignore —
     * a value that is silently discarded on every read is worse than a
     * rejected one, because nothing tells the administrator it did not take.
     */
    geofenceRadiusM: z
      .number()
      .int("Le rayon doit être un nombre entier de mètres")
      .min(
        MIN_GEOFENCE_RADIUS_M,
        `Le rayon ne peut pas être inférieur à ${MIN_GEOFENCE_RADIUS_M} m`
      )
      .max(
        MAX_GEOFENCE_RADIUS_M,
        `Le rayon ne peut pas dépasser ${MAX_GEOFENCE_RADIUS_M} m`
      )
      .nullable()
      .optional(),

    /** The site's position, placed on the map. Both or neither. */
    latitude: z
      .number()
      .min(-90, "Latitude hors limites")
      .max(90, "Latitude hors limites")
      .nullable()
      .optional(),
    longitude: z
      .number()
      .min(-180, "Longitude hors limites")
      .max(180, "Longitude hors limites")
      .nullable()
      .optional(),
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
  )
  .refine(
    (value) =>
      value.geofenceRadiusM !== undefined ||
      value.latitude !== undefined,
    {
      message: "Aucun champ à mettre à jour",
      path: [],
    }
  );

type Params = { params: { id: string } };

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    await requireRole(...MANAGEMENT_ROLES);
    const parsed = UpdateBuildingSchema.parse(await readJson(request));

    // Checked before writing so a bad id reads as "introuvable" rather than as
    // a Prisma P2025 surfacing through the generic handler.
    const existing = await prisma.building.findUnique({
      where: { id: params.id },
      select: { id: true },
    });

    if (!existing) {
      throw notFound(`Immeuble introuvable : ${params.id}`);
    }

    /**
     * Built field by field rather than passing the parsed object through.
     *
     * `Prisma.update` treats an explicit `undefined` as "leave alone", which is
     * what is wanted, but it also means a caller that omits `geofenceRadiusM`
     * must not have it written as null. Constructing the data explicitly makes
     * that impossible to get wrong, and states plainly which columns this route
     * is allowed to touch.
     */
    const data: Prisma.BuildingUpdateInput = {};

    if (parsed.geofenceRadiusM !== undefined) {
      data.geofenceRadiusM = parsed.geofenceRadiusM;
    }
    if (parsed.latitude !== undefined) {
      data.latitude = parsed.latitude;
      data.longitude = parsed.longitude ?? null;
    }

    const building = await prisma.building.update({
      where: { id: params.id },
      data,
      select: {
        id: true,
        name: true,
        latitude: true,
        longitude: true,
        geofenceRadiusM: true,
      },
    });

    return NextResponse.json({ data: building });
  } catch (error) {
    return handleRouteError(error);
  }
}
