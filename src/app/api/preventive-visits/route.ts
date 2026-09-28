/**
 * Maintenance RMASC – Demandes d'entretien (« Démarrage Entretien »)
 *
 * POST /api/preventive-visits – a contracted client books a periodic review
 *
 * WHY THIS IS A ROUTE OF ITS OWN
 * `POST /api/incidents` is the customer's other write path, and it could have
 * carried a `type` field instead. It was rejected because the two requests
 * differ in every respect that matters downstream:
 *
 *  - An incident describes a *fault* and names an error code. A review has no
 *    fault and no code, and forcing the client through a fault form to request
 *    a routine visit would produce a record asserting a problem that does not
 *    exist.
 *  - An incident is urgent by default; it escalates, auto-dispatches to the
 *    least-busy engineer, and raises a CORRECTIVE order. A review is planned
 *    work: it raises a PREVENTIVE order that stays OPEN for the office to
 *    schedule. Nothing should be dispatched at the moment of the request.
 *  - The contract gate applies to one of them only, and a gate buried inside a
 *    route that also serves the ungated path is a gate somebody will widen by
 *    accident.
 *
 * A client's « Démarrage Maintenance » needs no route here: it is the existing
 * incident wizard, untouched.
 *
 * THE CONTRACT IS READ FROM THE DATABASE, NOT FROM THE SESSION
 * The client type rides on the JWT, which is issued once at sign-in and never
 * refreshed (see `src/lib/auth/options.ts` and the note on PATCH
 * /api/clients). Authorising a *paid* entitlement off that token would leave a
 * customer whose contract was ended this morning still booking reviews until
 * they happened to sign out. The row is one query away, so it is read here.
 *
 * The check itself is `isNonContractedClient`, the same predicate the portals
 * branch on — so the screen that offers the button and the route that honours
 * it can never disagree about who holds a contract.
 *
 * Note what that predicate tests: the *caller's own account*, never the
 * elevator's. Staff therefore pass it, which is intended — the gate exists to
 * stop a customer self-serving a paid entitlement, not to stop the office
 * booking a visit on a customer's behalf after a phone call.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  conflict,
  forbidden,
  handleRouteError,
  jsonOk,
  notFound,
  readJson,
} from "@/lib/api/http";
import { elevatorScopeFor, requireRole } from "@/lib/api/guard";
import { createWorkOrderWithUniqueNumber, OPEN_WORK_ORDER_STATUSES } from "@/lib/work-orders/service";
import { notifyRoles } from "@/lib/notifications/service";
import { isNonContractedClient, MANAGEMENT_ROLES, OPS_ROLES } from "@/types";

const CreatePreventiveVisitSchema = z
  .object({
    elevatorId: z.string().min(1),
    /**
     * Optional note from the client — access details, a preferred day, a
     * caretaker's name. Deliberately not required: nothing about booking a
     * routine visit should demand typing, and the office confirms the date by
     * phone anyway.
     */
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  try {
    // Staff as well as the client, mirroring `POST /api/incidents`. The office
    // takes these requests over the phone, and an administrator opening
    // `/client` — which the middleware deliberately leaves ungated so they can
    // see what a customer sees — must not be offered a button that 403s. It
    // grants nothing new: `POST /api/work-orders` already admits `OPS_ROLES`
    // to create an order, and `elevatorScopeFor` widens the same way here.
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");
    const body = CreatePreventiveVisitSchema.parse(await readJson(request));

    // The entitlement, read from the row rather than trusted from the token.
    const caller = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true, clientType: true, name: true, email: true },
    });
    if (!caller) throw notFound("Compte introuvable.");

    if (isNonContractedClient(caller)) {
      throw forbidden(
        "La demande d'entretien est réservée aux clients sous contrat. " +
          "Remplissez la fiche technique de votre installation pour ouvrir un dossier."
      );
    }

    // Scoped lookup, so a unit outside the caller's portfolio is reported as
    // absent rather than as forbidden — the caller learns nothing about
    // whether the id they invented exists.
    const elevator = await prisma.elevator.findFirst({
      where: { id: body.elevatorId, ...elevatorScopeFor(session) },
      select: {
        id: true,
        elevatorCode: true,
        building: { select: { name: true, address: true, city: true } },
      },
    });
    if (!elevator) throw notFound(`Ascenseur introuvable : ${body.elevatorId}`);

    /**
     * One outstanding review request per unit.
     *
     * A button on a phone is easy to press twice, and two identical preventive
     * orders for the same lift are worse than one: the office schedules the
     * first, closes it, and the second resurfaces weeks later as an overdue
     * job nobody raised. The client is told plainly rather than being shown a
     * duplicate they cannot cancel.
     */
    const outstanding = await prisma.workOrder.findFirst({
      where: {
        elevatorId: elevator.id,
        type: "PREVENTIVE",
        status: { in: [...OPEN_WORK_ORDER_STATUSES] },
      },
      select: { orderNumber: true },
    });
    if (outstanding) {
      throw conflict(
        `Une demande d'entretien est déjà en cours pour ${elevator.elevatorCode} ` +
          `(bon ${outstanding.orderNumber}). Nous vous contactons pour fixer la date.`
      );
    }

    /**
     * `OPEN`, and nobody assigned.
     *
     * The order deliberately does not auto-dispatch, unlike an escalation. A
     * periodic review is planned work with a date to agree, and handing it to
     * the least-busy engineer the second it is requested would put a routine
     * visit in the same queue as breakdowns. The office schedules it; a
     * dispatcher who wants to assign it now can, from the board.
     */
    const workOrder = await createWorkOrderWithUniqueNumber(
      {
        title: `Demande d'entretien – ${elevator.elevatorCode}`,
        description: buildDescription(elevator, caller.name, body.notes),
        type: "PREVENTIVE",
        priority: "MEDIUM",
        status: "OPEN",
        elevatorId: elevator.id,
        // The client's own account owns the record of why this exists.
        createdById: session.user.id,
      },
      "ENT"
    );

    // After the commit, and never fatal: the order is real either way. See the
    // rule at the top of `src/lib/notifications/service.ts`.
    await notifyRoles([...MANAGEMENT_ROLES], {
      title: `Demande d'entretien – ${elevator.elevatorCode}`,
      message:
        `${caller.name} demande une visite de révision pour ` +
        `${elevator.elevatorCode} à ${elevator.building.name}. ` +
        `Bon ${workOrder.orderNumber} à planifier.`,
      type: "work_order",
      linkUrl: "/bons-de-travail",
    });

    return jsonOk(
      {
        id: workOrder.id,
        orderNumber: workOrder.orderNumber,
        elevatorCode: elevator.elevatorCode,
      },
      201
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * The stored description of a review request.
 *
 * Persisted on the row, so the wording is part of the record rather than a
 * presentation detail — a technician opening this order in six months reads
 * exactly what the client asked for.
 */
function buildDescription(
  elevator: {
    elevatorCode: string;
    building: { name: string; address: string; city: string };
  },
  requesterName: string,
  notes?: string
): string {
  const lines = [
    "Visite de révision périodique demandée depuis l'espace client.",
    `Ascenseur : ${elevator.elevatorCode}`,
    `Site : ${elevator.building.name}, ${elevator.building.address}, ${elevator.building.city}`,
    `Demandeur : ${requesterName}`,
  ];
  if (notes) {
    lines.push("", "Précisions du client :", notes);
  }
  return lines.join("\n");
}
