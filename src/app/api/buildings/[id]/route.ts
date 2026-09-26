/**
 * ElevatorPulse – Single Building API
 *
 * PATCH /api/buildings/:id – Update a building's site settings
 *
 * WHY ONLY THE RADIUS, FOR NOW
 * This route exists for one field. The geofence radius is the only building
 * setting an administrator needs to adjust once a site is surveyed — the
 * address, the contacts and the SLA tier are set when the building is created
 * and rarely move. Adding a general-purpose update endpoint would mean
 * accepting fields nothing yet edits, each one needing its own rules about who
 * may change it and what a valid value looks like. The schema below is
 * `.strict()`, so a field added here later is a deliberate act rather than
 * something that starts working by accident.
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
      .nullable(),
  })
  .strict();

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

    const building = await prisma.building.update({
      where: { id: params.id },
      data: { geofenceRadiusM: parsed.geofenceRadiusM },
      select: { id: true, name: true, geofenceRadiusM: true },
    });

    return NextResponse.json({ data: building });
  } catch (error) {
    return handleRouteError(error);
  }
}
