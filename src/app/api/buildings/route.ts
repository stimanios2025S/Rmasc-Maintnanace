/**
 * ElevatorPulse – Buildings API
 *
 * GET    /api/buildings     – List buildings with elevator counts and health
 * POST   /api/buildings     – Create a new building
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { z } from "zod";
import {
  handleRouteError,
  notFound,
  readJson,
} from "@/lib/api/http";
import {
  buildingScopeFor,
  MANAGEMENT_ROLES,
  OPS_ROLES,
  requireRole,
} from "@/lib/api/guard";
import { OWNER_ELIGIBLE_ROLES, SLA_TIERS } from "@/types";

const CreateBuildingSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(200),
    address: z.string().min(1, "Address is required").max(300),
    city: z.string().min(1, "City is required").max(100),
    state: z.string().max(100).optional(),
    zipCode: z.string().max(20).optional(),
    country: z.string().max(100).default("US"),
    contactPerson: z.string().min(1, "Contact person is required").max(200),
    contactEmail: z.string().email("Invalid email").optional(),
    contactPhone: z.string().max(50).optional(),
    slaTier: z.enum(SLA_TIERS).default("STANDARD"),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    ownerId: z.string().min(1).optional(),
  })
  .strict();

export async function GET() {
  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");

    // Filter the nested collection the same way as the count, so
    // `elevatorCount` and `statusBreakdown` describe the same set of units.
    // The scope also keeps a BUILDING_OWNER from listing other customers,
    // whose site contact name, email and phone are all in this payload.
    const buildings = await prisma.building.findMany({
      where: buildingScopeFor(session),
      include: {
        _count: { select: { elevators: { where: { isActive: true } } } },
        elevators: {
          where: { isActive: true },
          select: { status: true, overallHealth: true },
        },
      },
      orderBy: { name: "asc" },
    });

    const data = buildings.map((building) => ({
      id: building.id,
      name: building.name,
      address: building.address,
      city: building.city,
      state: building.state,
      slaTier: building.slaTier,
      contactPerson: building.contactPerson,
      contactEmail: building.contactEmail,
      contactPhone: building.contactPhone,
      latitude: building.latitude,
      longitude: building.longitude,
      elevatorCount: building._count.elevators,
      avgHealth:
        building.elevators.length > 0
          ? Math.round(
              building.elevators.reduce((sum, e) => sum + e.overallHealth, 0) /
                building.elevators.length
            )
          : 0,
      statusBreakdown: building.elevators.reduce<Record<string, number>>(
        (acc, elevator) => {
          acc[elevator.status] = (acc[elevator.status] ?? 0) + 1;
          return acc;
        },
        {}
      ),
    }));

    return NextResponse.json({ data });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireRole(...MANAGEMENT_ROLES);
    const parsed = CreateBuildingSchema.parse(await readJson(request));

    if (parsed.ownerId) {
      // Only roles that can actually hold a portfolio. This previously
      // accepted any `USER_ROLES` member, so a FIELD_TECHNICIAN or a
      // MAINTENANCE_MANAGER could be recorded as the owner — and ownership
      // is what the BUILDING_OWNER read scoping keys off.
      const owner = await prisma.user.findFirst({
        where: {
          id: parsed.ownerId,
          isActive: true,
          role: { in: [...OWNER_ELIGIBLE_ROLES] },
        },
        select: { id: true },
      });
      if (!owner) {
        throw notFound(
          `Owner not found or not eligible to own a building: ${parsed.ownerId}`
        );
      }
    }

    const building = await prisma.building.create({
      data: {
        name: parsed.name,
        address: parsed.address,
        city: parsed.city,
        state: parsed.state,
        zipCode: parsed.zipCode,
        country: parsed.country,
        contactPerson: parsed.contactPerson,
        contactEmail: parsed.contactEmail,
        contactPhone: parsed.contactPhone,
        slaTier: parsed.slaTier,
        latitude: parsed.latitude,
        longitude: parsed.longitude,
        ownerId: parsed.ownerId,
      },
    });

    return NextResponse.json({ data: building }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
