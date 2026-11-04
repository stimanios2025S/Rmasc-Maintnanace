/**
 * Maintenance RMASC – Elevator Detail API
 *
 * GET /api/elevators/[id] – Specs, components, telemetry, predictive scores,
 *                          recent work orders and alerts for one unit.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { forbidden, handleRouteError, notFound } from "@/lib/api/http";
import { elevatorScopeFor, OPS_ROLES, requireRole } from "@/lib/api/guard";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoElevatorDetail } from "@/lib/demo/responses";

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");

    // Scoped by id rather than looked up by id and then checked, so an
    // out-of-portfolio id is indistinguishable from a nonexistent one — the
    // previous `findUnique` let any BUILDING_OWNER read any unit in the
    // fleet, including its telemetry, work orders and alert history, simply
    // by walking the cuid space.
    const elevator = await prisma.elevator.findFirst({
      where: { id: params.id, ...elevatorScopeFor(session) },
      include: {
        building: true,
        components: {
          where: { isActive: true },
          orderBy: { remainingUsefulLife: "asc" },
        },
        latestTelemetry: true,
        telemetryStreams: {
          orderBy: { timestamp: "desc" },
          take: 60,
        },
        predictiveScores: {
          // `createdAt` is only set on the first score for a component;
          // subsequent analyses update the row in place.
          orderBy: { updatedAt: "desc" },
        },
        workOrders: {
          orderBy: { createdAt: "desc" },
          take: 10,
          include: { assignedTo: { select: { name: true } } },
        },
        alerts: {
          orderBy: { createdAt: "desc" },
          take: 10,
        },
      },
    });

    if (!elevator) throw notFound(`Ascenseur introuvable : ${params.id}`);

    /**
     * Ce que la fiche d'un appareil peut montrer, et à qui.
     *
     * Un code d'accès d'immeuble ou de local technique n'est pas une donnée de
     * catalogue : il ouvre une porte. Il n'est donc jamais renvoyé à un compte
     * client — même propriétaire de l'immeuble — et un technicien ne le reçoit
     * que s'il a un bon de travail sur cet appareil. C'est la traduction
     * serveur de « le technicien ne voit que ce qui le concerne » : masquer la
     * carte dans l'interface ne protégerait rien, la réponse JSON resterait
     * lisible dans l'onglet réseau.
     */
    const role = session.user.role;
    const isOwner = role === "BUILDING_OWNER";
    const isTechnician = role === "FIELD_TECHNICIAN";

    let hasJobOnSite = true;
    if (isTechnician) {
      hasJobOnSite =
        (await prisma.workOrder.count({
          where: { elevatorId: elevator.id, assignedToId: session.user.id },
        })) > 0;

      /**
       * Un technicien n'ouvre pas la fiche d'un appareil qui ne lui est pas
       * affecté — même en tapant l'URL à la main. La réponse est un 403, pas
       * une fiche vidée de ses données sensibles : une page qui existe à
       * moitié laisse croire que l'accès est ouvert.
       */
      if (!hasJobOnSite) {
        throw forbidden(
          "Cet appareil ne fait pas partie de vos interventions."
        );
      }
    }

    const canSeeSiteDetails = !isOwner;

    /**
     * Les trois derniers signalements de l'appareil, pour le technicien qui
     * intervient dessus. Lus sans le cloisonnement `incidentScopeFor` : la
     * condition est ici le bon de travail sur *cet* appareil, vérifiée
     * ci-dessus, et non l'historique d'affectation de chaque incident.
     */
    const recentIncidents = canSeeSiteDetails
      ? await prisma.incidentReport.findMany({
          where: { elevatorId: elevator.id },
          orderBy: { createdAt: "desc" },
          take: 3,
          select: {
            id: true,
            incidentNumber: true,
            status: true,
            notes: true,
            createdAt: true,
            resolvedAt: true,
            errorCode: { select: { code: true, title: true } },
          },
        })
      : [];

    return NextResponse.json({
      data: {
        ...elevator,
        building: elevator.building
          ? {
              ...elevator.building,
              accessCode: canSeeSiteDetails ? elevator.building.accessCode : null,
            }
          : elevator.building,
        recentIncidents,
      },
    });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/elevators/[id]");
      const detail = demoElevatorDetail(params.id);
      // A real 404 for an id that is not in the fixture either, so the demo
      // data does not invent units the caller asked for by name.
      if (!detail) return handleRouteError(notFound(`Ascenseur introuvable : ${params.id}`));
      // Le jeu de démonstration n'a pas d'historique de signalements : la clé
      // existe quand même, pour que l'écran n'ait pas à distinguer les deux
      // modes.
      return NextResponse.json({ data: { ...detail, recentIncidents: [] } });
    }
    return handleRouteError(error);
  }
}
