/**
 * ElevatorPulse – Technician Check-in API
 *
 * POST /api/work-orders/:id/check-in – « J'ai pointé mon arrivée »
 *
 * WHAT THIS RECORDS
 * That a technician is standing on site, and when. Three things move together:
 * `arrivedAt` on the work order, the order's status to `IN_PROGRESS`, and the
 * linked incident to `IN_PROGRESS` so the customer's progress bar advances.
 *
 * WHY NOT JUST REUSE PATCH /api/work-orders
 * That route can set a status, and the technician portal already used it for
 * "Démarrer l'intervention". What it cannot express is *arrival*: `startedAt`
 * is when work began, which a technician may record from the van, and the
 * difference is precisely what a customer ringing to ask "is anyone here yet"
 * needs an answer to. It also cannot notify anyone, so a check-in would be
 * silent to the person waiting.
 *
 * Consequently this route **replaces** the portal's old start button rather
 * than sitting beside it. Two controls that both mean "I am starting" is a
 * worse interface than one that means it precisely.
 *
 * IDEMPOTENT BY PRECONDITION, NOT BY CHECK
 * The write is an `updateMany` filtered on `arrivedAt: null`. A technician
 * double-tapping a button on a phone in a machine room gets a clean 409 with
 * the time of the first tap, instead of a second arrival time that would make
 * the recorded response time meaningless. Checking first and writing second
 * would let two taps both pass the check.
 *
 * GEOFENCED
 * A check-in is refused when the device reports a position further from the
 * site than that site's radius — configured per building by an administrator,
 * 100 m when nobody has set one. Enforced here as well as in the interface:
 * a disabled button stops an honest mistake, not a hand-written request.
 * See `src/lib/geo/geofence.ts`, including why a missing coordinate is allowed
 * through rather than blocked.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  conflict,
  forbidden,
  handleRouteError,
  notFound,
  readJson,
} from "@/lib/api/http";
import { isSelfOrManager, MANAGEMENT_ROLES, OPS_ROLES, requireRole } from "@/lib/api/guard";
import { notify, notifyRoles } from "@/lib/notifications/service";
import { canTransition } from "@/lib/incidents/progress";
import { syncTechnicianStatus } from "@/lib/dispatch/auto-assign";
import {
  evaluateGeofence,
  formatDistance,
  readCoordinates,
} from "@/lib/geo/geofence";

const CheckInSchema = z
  .object({
    /**
     * Optional on purpose. A required note would mean a technician standing in
     * a doorway has to type before the customer is told anybody arrived, and
     * the field would be filled with "ok" within a week.
     */
    notes: z.string().trim().max(2000).optional(),

    /**
     * Where the device says it is, when it will say. Absent whenever the
     * browser refuses permission or cannot get a fix, which is a normal
     * outcome rather than a failure — see `evaluateGeofence`.
     */
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  })
  .strict();

/** Statuses a check-in may be recorded from. Terminal ones cannot be. */
const CHECK_IN_FROM = ["OPEN", "ASSIGNED", "IN_PROGRESS", "ON_HOLD"] as const;

type Params = { params: { id: string } };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireRole(...OPS_ROLES);

    // Tolerate an empty body: the button posts `{}` when the note is left
    // alone, and a 400 over a missing key would be a poor reason to refuse an
    // arrival.
    const raw = await request.text();
    const body = CheckInSchema.parse(raw.trim() ? JSON.parse(raw) : {});

    const workOrder = await prisma.workOrder.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        arrivedAt: true,
        assignedToId: true,
        elevatorId: true,
        elevator: {
          select: {
            elevatorCode: true,
            building: {
              select: {
                name: true,
                address: true,
                // The site's position and its configured radius, both needed
                // to decide whether this check-in is acceptable.
                latitude: true,
                longitude: true,
                geofenceRadiusM: true,
              },
            },
          },
        },
        incident: {
          select: {
            id: true,
            incidentNumber: true,
            status: true,
            clientId: true,
          },
        },
      },
    });

    if (!workOrder) {
      throw notFound(`Bon de travail introuvable : ${params.id}`);
    }

    // Same rule as PATCH: a technician may only act on their own queue.
    // Without it any signed-in user could mark arrival on any order in the
    // fleet, and the customer would be told a stranger had turned up.
    if (!isSelfOrManager(session, workOrder.assignedToId)) {
      throw forbidden("Ce bon de travail ne vous est pas affecté");
    }

    if (!CHECK_IN_FROM.includes(workOrder.status as (typeof CHECK_IN_FROM)[number])) {
      throw conflict(
        `Le bon de travail ${workOrder.orderNumber} est ${workOrder.status} : ` +
          "une arrivée ne peut plus y être pointée."
      );
    }

    if (workOrder.arrivedAt) {
      throw conflict(
        `L'arrivée a déjà été pointée sur ${workOrder.orderNumber}.`
      );
    }

    /**
     * The geofence, enforced here rather than trusted from the button.
     *
     * A disabled button is a courtesy to the technician, not a control: a POST
     * written by hand walks straight past it. Both sides run this same
     * function, so nobody is ever refused on the server for something the
     * interface would have allowed.
     *
     * A `conflict` (409) rather than a `forbidden` (403): being 300 m from the
     * site is not a question of permission — this technician is entitled to
     * this order — it is that the request cannot be honoured from where they
     * are standing. The message says how far off they are, because "trop loin"
     * without a number sends someone walking in the wrong direction.
     */
    const building = workOrder.elevator.building;
    const technicianPosition = readCoordinates(body);
    const verdict = evaluateGeofence(
      readCoordinates(building),
      technicianPosition,
      building.geofenceRadiusM
    );

    if (!verdict.allowed) {
      throw conflict(
        `Arrivée non pointée : vous êtes à ${formatDistance(verdict.distanceM)} ` +
          `de ${building.name}, au-delà du rayon de ${formatDistance(verdict.radiusM)}. ` +
          "Rapprochez-vous du chantier et réessayez."
      );
    }

    const arrivedAt = new Date();

    /**
     * One transaction for the arrival and the status it implies.
     *
     * `arrivedAt: null` in the WHERE is the idempotency guard described at the
     * top of the file; a zero count means somebody else's tap landed first.
     */
    const updated = await prisma.$transaction(async (tx) => {
      const claimed = await tx.workOrder.updateMany({
        where: { id: workOrder.id, arrivedAt: null, status: { in: [...CHECK_IN_FROM] } },
        data: {
          arrivedAt,
          checkInNotes: body.notes ?? null,
          /**
           * Written for the record, not for the decision — the verdict above
           * has already been reached. All three are null when the position
           * could not be established, which is a normal outcome rather than a
           * failure.
           */
          checkInLatitude: technicianPosition?.latitude ?? null,
          checkInLongitude: technicianPosition?.longitude ?? null,
          checkInDistanceM: verdict.distanceM,
          status: "IN_PROGRESS",
        },
      });

      if (claimed.count === 0) {
        throw conflict(
          `Un pointage a déjà été enregistré sur ${workOrder.orderNumber}.`
        );
      }

      // Only if the order had not already been started — work resumed after a
      // break keeps the time the job actually began, not the time of this
      // second visit.
      await tx.workOrder.updateMany({
        where: { id: workOrder.id, startedAt: null },
        data: { startedAt: arrivedAt },
      });

      /**
       * The customer watches the incident, not the work order, so the arrival
       * has to reach it too or the progress bar sits still while somebody is
       * on site. Advanced only when the transition table allows it: an
       * incident still at ESCALATED (its order assigned directly rather than
       * through the dispatch route) is left alone rather than forced.
       */
      const incident = workOrder.incident;
      if (incident && canTransition(incident.status, "IN_PROGRESS")) {
        await tx.incidentReport.update({
          where: { id: incident.id },
          data: { status: "IN_PROGRESS" },
        });
      }

      return tx.workOrder.findUniqueOrThrow({
        where: { id: workOrder.id },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          arrivedAt: true,
          startedAt: true,
          checkInNotes: true,
        },
      });
    });

    // ── After the commit ───────────────────────────────────────
    // Everything below is a courtesy. The arrival is recorded either way, and
    // a notification that fails must not tell the technician their check-in
    // did not happen — they are standing in the building.

    const where = `${workOrder.elevator.elevatorCode} à ${workOrder.elevator.building.name}`;

    if (workOrder.incident) {
      await notify({
        userId: workOrder.incident.clientId,
        title: "Technicien sur site",
        message: `Un technicien vient d'arriver sur place pour votre signalement ${workOrder.incident.incidentNumber} (${where}).`,
        type: "incident",
        linkUrl: "/client",
      });
    }

    await notifyRoles([...MANAGEMENT_ROLES], {
      title: `Arrivée pointée – ${workOrder.elevator.elevatorCode}`,
      message:
        `Le bon de travail ${workOrder.orderNumber} est passé en intervention sur site (${where}).` +
        (body.notes ? ` Note du technicien : ${body.notes}` : ""),
      type: "work_order",
      linkUrl: "/bons-de-travail",
    });

    // The technician is now demonstrably occupied. Derived, never fatal.
    if (workOrder.assignedToId) {
      await syncTechnicianStatus(prisma, workOrder.assignedToId);
    }

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleRouteError(error);
  }
}
