/**
 * ElevatorPulse – Single Incident API
 *
 * GET   /api/incidents/:id  – one incident
 * PATCH /api/incidents/:id  – dispatch a technician, or advance the status
 *
 * WHY THIS DOESN'T CALL /api/work-orders/dispatch
 * The work-order dispatch route owns assigning an order. This route assigns a
 * *technician to an incident*, which has to move two rows — the incident and
 * the work order it owns — in one transaction. Reusing the other route would
 * mean either two non-atomic writes (an incident marked dispatched against an
 * order that is still open, or the reverse) or calling our own HTTP API from
 * the server. The transaction below is the smaller of the three evils, and
 * the shared precondition — `isOpenStatus` — is still imported from the
 * work-order service rather than reimplemented.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";
import {
  badRequest,
  conflict,
  forbidden,
  handleRouteError,
  notFound,
  readJson,
} from "@/lib/api/http";
import {
  buildingScopeFor,
  isSelfOrManager,
  MANAGEMENT_ROLES,
  OPS_ROLES,
  requireRole,
} from "@/lib/api/guard";
import { notify } from "@/lib/notifications/service";
import { allowedTransitions, canTransition } from "@/lib/incidents/progress";
import { isOpenStatus } from "@/lib/work-orders/service";
import { DISPATCHABLE_TECHNICIAN_STATUSES, INCIDENT_STATUSES } from "@/types";
import type { Session } from "next-auth";

const INCIDENT_SELECT = {
  id: true,
  incidentNumber: true,
  status: true,
  isDirectTransfer: true,
  notes: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
  elevator: {
    select: {
      id: true,
      elevatorCode: true,
      building: { select: { id: true, name: true, address: true } },
    },
  },
  errorCode: { select: { id: true, code: true, title: true } },
  client: { select: { id: true, name: true, email: true, phone: true } },
  technician: { select: { id: true, name: true, email: true, phone: true } },
  workOrder: {
    select: { id: true, orderNumber: true, status: true, priority: true },
  },
} satisfies Prisma.IncidentReportSelect;

const PatchSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("dispatch"),
      technicianId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("status"),
      status: z.enum(INCIDENT_STATUSES),
      notes: z.string().trim().max(4000).optional(),
    })
    .strict(),
]);

type Params = { params: { id: string } };

// ─── GET ────────────────────────────────────────────────────

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");

    const incident = await prisma.incidentReport.findFirst({
      where: { id: params.id, ...incidentScopeFor(session) },
      select: INCIDENT_SELECT,
    });
    if (!incident) throw notFound(`Incident introuvable : ${params.id}`);

    return NextResponse.json({ data: incident });
  } catch (error) {
    return handleRouteError(error);
  }
}

// ─── PATCH ──────────────────────────────────────────────────

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const body = PatchSchema.parse(await readJson(request));

    if (body.action === "dispatch") {
      return await dispatch(params.id, body.technicianId);
    }
    return await advanceStatus(params.id, body.status, body.notes);
  } catch (error) {
    return handleRouteError(error);
  }
}

// ─── Dispatch ───────────────────────────────────────────────

async function dispatch(incidentId: string, technicianId: string) {
  // Dispatching is a management act. A technician cannot pull an incident onto
  // themselves, and a client certainly cannot choose who attends.
  await requireRole(...MANAGEMENT_ROLES);

  const incident = await prisma.incidentReport.findUnique({
    where: { id: incidentId },
    select: {
      id: true,
      incidentNumber: true,
      status: true,
      workOrderId: true,
      elevator: { select: { elevatorCode: true } },
    },
  });
  if (!incident) throw notFound(`Incident introuvable : ${incidentId}`);

  if (incident.status === "RESOLVED_BY_CLIENT") {
    throw conflict(
      `L'incident ${incident.incidentNumber} a été résolu par le client et ne nécessite aucun technicien.`
    );
  }
  if (incident.status === "CLOSED") {
    throw conflict(`L'incident ${incident.incidentNumber} est déjà clôturé.`);
  }

  const technician = await prisma.user.findFirst({
    // The status filter is not duplicated here — a technician who cannot be
    // dispatched is fetched anyway, so the refusal below can say *why* rather
    // than reporting them as though they did not exist.
    where: { id: technicianId, role: "FIELD_TECHNICIAN", isActive: true },
    select: { id: true, name: true, status: true },
  });
  if (!technician) {
    throw badRequest(
      `L'utilisateur ${technicianId} n'est pas un technicien de terrain actif.`
    );
  }

  /**
   * An OFF_DUTY or ON_LEAVE technician cannot be sent to a job.
   *
   * The roster hides them, but hiding a row is a convenience, not a rule: the
   * dispatch dialog holds its list from when it opened, and a request can be
   * made by hand. The rule lives here, on the write, and the message names the
   * reason so a dispatcher who pulled the dialog open an hour ago sees why the
   * person they picked is no longer offered.
   */
  if (!DISPATCHABLE_TECHNICIAN_STATUSES.includes(technician.status)) {
    const reason = technician.status === "ON_LEAVE" ? "en congé" : "hors service";
    throw badRequest(
      `${technician.name ?? technicianId} est ${reason} et ne peut pas être affecté.`
    );
  }

  /**
   * The incident and its work order move together, under serializable
   * isolation, so two dispatchers clicking at once cannot both assign the
   * same incident and leave one technician holding a job they were not told
   * about. `updateMany` with the status as a precondition is the guard: if the
   * incident moved on, zero rows match and the write is abandoned.
   */
  const updated = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const claimed = await tx.incidentReport.updateMany({
          where: {
            id: incidentId,
            status: { in: ["ESCALATED", "TECHNICIAN_ASSIGNED"] },
          },
          data: {
            technicianId: technician.id,
            status: "TECHNICIAN_ASSIGNED",
          },
        });

        if (claimed.count === 0) {
          throw conflict(
            `L'incident ${incident.incidentNumber} a été modifié par une autre requête.`
          );
        }

        // The work order is the technician's actual queue entry, so it has to
        // carry the assignment too — otherwise the job appears on the
        // incident board as dispatched but never reaches /technician.
        if (incident.workOrderId) {
          const order = await tx.workOrder.findUnique({
            where: { id: incident.workOrderId },
            select: { id: true, status: true, scheduledDate: true },
          });

          if (order && isOpenStatus(order.status)) {
            await tx.workOrder.update({
              where: { id: order.id },
              data: {
                assignedToId: technician.id,
                status: "ASSIGNED",
                scheduledDate: order.scheduledDate ?? new Date(),
              },
            });
          }
        }

        return tx.incidentReport.findUniqueOrThrow({
          where: { id: incidentId },
          select: INCIDENT_SELECT,
        });
      },
      { isolationLevel: "Serializable" }
    )
  );

  // After the commit — a courtesy, never a precondition.
  await notify({
    userId: technician.id,
    title: `Nouvel incident affecté – ${incident.elevator.elevatorCode}`,
    message: `L'incident ${incident.incidentNumber} vous a été affecté.`,
    type: "incident",
    linkUrl: "/technicien",
  });

  return NextResponse.json({ data: updated });
}

// ─── Status transition ──────────────────────────────────────

async function advanceStatus(
  incidentId: string,
  next: (typeof INCIDENT_STATUSES)[number],
  notes?: string
) {
  const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");

  const incident = await prisma.incidentReport.findUnique({
    where: { id: incidentId },
    select: {
      id: true,
      incidentNumber: true,
      status: true,
      clientId: true,
      technicianId: true,
      workOrderId: true,
      elevator: { select: { elevatorCode: true, buildingId: true } },
    },
  });
  if (!incident) throw notFound(`Incident introuvable : ${incidentId}`);

  await assertMayTransition(session, incident, next);

  if (!canTransition(incident.status, next)) {
    const allowed = allowedTransitions(incident.status);
    throw badRequest(
      allowed.length === 0
        ? `L'incident ${incident.incidentNumber} est ${incident.status} et ne peut plus changer de statut.`
        : `Impossible de faire passer l'incident ${incident.incidentNumber} de ${incident.status} à ${next}. ` +
          `Transitions autorisées : ${allowed.join(", ")}.`
    );
  }

  const isTerminal = next === "CLOSED" || next === "RESOLVED_BY_CLIENT";

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.incidentReport.update({
      where: { id: incidentId },
      data: {
        status: next,
        ...(notes ? { notes } : {}),
        resolvedAt: isTerminal ? new Date() : null,
      },
      select: INCIDENT_SELECT,
    });

    // Closing the incident closes the job that was raised for it. Leaving the
    // work order open would keep it on the technician's queue forever.
    if (next === "CLOSED" && incident.workOrderId) {
      const order = await tx.workOrder.findUnique({
        where: { id: incident.workOrderId },
        select: { id: true, status: true },
      });
      if (order && isOpenStatus(order.status)) {
        await tx.workOrder.update({
          where: { id: order.id },
          data: { status: "COMPLETED", completedAt: new Date() },
        });
      }
    }

    return row;
  });

  // Tell the reporter their fault was dealt with. The client account is the
  // only audience for this — staff already see the status on the board.
  if (isTerminal) {
    await notify({
      userId: incident.clientId,
      title: `Incident ${incident.incidentNumber} clôturé`,
      message: `Votre signalement pour ${incident.elevator.elevatorCode} a été traité.`,
      type: "incident",
      linkUrl: "/client",
    });
  }

  return NextResponse.json({ data: updated });
}

/**
 * Who may move this incident, and to where.
 *
 * The transition table in `progress.ts` says what is *legal*; this says who
 * is *allowed*, which is a different question and belongs with the session.
 */
async function assertMayTransition(
  session: Session,
  incident: {
    status: string;
    clientId: string;
    technicianId: string | null;
    elevator: { buildingId: string };
  },
  next: (typeof INCIDENT_STATUSES)[number]
) {
  const role = session.user.role;

  if (role === "BUILDING_OWNER") {
    // A client may only make its own single decision: confirm it fixed the
    // problem. It cannot assign, start, or close work.
    if (next !== "RESOLVED_BY_CLIENT") {
      throw forbidden("Un propriétaire d'immeuble ne peut marquer comme résolu que son propre incident.");
    }
    if (incident.clientId !== session.user.id) {
      throw forbidden("Vous ne pouvez mettre à jour que les incidents que vous avez signalés.");
    }
    // Belt and braces: the incident must sit on a building they own.
    const building = await prisma.building.findFirst({
      where: { id: incident.elevator.buildingId, ...buildingScopeFor(session) },
      select: { id: true },
    });
    if (!building) throw forbidden("Cet incident est hors de votre portefeuille.");
    return;
  }

  if (role === "FIELD_TECHNICIAN") {
    // A technician may progress the job they were given, and nothing else.
    if (!isSelfOrManager(session, incident.technicianId)) {
      throw forbidden("Cet incident ne vous est pas affecté.");
    }
    if (next === "RESOLVED_BY_CLIENT") {
      throw forbidden("Seul le client à l'origine de l'incident peut le résoudre lui-même.");
    }
    return;
  }

  // ADMIN / MAINTENANCE_MANAGER — the transition table is the only constraint.
}

// ─── Scoping ────────────────────────────────────────────────

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

// ─── Retry ──────────────────────────────────────────────────

/** Retries once on a serialization failure (Prisma P2034). */
async function withSerializableRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isSerializationFailure = (error as { code?: string })?.code === "P2034";
      if (!isSerializationFailure || attempt >= 1) throw error;
      console.warn("[incidents] serialization conflict, retrying");
    }
  }
}
