/**
 * Maintenance RMASC – création manuelle d'une fiche technique.
 *
 * POST /api/technical-sheets/manual
 *
 * POURQUOI CETTE ROUTE EST SÉPARÉE
 * La route `POST /api/technical-sheets` est celle du formulaire client : elle
 * exige les quatre champs que le demandeur connaît, et elle refuse un compte
 * sous contrat. Le bureau, lui, prend parfois la demande au téléphone et ne
 * dispose que du nom, de l'immeuble, de l'adresse et du téléphone. Les deux
 * flux n'ont ni les mêmes champs ni les mêmes règles ; les faire cohabiter
 * dans un schéma unique aurait affaibli la validation du formulaire client.
 *
 * CE QUE LA FICHE PORTE
 * `clientId` est le compte du personnel qui l'a créée : la fiche est une
 * demande interne, pas encore un compte client. L'identité visible reste
 * `clientName` / `buildingName` / `contactPhone`, saisie ici. Les mesures
 * techniques absentes sont marquées « À renseigner » et seront complétées par
 * la route PATCH après la visite.
 *
 * RÉSERVÉ À L'ADMINISTRATEUR
 * C'est un acte d'ouverture de dossier prospect, pas une complétion terrain.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  handleRouteError,
  jsonOk,
  readJson,
} from "@/lib/api/http";
import { requireRole } from "@/lib/api/guard";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import type { Prisma } from "@prisma/client";

const ManualSheetSchema = z
  .object({
    clientName: z
      .string()
      .trim()
      .min(1, "Le nom du client est obligatoire")
      .max(200),
    buildingName: z
      .string()
      .trim()
      .min(1, "Le nom de l'immeuble est obligatoire")
      .max(200),
    location: z
      .string()
      .trim()
      .min(1, "L'adresse est obligatoire")
      .max(300),
    contactPhone: z
      .string()
      .trim()
      .min(1, "Le téléphone est obligatoire")
      .max(50),
  })
  .strict();

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

export async function POST(request: Request) {
  let submitted: z.infer<typeof ManualSheetSchema> | null = null;

  try {
    const session = await requireRole("ADMIN");
    const parsed = ManualSheetSchema.parse(await readJson(request));
    submitted = parsed;

    const sheet = await prisma.technicalSheet.create({
      data: {
        /**
         * La fiche appartient au compte qui l'a ouverte. Ce n'est pas le
         * prospect lui-même : il n'a pas encore de compte, et en fabriquer un
         * avec une adresse inventée créerait une identité de connexion que
         * personne n'a demandée. Les champs visibles de la demande sont ceux
         * saisis ci-dessous.
         */
        clientId: session.user.id,
        clientName: parsed.clientName,
        buildingName: parsed.buildingName,
        location: parsed.location,
        contactPhone: parsed.contactPhone,
        // Les deux mesures encore inconnues à l'ouverture du dossier. Elles
        // sont modifiables par la route PATCH dès la visite.
        weightCapacity: "À renseigner",
        numberOfFloors: "À renseigner",
      },
      include: SHEET_INCLUDE,
    });

    return jsonOk({ sheet }, 201);
  } catch (error) {
    if (submitted && shouldServeDemoData(error)) {
      warnDemoFallbackOnce("POST /api/technical-sheets/manual");
      const now = new Date().toISOString();
      return NextResponse.json(
        {
          data: {
            sheet: {
              id: `demo-sheet-${Date.now()}`,
              elevatorId: null,
              clientId: "demo-admin",
              ...submitted,
              weightCapacity: "À renseigner",
              numberOfFloors: "À renseigner",
              client: {
                id: "demo-admin",
                name: "Administrateur",
                email: "admin@elevatorpulse.com",
                phone: null,
              },
              elevator: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          demo: true,
        },
        { status: 201 }
      );
    }
    return handleRouteError(error);
  }
}
