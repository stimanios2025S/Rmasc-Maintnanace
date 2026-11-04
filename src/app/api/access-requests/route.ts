/**
 * Maintenance RMASC – les demandes d'accès déposées depuis un QR.
 *
 * POST /api/access-requests   public — déposer une demande
 * GET  /api/access-requests   bureau — lire le registre
 *
 * POURQUOI LE POST EST PUBLIC
 * La personne qui scanne le QR n'a aucun compte : c'est précisément pourquoi
 * elle demande un accès. Exiger une session rendrait la page inutile.
 *
 * CE QUE LE POST NE FAIT PAS
 * Il n'ouvre aucun accès, ne modifie aucun immeuble et ne crée aucun compte. Il
 * écrit une ligne `PENDING` et s'arrête. Le bureau décide ensuite — la demande
 * n'est qu'une demande.
 *
 * PAS DE LIMITATION DE DÉBIT, ET C'EST UNE LIMITE CONNUE
 * Un endpoint public peut être soumis à des dépôts répétés. La duplication est
 * déjà refusée (même appareil, même adresse, tant qu'une demande attend), et
 * les champs sont bornés. Un vrai quota demanderait un stockage partagé que ce
 * produit n'a pas — il est noté comme dette, pas comme acquis.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import {
  badRequest,
  conflict,
  handleRouteError,
  parseEnumParam,
  readJson,
} from "@/lib/api/http";
import { requireRole } from "@/lib/api/guard";
import { ACCESS_REQUEST_STATUSES, ADMIN_ROLES } from "@/types";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoAccessRequests } from "@/lib/demo/registers";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

const CreateSchema = z
  .object({
    elevatorId: z.string().trim().min(1, "L'appareil est obligatoire"),
    firstName: z.string().trim().min(1, "Le prénom est obligatoire").max(80),
    lastName: z.string().trim().min(1, "Le nom est obligatoire").max(80),
    phone: z.string().trim().min(5, "Le téléphone est obligatoire").max(40),
    email: z
      .string()
      .trim()
      .email("Adresse e-mail invalide")
      .max(200),
    /** Le rôle déclaré : « gardien », « syndic », « exploitant »… */
    role: z.string().trim().min(1, "Le rôle est obligatoire").max(80),
    message: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  try {
    const body = CreateSchema.parse(await readJson(request));

    /**
     * L'appareil doit exister et être actif. C'est la seule vérification qui
     * empêche une page publique d'écrire des demandes rattachées à rien.
     */
    const elevator = await prisma.elevator.findUnique({
      where: { id: body.elevatorId },
      select: { id: true, isActive: true },
    });
    if (!elevator || !elevator.isActive) {
      throw badRequest("Appareil introuvable ou hors service.");
    }

    /**
     * Une demande en attente par appareil et par adresse. Sans cela, un double
     * clic — ou une page rechargée — produirait deux lignes que le bureau
     * devrait rapprocher à la main.
     */
    const existing = await prisma.accessRequest.findFirst({
      where: {
        elevatorId: body.elevatorId,
        email: body.email.toLowerCase(),
        status: "PENDING",
      },
      select: { id: true },
    });
    if (existing) {
      throw conflict(
        "Une demande est déjà en attente pour cette adresse sur cet appareil. " +
          "Le bureau va la traiter."
      );
    }

    const created = await prisma.accessRequest.create({
      data: {
        elevatorId: body.elevatorId,
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone,
        /** Normalisée : deux demandes du même compte ne doivent pas différer
         *  par une majuscule. */
        email: body.email.toLowerCase(),
        role: body.role,
        message: body.message ?? null,
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
      },
    });

    return NextResponse.json(
      { data: created, message: "Demande enregistrée. Le bureau va la traiter." },
      { status: 201 }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

const LIST_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  email: true,
  role: true,
  message: true,
  status: true,
  decidedAt: true,
  createdAt: true,
  elevator: {
    select: {
      id: true,
      elevatorCode: true,
      building: { select: { id: true, name: true, city: true } },
    },
  },
  decidedBy: { select: { id: true, name: true } },
  createdUser: { select: { id: true, name: true, email: true } },
} satisfies Prisma.AccessRequestSelect;

export async function GET(request: NextRequest) {
  try {
    await requireRole(...ADMIN_ROLES);

    const status = parseEnumParam(
      request.nextUrl.searchParams,
      "status",
      ACCESS_REQUEST_STATUSES
    );

    const rows = await prisma.accessRequest.findMany({
      where: status ? { status } : {},
      select: LIST_SELECT,
      /** Les demandes en attente d'abord, puis la plus ancienne : c'est la
       *  question que pose le registre — qu'est-ce qui attend ? */
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    });

    // `{ data: [...] }` comme les autres registres — et non `jsonOk`, qui
    // envelopperait la liste une seconde fois et ferait lire `data.data` à
    // l'écran.
    return NextResponse.json({ data: rows, total: rows.length });
  } catch (error) {
    /**
     * Sans base, le registre se lit dans la fixture.
     *
     * La page répondait 503 et affichait « Le registre a répondu 503 » : un
     * écran de démonstration qui ne montre aucune demande ne permet ni de lire
     * le parcours, ni d'essayer une décision. Le repli est en lecture
     * seulement ; l'écriture est acquittée par la route de décision.
     */
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/access-requests");
      const raw = request.nextUrl.searchParams.get("status");
      const demoStatus =
        raw && (ACCESS_REQUEST_STATUSES as readonly string[]).includes(raw)
          ? raw
          : null;
      const rows = demoAccessRequests(demoStatus);
      return NextResponse.json({
        data: rows,
        total: rows.length,
        demo: true,
      });
    }
    return handleRouteError(error);
  }
}
