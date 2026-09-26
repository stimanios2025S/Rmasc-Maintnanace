/**
 * ElevatorPulse – Client Incident API
 *
 * GET  /api/incidents   – list incidents visible to the caller
 * POST /api/incidents   – record a client-reported fault
 *
 * This is the endpoint behind the client portal, and the only write path in
 * the application a BUILDING_OWNER may use. It is therefore the only place
 * where the caller's own input decides what work the company does — hence the
 * scoping below and the transition rules in `src/lib/incidents/progress.ts`.
 *
 * ESCALATION CREATES A WORK ORDER
 * A fault the customer could not clear becomes a real job, linked one-to-one
 * and raised in the same transaction. Doing it here rather than leaving it to
 * a dispatcher means an escalated fault cannot sit unnoticed on a board — by
 * the time the client's "non résolu" request returns, the work exists.
 */

import { NextRequest, NextResponse } from "next/server";
import type { Session } from "next-auth";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";
import {
  badRequest,
  handleRouteError,
  notFound,
  parseEnumParam,
  parsePagination,
  readJson,
} from "@/lib/api/http";
import {
  buildingScopeFor,
  elevatorScopeFor,
  MANAGEMENT_ROLES,
  OPS_ROLES,
  requireRole,
} from "@/lib/api/guard";
import { generateIncidentNumber, generateOrderNumber } from "@/lib/ids";
import { notifyRoles } from "@/lib/notifications/service";
import { autoAssignIncident } from "@/lib/dispatch/auto-assign";
import { sendAdminSmsAlert } from "@/lib/notifications/sms";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoIncidents } from "@/lib/demo/responses";
import { INCIDENT_STATUSES } from "@/types";

// ─── Schemas ────────────────────────────────────────────────

/**
 * The two outcomes the client portal can submit.
 *
 * Drawn from `INCIDENT_STATUSES` so the list cannot drift from the Prisma
 * enum, then narrowed: the wizard reports a fault and either has fixed it or
 * has not. It cannot open an incident already assigned to a technician, and
 * it cannot close one that was never reported.
 */
const ClientOutcomeSchema = z.enum(["RESOLVED_BY_CLIENT", "ESCALATED"]);

const CreateIncidentSchema = z
  .object({
    elevatorId: z.string().min(1),
    errorCodeId: z.string().min(1).optional(),
    status: ClientOutcomeSchema.default("ESCALATED"),
    /**
     * True when the fault came from the emergency button rather than the
     * wizard. Drives the work order's type and priority, and is surfaced on
     * the admin board so a dispatcher can tell the two apart at a glance.
     */
    isDirectTransfer: z.boolean().default(false),
    notes: z.string().trim().max(4000).optional(),
    audioNoteUrl: z.string().trim().max(2000).optional(),
  })
  .strict();

type CreateIncidentInput = z.infer<typeof CreateIncidentSchema>;

const INCIDENT_SELECT = {
  id: true,
  incidentNumber: true,
  status: true,
  isDirectTransfer: true,
  notes: true,
  audioNoteUrl: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
  elevator: {
    select: {
      id: true,
      elevatorCode: true,
      model: true,
      building: { select: { id: true, name: true, address: true, city: true } },
    },
  },
  errorCode: { select: { id: true, code: true, title: true } },
  /**
   * `clientType` is carried so the board can say whether the reporter is a
   * contracted customer.
   *
   * Read, never stored. An earlier draft added a `contractStatus` column to
   * `IncidentReport` — a denormalised copy of this value — which would have
   * been wrong the first time an account changed contract, with nothing to
   * reconcile it against. The relation is one join away and cannot drift.
   */
  client: {
    select: { id: true, name: true, email: true, phone: true, clientType: true },
  },
  technician: { select: { id: true, name: true, email: true, phone: true } },
  workOrder: {
    select: { id: true, orderNumber: true, status: true, priority: true },
  },
} satisfies Prisma.IncidentReportSelect;

// ─── GET ────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");
    const { searchParams } = request.nextUrl;
    const { page, limit, skip } = parsePagination(searchParams);

    const status = parseEnumParam(searchParams, "status", INCIDENT_STATUSES);
    const elevatorId = searchParams.get("elevatorId");

    const where: Prisma.IncidentReportWhereInput = {
      ...incidentScopeFor(session),
      ...(status ? { status } : {}),
      ...(elevatorId ? { elevatorId } : {}),
      ...(searchParams.get("mine") === "true"
        ? { clientId: session.user.id }
        : {}),
    };

    const [total, incidents] = await Promise.all([
      prisma.incidentReport.count({ where }),
      prisma.incidentReport.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: INCIDENT_SELECT,
      }),
    ]);

    return NextResponse.json({ data: incidents, total, page, limit });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/incidents");
      const { searchParams } = new URL(request.url);
      return NextResponse.json(
        demoIncidents({ status: searchParams.get("status") })
      );
    }
    return handleRouteError(error);
  }
}

// ─── POST ───────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");
    const body = CreateIncidentSchema.parse(await readJson(request));

    // The elevator must be inside the caller's portfolio. Scoping the lookup
    // rather than checking ownership afterwards means an out-of-portfolio id
    // is reported as "not found", which tells the caller nothing about whether
    // the unit exists.
    const elevator = await prisma.elevator.findFirst({
      where: { id: body.elevatorId, ...elevatorScopeFor(session) },
      select: {
        id: true,
        elevatorCode: true,
        building: { select: { name: true, address: true } },
      },
    });
    if (!elevator) throw notFound(`Ascenseur introuvable : ${body.elevatorId}`);

    if (body.errorCodeId) {
      const code = await prisma.errorCode.findFirst({
        where: { id: body.errorCodeId, isActive: true },
        select: { id: true },
      });
      if (!code) throw badRequest(`Code d'erreur inconnu : ${body.errorCodeId}`);
    }

    const isEscalation = body.status === "ESCALATED";

    /**
     * The incident and its work order are written together.
     *
     * Both carry a table-unique human reference generated from a six-character
     * random suffix, so a collision is vanishingly unlikely but not
     * impossible. If either insert trips P2002 the whole transaction is
     * retried once with fresh numbers, rather than leaving an escalated
     * incident with no work order behind it.
     */
    const created = await withNumberCollisionRetry(() =>
      prisma.$transaction(async (tx) => {
        let workOrderId: string | null = null;

        if (isEscalation) {
          const workOrder = await tx.workOrder.create({
            data: {
              orderNumber: generateOrderNumber(
                body.isDirectTransfer ? "EMRG" : undefined
              ),
              title: buildWorkOrderTitle(elevator.elevatorCode, body),
              description: buildWorkOrderDescription(elevator, body),
              type: body.isDirectTransfer ? "EMERGENCY" : "CORRECTIVE",
              priority: body.isDirectTransfer ? "CRITICAL" : "HIGH",
              status: "OPEN",
              elevatorId: elevator.id,
              // The reporter owns the record of why this order exists. Using
              // the system creator here (as the telemetry ingestion path does)
              // would discard the only link back to the person who reported it.
              createdById: session.user.id,
            },
            select: { id: true },
          });
          workOrderId = workOrder.id;
        }

        return tx.incidentReport.create({
          data: {
            incidentNumber: generateIncidentNumber(),
            elevatorId: elevator.id,
            clientId: session.user.id,
            errorCodeId: body.errorCodeId ?? null,
            status: body.status,
            isDirectTransfer: body.isDirectTransfer,
            workOrderId,
            notes: body.notes ?? null,
            audioNoteUrl: body.audioNoteUrl ?? null,
            resolvedAt:
              body.status === "RESOLVED_BY_CLIENT" ? new Date() : null,
          },
          select: INCIDENT_SELECT,
        });
      })
    );

    /**
     * An escalation is dispatched straight away, before anybody is told.
     *
     * The order matters. Announcing "this needs a technician" and *then*
     * finding one produces two notifications that contradict each other, and a
     * manager who reads the first and dispatches by hand creates exactly the
     * double assignment `assignIncidentToTechnician`'s serializable claim
     * exists to prevent. Assigning first lets the notification say what
     * actually happened.
     *
     * This never throws. With no engineer reachable the incident simply stays
     * ESCALATED on the board awaiting manual dispatch, which is where it would
     * have been before this existed — see `src/lib/dispatch/auto-assign.ts`.
     */
    const auto = isEscalation ? await autoAssignIncident(created.id) : null;

    /**
     * Notification goes out after the commit, never inside the transaction.
     * A courtesy that fails must not roll back an escalation — see the note
     * at the top of `src/lib/notifications/service.ts`.
     */
    if (isEscalation) {
      const assignedTo = auto?.assigned
        ? auto.technician.name ?? auto.technician.id
        : null;

      await notifyRoles([...MANAGEMENT_ROLES], {
        title: body.isDirectTransfer
          ? `Urgence – ${elevator.elevatorCode}`
          : `Incident escaladé – ${elevator.elevatorCode}`,
        message: assignedTo
          ? `${buildNotificationMessage(elevator, body)} Technicien affecté automatiquement : ${assignedTo}.`
          : `${buildNotificationMessage(elevator, body)} Aucun technicien disponible — affectation manuelle requise.`,
        type: "incident",
        linkUrl: "/administration/incidents",
      });

      /**
       * Out of band, because the point of an escalation is that whoever needs
       * to see it may not be looking at a dashboard.
       *
       * Note what this currently does: with no gateway configured it writes
       * the message to the server log and delivers nothing. That is stated
       * plainly here and warned about at boot rather than implied — see the
       * module header in `src/lib/notifications/sms.ts`.
       */
      await sendAdminSmsAlert({
        headline: `Incident escaladé – ${elevator.elevatorCode}`,
        lines: [
          created.incidentNumber,
          `${elevator.building.name}, ${elevator.building.address}`,
          assignedTo
            ? `Technicien affecté : ${assignedTo}`
            : "Aucun technicien disponible",
        ],
      });
    }

    // The response reflects the final state rather than the state at commit:
    // after an automatic dispatch the incident is no longer ESCALATED, and
    // returning the pre-assignment row would have the caller's own next read
    // contradict the answer it was just given.
    return NextResponse.json(
      { data: auto?.assigned ? auto.incident : created },
      { status: 201 }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

// ─── Scoping ────────────────────────────────────────────────

/**
 * The `IncidentReport` filter a session may read.
 *
 * A BUILDING_OWNER is confined to incidents on its own portfolio, expressed
 * through the elevator relation so it reuses the same boundary as every other
 * owner-accessible read.
 *
 * A FIELD_TECHNICIAN sees only incidents assigned to them — narrower than the
 * fleet they can otherwise inspect. An incident carries the reporter's
 * free-text description of a fault in their own building, and that is not
 * something every technician needs to read.
 */
function incidentScopeFor(session: Session): Prisma.IncidentReportWhereInput {
  const role = session.user.role;

  if (role === "BUILDING_OWNER") {
    return { elevator: { building: buildingScopeFor(session) } };
  }
  if (role === "FIELD_TECHNICIAN") {
    return { technicianId: session.user.id };
  }
  return {};
}

// ─── Copy builders ──────────────────────────────────────────

/**
 * The title the work order raised from a client report is stored under.
 *
 * Persisted on the row, so translating it changes what future orders record.
 * Nothing looks a work order up by this string — the incident links to its
 * order by id — so the change cannot orphan an existing record.
 */
function buildWorkOrderTitle(
  elevatorCode: string,
  body: CreateIncidentInput
): string {
  const prefix = body.isDirectTransfer
    ? "Signalement client urgent"
    : "Signalement client";
  return `${prefix} – ${elevatorCode}`;
}

function buildWorkOrderDescription(
  elevator: {
    elevatorCode: string;
    building: { name: string; address: string };
  },
  body: CreateIncidentInput
): string {
  const lines = [
    "Signalé par l'immeuble via l'espace client.",
    `Ascenseur : ${elevator.elevatorCode}`,
    `Site : ${elevator.building.name}, ${elevator.building.address}`,
  ];
  if (body.isDirectTransfer) {
    lines.push(
      "Déposé via le bouton d'urgence (transfert direct, sans tri préalable)."
    );
  }
  if (body.notes) {
    lines.push("", "Description du signalant :", body.notes);
  }
  return lines.join("\n");
}

function buildNotificationMessage(
  elevator: { elevatorCode: string; building: { name: string } },
  body: CreateIncidentInput
): string {
  const where = `${elevator.elevatorCode} à ${elevator.building.name}`;
  if (body.isDirectTransfer) {
    return `Assistance d'urgence demandée pour ${where}. Le signalant n'a pas pu décrire la panne — intervenez ou rappelez-le.`;
  }
  return `Une panne signalée pour ${where} n'a pas pu être résolue par le client et nécessite un technicien.`;
}

// ─── Retry ──────────────────────────────────────────────────

/**
 * Runs `fn`, retrying once when a unique constraint on a generated reference
 * collides. Only P2002 is retried; anything else is a real failure and is
 * rethrown untouched.
 */
async function withNumberCollisionRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isCollision = (error as { code?: string })?.code === "P2002";
      if (!isCollision || attempt >= 1) throw error;
      console.warn("[incidents] reference collision, retrying");
    }
  }
}
