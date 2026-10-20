/**
 * Maintenance RMASC – Elevators API
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
import { createWorkOrderWithUniqueNumber } from "@/lib/work-orders/service";

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
    /**
     * La marque d'origine, pour un appareil repris d'un autre constructeur.
     *
     * `brand` est une énumération fermée : un Otis repris porte `OTHER`, et le
     * champ ci-dessous dit « Otis » — la seule information qu'un technicien
     * demande avant d'ouvrir l'armoire.
     */
    originBrand: z.string().trim().max(80).optional(),
    /**
     * Reprise d'un appareil tiers.
     *
     * Demande explicitement le bon de visite d'état des lieux. Ce n'est pas
     * déduit de la présence d'une marque d'origine : un appareil de notre parc
     * peut aussi en porter une, et un audit ne doit pas naître d'une écriture
     * approximative dans un champ libre.
     */
    takeover: z.boolean().optional(),
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
  .strict()
  .refine((value) => !value.takeover || Boolean(value.originBrand?.trim()), {
    message:
      "La marque d'origine est obligatoire pour la reprise d'un appareil tiers",
    path: ["originBrand"],
  });

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
    const session = await requireRole(...MANAGEMENT_ROLES);
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
        originBrand: parsed.originBrand?.trim() || null,
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

    /**
     * La reprise d'un appareil tiers ouvre un bon de visite d'état des lieux.
     *
     * Sans lui, l'appareil entrerait dans le parc sans qu'aucun technicien ne
     * l'ait regardé : ses caractéristiques seraient celles qu'un formulaire a
     * déclarées, pas celles de la machine. Le bon est le document qui manque —
     * il est créé ici, ouvert, pour que le bureau puisse l'affecter.
     *
     * Une erreur ici ne défait pas la fiche : elle est déjà en base, et un
     * appareil sans bon se rattrape depuis le tableau des bons. Lever à ce
     * stade ferait croire à l'appelant que rien n'a été écrit.
     */
    let auditWorkOrder: { id: string; orderNumber: string } | null = null;
    if (parsed.takeover) {
      const brandLabel = parsed.originBrand?.trim() || elevator.brand;
      try {
        const order = await createWorkOrderWithUniqueNumber(
          {
            title: `Inspection état des lieux – ${brandLabel} ${parsed.model} (${elevator.elevatorCode})`,
            description: [
              `Visite d'inspection avant reprise en maintenance de l'appareil ${elevator.elevatorCode}.`,
              "",
              "L'appareil n'est pas encore du parc RMASC : ce bon établit son état avant",
              "toute prise en charge. Relever la marque d'origine, le modèle, le numéro de",
              "série, l'état de la gaine et des organes de sécurité, et consigner les",
              "réserves éventuelles. Le matricule RMASC n'est attribué qu'à la validation",
              "de cette visite.",
            ].join("\n"),
            type: "INSPECTION",
            priority: "MEDIUM",
            status: "OPEN",
            elevatorId: elevator.id,
            createdById: session.user.id,
          },
          "AUD"
        );
        auditWorkOrder = {
          id: order.id,
          orderNumber: order.orderNumber,
        };
      } catch (error) {
        console.error(
          "[elevators] le bon d'inspection de reprise n'a pas pu être créé",
          error
        );
      }
    }

    return NextResponse.json(
      { data: elevator, auditWorkOrder },
      { status: 201 }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
