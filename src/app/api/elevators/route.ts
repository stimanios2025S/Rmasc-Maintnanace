/**
 * ElevatorPulse – Elevators API
 *
 * GET    /api/elevators     – List elevators with latest telemetry
 * POST   /api/elevators     – Register a new elevator
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { z } from "zod";
import {
  conflict,
  handleRouteError,
  notFound,
  readJson,
} from "@/lib/api/http";
import {
  elevatorScopeFor,
  MANAGEMENT_ROLES,
  OPS_ROLES,
  requireRole,
} from "@/lib/api/guard";
import {
  CONTROLLER_TYPES,
  ELEVATOR_BRANDS,
  MOTOR_TYPES,
} from "@/types";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoElevatorList } from "@/lib/demo/responses";

const CreateElevatorSchema = z
  .object({
    elevatorCode: z
      .string()
      .min(1, "Le code d'ascenseur est obligatoire")
      .max(50)
      .regex(
        /^[A-Za-z0-9_-]+$/,
        "Le code ne peut contenir que des lettres, des chiffres, - et _"
      ),
    buildingId: z.string().min(1, "L'immeuble est obligatoire"),
    brand: z.enum(ELEVATOR_BRANDS),
    model: z.string().min(1, "Le modèle est obligatoire").max(100),
    serialNumber: z.string().max(100).optional(),
    installationDate: z.string().datetime().optional(),
    motorType: z.enum(MOTOR_TYPES),
    maxPayloadKg: z
      .number()
      .positive("La charge doit être supérieure à zéro")
      .max(10000),
    controllerType: z.enum(CONTROLLER_TYPES),
    floorsServed: z.number().int().positive().max(200),
  })
  .strict();

export async function GET() {
  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");

    const elevators = await prisma.elevator.findMany({
      // A BUILDING_OWNER is scoped to its own portfolio. The fleet-wide list
      // it used to receive leaked every other customer's building name,
      // address and site contacts.
      where: elevatorScopeFor(session),
      include: {
        building: { select: { id: true, name: true, address: true } },
        latestTelemetry: true,
        _count: {
          select: {
            workOrders: {
              where: { status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS"] } },
            },
            alerts: { where: { isAcknowledged: false, resolvedAt: null } },
          },
        },
      },
      // `ElevatorStatus` is declared OPERATIONAL -> OFFLINE and Postgres
      // sorts enums by declaration order, so `asc` lists healthy units first.
      orderBy: [{ status: "asc" }, { elevatorCode: "asc" }],
    });

    return NextResponse.json({ data: elevators });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/elevators");
      return NextResponse.json({ data: demoElevatorList() });
    }
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireRole(...MANAGEMENT_ROLES);
    const parsed = CreateElevatorSchema.parse(await readJson(request));

    const building = await prisma.building.findFirst({
      where: { id: parsed.buildingId, isActive: true },
      select: { id: true },
    });
    if (!building) {
      throw notFound(`Immeuble introuvable : ${parsed.buildingId}`);
    }

    const duplicate = await prisma.elevator.findUnique({
      where: { elevatorCode: parsed.elevatorCode },
      select: { id: true },
    });
    if (duplicate) {
      throw conflict(
        `Code d'ascenseur déjà enregistré : ${parsed.elevatorCode}`
      );
    }

    const elevator = await prisma.elevator.create({
      data: {
        elevatorCode: parsed.elevatorCode,
        buildingId: parsed.buildingId,
        brand: parsed.brand,
        model: parsed.model,
        serialNumber: parsed.serialNumber,
        installationDate: parsed.installationDate
          ? new Date(parsed.installationDate)
          : undefined,
        motorType: parsed.motorType,
        maxPayloadKg: parsed.maxPayloadKg,
        controllerType: parsed.controllerType,
        floorsServed: parsed.floorsServed,
      },
    });

    return NextResponse.json({ data: elevator }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
