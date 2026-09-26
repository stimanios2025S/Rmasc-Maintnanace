/**
 * Automatic dispatch — choosing who attends without a human picking.
 *
 * WHY THIS EXISTS, GIVEN THE CODEBASE ARGUED AGAINST IT
 * `src/components/admin/dispatch-modal.tsx` makes the case for a deliberate
 * dialog, and that case has not stopped being true: an escalated incident is
 * one a customer could not clear themselves, and the emergency button arrives
 * with no fault description at all. What changed is the volume. Every report
 * the wizard escalates now sits on the board until somebody opens the modal,
 * and the board is only read during working hours. An incident raised on a
 * Friday evening sat untouched until Monday for no better reason than that
 * nobody had clicked.
 *
 * So the automatic path is the *default*, not the replacement. The modal
 * stays, still pre-selecting the least-loaded engineer, and a dispatcher who
 * disagrees can reassign — which is the arrangement the owner asked for:
 * automatic with a manual fallback. The decision is now made by default and
 * overruled by exception, rather than not made at all.
 *
 * THE RULE
 * Least-loaded, from the same roster the dialog shows. Since the alternative
 * to assigning is not "leave it for a human" but "leave it indefinitely", the
 * least-bad engineer is better than no engineer, and the workload ordering
 * means the second-choice is at most one job behind the first.
 *
 * A failure here is never a failure of the report. By the time this runs the
 * incident and its work order are committed and the customer has been told
 * their fault was recorded; the incident simply stays ESCALATED for manual
 * dispatch, which is exactly where it would have been without this module.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { conflict, notFound } from "@/lib/api/http";
import { notify } from "@/lib/notifications/service";
import {
  DISPATCHABLE_TECHNICIAN_STATUSES,
} from "@/types";
import type { TechnicianStatus } from "@/types";
import { isOpenStatus } from "@/lib/work-orders/service";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

/**
 * Work a technician is currently holding.
 *
 * Matches the definition `GET /api/technicians` counts with, on purpose: the
 * dispatch dialog orders its list "least-loaded first" and pre-selects the
 * top row, so if this module ranked differently, the technician the dialog
 * recommends and the one the automatic path picks would disagree — and the
 * discrepancy would look like a bug in whichever one the dispatcher trusted.
 *
 * `OPEN_WORK_ORDER_STATUSES` from the work-order service is deliberately not
 * reused: it includes `OPEN`, and an order cannot be OPEN *and* assigned, so
 * that entry would never match and would only imply the two lists agree when
 * they do not.
 */
const OPEN_ASSIGNMENT_STATUSES = ["ASSIGNED", "IN_PROGRESS", "ON_HOLD"] as const;

// ─── The projection ─────────────────────────────────────────

/**
 * What a caller gets back after an incident is dispatched.
 *
 * Lives here rather than beside either route because both the manual dispatch
 * route and the automatic path return the same thing, and the client board
 * renders one row shape. `satisfies` rather than a cast: a field renamed in
 * the schema becomes a compile error here instead of `undefined` at runtime.
 */
export const INCIDENT_DISPATCH_SELECT = {
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
      model: true,
      building: { select: { id: true, name: true, address: true, city: true } },
    },
  },
  errorCode: { select: { id: true, code: true, title: true } },
  client: { select: { id: true, name: true, email: true, phone: true } },
  technician: { select: { id: true, name: true, email: true, phone: true } },
  workOrder: {
    select: { id: true, orderNumber: true, status: true, priority: true },
  },
} satisfies Prisma.IncidentReportSelect;

export type DispatchedIncident = Prisma.IncidentReportGetPayload<{
  select: typeof INCIDENT_DISPATCH_SELECT;
}>;

// ─── Choosing ───────────────────────────────────────────────

export interface CandidateTechnician {
  id: string;
  name: string | null;
  status: TechnicianStatus;
  /** Open work orders currently held. */
  load: number;
}

/**
 * The engineer who should get the next job, or null when nobody is reachable.
 *
 * `DISPATCHABLE_TECHNICIAN_STATUSES` (AVAILABLE, ON_JOB) is the same gate the
 * roster and `assignableUserWhere` apply. OFF_DUTY and ON_LEAVE are people who
 * are not at work: handing one of them an emergency produces a job nobody
 * answers, which is worse than leaving the incident escalated where a human
 * will see it.
 *
 * ON_JOB is kept in, and ranked *below* an equally-loaded AVAILABLE
 * technician. That ordering is the one judgement this function makes beyond
 * the workload count: the schema comment on `TechnicianStatus` says an ON_JOB
 * engineer is queueable behind the job they are on, and that is what
 * dispatching to them means — but when a free engineer and an occupied one are
 * holding the same number of jobs, the free one is the better answer.
 */
export async function pickLeastBusyTechnician(
  db: Db = prisma
): Promise<CandidateTechnician | null> {
  const technicians = await db.user.findMany({
    where: {
      role: "FIELD_TECHNICIAN",
      isActive: true,
      status: { in: [...DISPATCHABLE_TECHNICIAN_STATUSES] },
    },
    select: {
      id: true,
      name: true,
      status: true,
      _count: {
        select: {
          assignedWorkOrders: {
            where: { status: { in: [...OPEN_ASSIGNMENT_STATUSES] } },
          },
        },
      },
    },
  });

  const ranked: CandidateTechnician[] = technicians
    .map((technician) => ({
      id: technician.id,
      name: technician.name,
      status: technician.status,
      load: technician._count.assignedWorkOrders,
    }))
    .sort(
      (a, b) =>
        a.load - b.load ||
        // `false < true`, so negating puts AVAILABLE first.
        Number(b.status === "AVAILABLE") - Number(a.status === "AVAILABLE") ||
        // Final tie-break on id, never on name: two engineers can share a
        // name, and a stable order is what makes the choice reproducible.
        a.id.localeCompare(b.id)
    );

  return ranked[0] ?? null;
}

// ─── Assigning ──────────────────────────────────────────────

/**
 * Writes a technician onto an incident *and* onto the work order it owns, in
 * one transaction.
 *
 * Both rows move together because they answer to different readers. The
 * incident is what the board and the customer see; the work order is the
 * technician's actual queue entry, and an assignment that landed on only one
 * of them shows the job as dispatched while never reaching `/technicien`.
 *
 * The `updateMany` with the status as a precondition is the concurrency guard:
 * two dispatchers clicking at once cannot both claim the same incident,
 * because the second finds zero rows matching. Serializable isolation plus one
 * retry on P2034 closes the read-then-write window around it.
 *
 * Throws `ApiError` on a lost race or a missing incident — the caller decides
 * whether that is worth reporting. `autoAssignIncident` below swallows it;
 * the manual route surfaces it.
 */
export async function assignIncidentToTechnician(
  incidentId: string,
  technicianId: string
): Promise<DispatchedIncident> {
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const incident = await tx.incidentReport.findUnique({
          where: { id: incidentId },
          select: { id: true, incidentNumber: true, workOrderId: true },
        });
        if (!incident) throw notFound(`Incident introuvable : ${incidentId}`);

        const claimed = await tx.incidentReport.updateMany({
          where: {
            id: incidentId,
            status: { in: ["ESCALATED", "TECHNICIAN_ASSIGNED"] },
          },
          data: { technicianId, status: "TECHNICIAN_ASSIGNED" },
        });

        if (claimed.count === 0) {
          throw conflict(
            `L'incident ${incident.incidentNumber} a été modifié par une autre requête.`
          );
        }

        if (incident.workOrderId) {
          const order = await tx.workOrder.findUnique({
            where: { id: incident.workOrderId },
            select: { id: true, status: true, scheduledDate: true },
          });

          // Only an order still outstanding is claimed. A closed one keeps its
          // history: resurrecting it into ASSIGNED would erase the fact that
          // somebody already attended.
          if (order && isOpenStatus(order.status)) {
            await tx.workOrder.update({
              where: { id: order.id },
              data: {
                assignedToId: technicianId,
                status: "ASSIGNED",
                scheduledDate: order.scheduledDate ?? new Date(),
              },
            });
          }
        }

        return tx.incidentReport.findUniqueOrThrow({
          where: { id: incidentId },
          select: INCIDENT_DISPATCH_SELECT,
        });
      },
      { isolationLevel: "Serializable" }
    )
  );
}

// ─── The automatic path ─────────────────────────────────────

export type AutoAssignOutcome =
  | { assigned: true; technician: CandidateTechnician; incident: DispatchedIncident }
  | { assigned: false; reason: "no-technician" | "failed" };

/**
 * Assigns an escalated incident to whoever is least busy. Never throws.
 *
 * A caller may safely ignore the result: on every failure path the incident
 * stays `ESCALATED` on the board, awaiting the manual dispatch that was the
 * only option before this existed. The outcome is returned anyway so the
 * escalation route can say in the customer's own notification whether anyone
 * was sent, rather than announcing a dispatch that did not happen.
 */
export async function autoAssignIncident(
  incidentId: string
): Promise<AutoAssignOutcome> {
  try {
    const technician = await pickLeastBusyTechnician();

    if (!technician) {
      console.warn(
        `[dispatch] Aucun technicien disponible pour l'incident ${incidentId}. ` +
          "Il reste en attente d'affectation manuelle."
      );
      return { assigned: false, reason: "no-technician" };
    }

    const incident = await assignIncidentToTechnician(incidentId, technician.id);

    // After the commit: the assignment is real either way, and a stale
    // work-state column must not undo it. See `syncTechnicianStatus`.
    await syncTechnicianStatus(prisma, technician.id);
    await notify({
      userId: technician.id,
      title: `Nouvel incident affecté – ${incident.elevator.elevatorCode}`,
      message: `L'incident ${incident.incidentNumber} vous a été affecté.`,
      type: "incident",
      linkUrl: "/technicien",
    });

    return { assigned: true, technician, incident };
  } catch (error) {
    // A lost race is expected on a busy board and is not worth shouting about;
    // anything else is worth a line in the log.
    const isRace = (error as { status?: number })?.status === 409;
    if (isRace) {
      console.warn(
        `[dispatch] Incident ${incidentId} déjà pris en charge par une autre requête.`
      );
    } else {
      console.error(
        `[dispatch] Affectation automatique impossible pour l'incident ${incidentId}`,
        error
      );
    }
    return { assigned: false, reason: "failed" };
  }
}

// ─── Work-state mirror ──────────────────────────────────────

/**
 * Keeps `User.status` in step with a technician's actual queue.
 *
 * The column is a *mirror*, not a source of truth: every read that matters
 * derives the load from `assignedWorkOrders` (the roster's `_count`, the
 * dialog's badges) precisely because a stored counter drifts. But the column
 * is still read as a gate — `DISPATCHABLE_TECHNICIAN_STATUSES` decides who the
 * roster offers — so a technician who is never marked ON_JOB is offered as
 * free while holding four jobs, and one never released stays marked ON_JOB
 * through a quiet week.
 *
 * Two states are never touched:
 *
 *  - `OFF_DUTY` and `ON_LEAVE` are statements about a *person* — they have
 *    gone home, they are on holiday. A derived mirror has no business
 *    overwriting them, and doing so would silently put an absent engineer back
 *    on the dispatch list.
 *  - any non-technician row. `status` carries a default on every user and is
 *    meaningless for an admin or a manager; rewriting it there would corrupt a
 *    column nobody asked about.
 *
 * Never throws: a mirror that fails to update is a cosmetic inaccuracy, and it
 * must not turn a successful check-in into a 500.
 */
export async function syncTechnicianStatus(
  db: Db,
  technicianId: string
): Promise<void> {
  try {
    const technician = await db.user.findUnique({
      where: { id: technicianId },
      select: { id: true, role: true, status: true },
    });

    if (!technician || technician.role !== "FIELD_TECHNICIAN") return;
    if (technician.status === "OFF_DUTY" || technician.status === "ON_LEAVE") {
      return;
    }

    const openJobs = await db.workOrder.count({
      where: {
        assignedToId: technicianId,
        status: { in: [...OPEN_ASSIGNMENT_STATUSES] },
      },
    });

    const next: TechnicianStatus = openJobs > 0 ? "ON_JOB" : "AVAILABLE";
    if (next === technician.status) return;

    await db.user.update({
      where: { id: technicianId },
      data: { status: next },
    });
  } catch (error) {
    console.error(
      `[dispatch] Statut du technicien ${technicianId} non synchronisé`,
      error
    );
  }
}

// ─── Retry ──────────────────────────────────────────────────

/** Retries once on a serialization failure (Prisma P2034). */
async function withSerializableRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isSerializationFailure =
        (error as { code?: string })?.code === "P2034";
      if (!isSerializationFailure || attempt >= 1) throw error;
      console.warn("[dispatch] serialization conflict, retrying");
    }
  }
}
