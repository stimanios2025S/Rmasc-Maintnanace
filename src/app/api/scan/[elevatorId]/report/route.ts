/**
 * Le signalement d'une panne depuis le QR public.
 *
 * POURQUOI CETTE ROUTE EST PUBLIQUE
 * La personne qui scanne le QR n'a pas de compte — c'est un gardien, un syndic
 * ou un occupant. Le guide des codes d'erreur lui a déjà donné les gestes
 * simples ; cette route est le bouton « le problème persiste ». Exiger une
 * connexion ici reviendrait à ne rien faire de la panne.
 *
 * CE QU'ELLE NE FAIT PAS
 * Elle n'ouvre aucun accès et ne crée aucun compte. Elle écrit un
 * `IncidentReport` et son bon de travail, avec le propriétaire de l'immeuble
 * comme titulaire du dossier — c'est le seul compte auquel la panne peut être
 * rattachée sans inventer une identité. Sans propriétaire, la route refuse et
 * le dit : un incident sans client ne serait visible que par le bureau, pas
 * dans le portail du client, et la promesse du QR serait à moitié tenue.
 *
 * DÉFISES
 * Un point d'écriture public est une invitation. La limitation ci-dessous est
 * par instance et ne remplace pas un pare-feu ; elle empêche le cas courant —
 * un bouton pressé dix fois — de créer dix interventions.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  handleRouteError,
  notFound,
  readJson,
} from "@/lib/api/http";
import { generateIncidentNumber, generateOrderNumber } from "@/lib/ids";
import { autoAssignIncident } from "@/lib/dispatch/auto-assign";
import { notifyRoles } from "@/lib/notifications/service";
import { sendAdminWhatsAppAlert } from "@/lib/notifications/whatsapp";
import { readCoordinates } from "@/lib/geo/geofence";
import { MANAGEMENT_ROLES } from "@/types";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoWorld } from "@/lib/demo/dataset";

export const dynamic = "force-dynamic";

// ─── Limitation de débit ────────────────────────────────────

const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX = 8;
const recentReports = new Map<string, number[]>();

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (recentReports.get(key) ?? []).filter(
    (timestamp) => now - timestamp < RATE_WINDOW_MS
  );

  if (hits.length >= RATE_MAX) {
    recentReports.set(key, hits);
    return true;
  }

  hits.push(now);
  recentReports.set(key, hits);

  // Un balayage suffit : la table ne doit pas croître avec le nombre d'adresses
  // vues depuis le démarrage.
  if (recentReports.size > 1000) {
    for (const [address, stamps] of recentReports) {
      if (stamps.every((timestamp) => now - timestamp > RATE_WINDOW_MS)) {
        recentReports.delete(address);
      }
    }
  }

  return false;
}

function clientKey(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "local";
}

// ─── Validation ─────────────────────────────────────────────

/**
 * Les quatre champs du formulaire public, plus les précisions optionnelles.
 *
 * L'appareil et son adresse viennent du QR — l'URL porte l'identifiant, et
 * l'immeuble est lu en base. Le déclarant peut toutefois préciser l'adresse
 * qu'il connaît, le type de problème, et joindre une photo ainsi que le schéma
 * annoté. Les pièces jointes sont des data URLs bornées et sont stockées sur le
 * bon de travail créé pour l'administration.
 */
const ReportSchema = z
  .object({
    firstName: z.string().trim().min(1, "Le prénom est obligatoire").max(80),
    lastName: z.string().trim().min(1, "Le nom est obligatoire").max(80),
    phone: z.string().trim().min(5, "Le téléphone est obligatoire").max(40),
    notes: z
      .string()
      .trim()
      .min(10, "Décrivez le problème en quelques mots")
      .max(2000),
    buildingAddress: z.string().trim().max(300).optional(),
    category: z.string().trim().max(80).optional(),
    photoDataUrl: z
      .string()
      .max(6_000_000)
      .regex(/^data:image\/(png|jpe?g|webp);base64,/i, "Photo invalide")
      .optional(),
    annotationDataUrl: z
      .string()
      .max(6_000_000)
      .regex(/^data:image\/(png|jpe?g|webp);base64,/i, "Schéma annoté invalide")
      .optional(),
  })
  .strict();

type ReportInput = z.infer<typeof ReportSchema>;

// ─── POST ───────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: { elevatorId: string } }
) {
  let body: ReportInput | null = null;

  try {
    if (isRateLimited(clientKey(request))) {
      return NextResponse.json(
        {
          error:
            "Trop de signalements envoyés depuis cet appareil. Réessayez dans quelques minutes ou appelez le bureau.",
        },
        { status: 429 }
      );
    }

    body = ReportSchema.parse(await readJson(request));

    const elevator = await prisma.elevator.findFirst({
      where: { id: params.elevatorId, isActive: true },
      select: {
        id: true,
        elevatorCode: true,
        building: {
          select: {
            id: true,
            name: true,
            address: true,
            city: true,
            latitude: true,
            longitude: true,
            ownerId: true,
          },
        },
      },
    });

    if (!elevator) throw notFound("Appareil introuvable.");

    /**
     * La position vient de l'immeuble désigné par le QR.
     *
     * Le scan a déjà fourni l'appareil et son adresse ; on ne demande rien de
     * plus au déclarant. Sans coordonnées d'immeuble, le point reste absent et
     * la carte s'appuie sur l'épingle du site — jamais d'invention.
     */
    const site = readCoordinates(elevator.building);
    const reported = site
      ? {
          latitude: site.latitude,
          longitude: site.longitude,
          source: "SITE" as const,
        }
      : { latitude: null, longitude: null, source: null };

    const reporter = `${body.firstName} ${body.lastName}`.trim();
    const notes = [
      body.notes,
      body.buildingAddress
        ? `Lieu / adresse de l'immeuble : ${body.buildingAddress}`
        : "",
      body.category ? `Type de problème : ${body.category}` : "",
      `Signalé par : ${reporter}`,
      `Téléphone : ${body.phone}`,
      "Signalement déposé depuis le QR public de l'appareil.",
    ]
      .filter(Boolean)
      .join("\n");

    const photoUrls = [body.photoDataUrl, body.annotationDataUrl].filter(
      (url): url is string => Boolean(url)
    );

    const created = await createIncident(elevator, notes, reported, photoUrls);

    const auto = await autoAssignIncident(created.id);
    const assignedTo = auto.assigned
      ? (auto.technician.name ?? auto.technician.id)
      : null;

    await notifyRoles([...MANAGEMENT_ROLES], {
      title: `Panne signalée par QR – ${elevator.elevatorCode}`,
      message: `${elevator.building.name} · ${reporter} · ${
        assignedTo ? `technicien affecté : ${assignedTo}` : "à affecter"
      }`,
      type: "incident",
      linkUrl: "/administration/incidents",
      /**
       * Le bon, pour que la cloche du bureau puisse dispatcher d'ici. Un
       * signalement public n'a pas d'auteur, mais il a toujours un bon — c'est
       * lui qui porte le geste d'affectation.
       */
      workOrderId: created.workOrderId ?? undefined,
    });

    await sendAdminWhatsAppAlert({
      headline: `Panne signalée par QR – ${elevator.elevatorCode}`,
      lines: [
        created.incidentNumber,
        `${elevator.building.name}, ${elevator.building.address}`,
        body.notes,
        `${reporter} · ${body.phone}`,
        assignedTo ? `Technicien affecté : ${assignedTo}` : "À affecter manuellement",
      ],
    });

    return NextResponse.json(
      {
        data: {
          id: created.id,
          incidentNumber: created.incidentNumber,
          workOrderId: created.workOrderId,
          status: created.status,
          createdAt: created.createdAt,
          assignedTo,
        },
        demo: false,
      },
      { status: 201 }
    );
  } catch (error) {
    /**
     * Mode démonstration : la panne est acquittée, pas enregistrée.
     *
     * Même règle que `POST /api/incidents` : uniquement sur une base
     * injoignable et avec `DEMO_DATA="true"`, jamais en production. La réponse
     * le signale pour que l'écran ne fasse pas croire à un enregistrement.
     */
    if (body && shouldServeDemoData(error)) {
      warnDemoFallbackOnce("POST /api/scan/[id]/report");
      const world = demoWorld();
      const demoElevator = world.elevators.find(
        (elevator) => elevator.id === params.elevatorId && elevator.isActive
      );

      if (!demoElevator) {
        return NextResponse.json(
          { error: "Appareil introuvable." },
          { status: 404 }
        );
      }

      const now = new Date();
      return NextResponse.json(
        {
          data: {
            id: `demo-scan-${now.getTime()}`,
            incidentNumber: `DEMO-${String(now.getTime()).slice(-6)}`,
            workOrderId: null,
            status: "ESCALATED",
            createdAt: now.toISOString(),
            assignedTo:
              world.users.find(
                (user) =>
                  user.role === "FIELD_TECHNICIAN" && user.status === "AVAILABLE"
              )?.name ?? null,
          },
          demo: true,
        },
        { status: 201 }
      );
    }

    return handleRouteError(error);
  }
}

interface ElevatorForReport {
  id: string;
  elevatorCode: string;
  building: {
    id: string;
    name: string;
    address: string;
    city: string;
    ownerId: string | null;
  };
}

/**
 * Écrit l'incident et son bon dans la même transaction.
 *
 * Deux références uniques sont générées ici. Une collision est improbable mais
 * pas impossible ; deux tentatives suffisent à la dissoudre sans transformer un
 * problème réel — une base qui refuse toute écriture — en apparence de
 * malchance.
 */
async function createIncident(
  elevator: ElevatorForReport,
  notes: string,
  reported: {
    latitude: number | null;
    longitude: number | null;
    source: "GPS" | "SITE" | null;
  },
  photoUrls: string[] = []
) {
  /**
   * Le titulaire, quand il existe.
   *
   * Un immeuble couvert par un contrat a un propriétaire : la panne lui est
   * rattachée et il la voit dans son portail. Un immeuble sans compte — le cas
   * « sans contrat » que le QR doit couvrir — produit un signalement public,
   * `clientId` nul, visible par le bureau et par personne d'autre.
   */
  const clientId = elevator.building.ownerId;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const workOrder = await tx.workOrder.create({
          data: {
            orderNumber: generateOrderNumber(),
            title: `Panne signalée par QR — ${elevator.elevatorCode}`,
            description: notes,
            type: "CORRECTIVE",
            priority: "HIGH",
            status: "OPEN",
            elevatorId: elevator.id,
            photoUrls,
            // Aucun compte n'est à l'origine d'un signalement public : le bon
            // n'a pas d'auteur, ce que la colonne accepte. Inventer un
            // utilisateur ferait croire que quelqu'un l'a ouvert au bureau.
            createdById: null,
            reportedLatitude: reported.latitude,
            reportedLongitude: reported.longitude,
            reportedPositionSource: reported.source,
          },
          select: { id: true },
        });

        return tx.incidentReport.create({
          data: {
            incidentNumber: generateIncidentNumber(),
            elevatorId: elevator.id,
            clientId,
            errorCodeId: null,
            status: "ESCALATED",
            isDirectTransfer: false,
            workOrderId: workOrder.id,
            notes,
            reportedLatitude: reported.latitude,
            reportedLongitude: reported.longitude,
            reportedPositionSource: reported.source,
          },
          select: {
            id: true,
            incidentNumber: true,
            status: true,
            createdAt: true,
            workOrderId: true,
          },
        });
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "P2002" && attempt === 0) continue;
      throw error;
    }
  }

  throw new Error("Impossible d'enregistrer le signalement.");
}
