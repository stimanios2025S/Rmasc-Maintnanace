/**
 * Maintenance RMASC – Work Orders API
 *
 * GET    /api/work-orders          – List work orders (with filters)
 * POST   /api/work-orders          – Create a work order
 * PATCH  /api/work-orders?id=xxx   – Update a work order
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { z } from "zod";
import {
  badRequest,
  conflict,
  forbidden,
  handleRouteError,
  notFound,
  parseEnumParam,
  parsePagination,
  readJson,
} from "@/lib/api/http";
import {
  assignableUserWhere,
  buildingScopeFor,
  isSelfOrManager,
  MANAGEMENT_ROLES,
  OPS_ROLES,
  requireRole,
} from "@/lib/api/guard";
import { createWorkOrderWithUniqueNumber } from "@/lib/work-orders/service";
import { statusesLeadingTo } from "@/lib/incidents/progress";
import { WORK_ORDER_INCLUDE } from "@/lib/work-orders/includes";
import {
  decimalToText,
  diffReport,
  rejectionDraft,
  type ReportSnapshot,
  type RevisionDraft,
} from "@/lib/work-orders/report-revisions";
import { issueInvoiceForWorkOrder } from "@/lib/invoices/service";
import { syncTechnicianStatus } from "@/lib/dispatch/auto-assign";
import { notify, notifyRoles } from "@/lib/notifications/service";
import { notifyTechnicianOfWorkOrderInBackground } from "@/lib/notifications/assignment";
import { formatDzd } from "@/lib/ui/money";
import {
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_STATUSES,
  WORK_ORDER_TYPES,
} from "@/types";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoWorkOrders } from "@/lib/demo/responses";

const CreateWorkOrderSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(5000).optional(),
    type: z.enum(WORK_ORDER_TYPES),
    priority: z.enum(WORK_ORDER_PRIORITIES),
    elevatorId: z.string().min(1),
    componentId: z.string().min(1).optional(),
    assignedToId: z.string().min(1).optional(),
    scheduledDate: z.string().datetime().optional(),
    estimatedHours: z.number().positive().max(1000).optional(),
  })
  .strict();

const UpdateWorkOrderSchema = z
  .object({
    status: z.enum(WORK_ORDER_STATUSES).optional(),
    assignedToId: z.string().min(1).nullable().optional(),
    actualHours: z.number().min(0).max(1000).optional(),
    scheduledDate: z.string().datetime().nullable().optional(),
    partsReplaced: z
      .array(
        z.object({
          name: z.string().min(1),
          partNumber: z.string().optional(),
          qty: z.number().positive(),
        })
      )
      .max(200)
      .optional(),
    notes: z.string().max(10000).nullable().optional(),
    photoUrls: z.array(z.string().url()).max(50).optional(),
    signatureUrl: z.string().url().nullable().optional(),
    /**
     * The technician's own report, on its commercial side.
     *
     * `invoiceAmount` is capped at ten digits: `invoiceAmount` is a
     * `Decimal(12,2)` in the schema, and a value beyond it would be a
     * database-level failure reported as a 500. A ceiling expressed here is a
     * readable 400 that names the field.
     */
    isBillable: z.boolean().optional(),
    invoiceAmount: z.number().min(0).max(99_999_999.99).nullable().optional(),
    /**
     * Why a submitted report is being sent back to the technician.
     *
     * Declared optional and enforced as mandatory further down, on the one
     * transition where it is required. A field that is optional in general but
     * obligatory in a single case cannot say so in a flat Zod object — and
     * marking it required here would demand a reason for editing an open job,
     * which is not a refusal of anything.
     */
    rejectionReason: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

/**
 * Permitted status transitions. Terminal states are genuinely terminal —
 * the previous implementation let an update walk a COMPLETED order back to
 * ASSIGNED simply by setting `assignedToId`, silently discarding the
 * completion timestamp.
 *
 * There is one route to `COMPLETED`, and it runs through `PENDING_APPROVAL`:
 * a job is finished when a report exists and somebody in the office has read
 * it. `IN_PROGRESS` no longer reaches `COMPLETED` directly, which is the whole
 * point of the approval step — a board where the fast path skips the queue is
 * a board where the queue is never worked.
 *
 * The reverse edge is deliberate: `PENDING_APPROVAL -> IN_PROGRESS` is a
 * rejected report, sent back for correction. Without it the only ways out of
 * the pending column would be "accept" and "cancel", and a report with a wrong
 * amount would have to be cancelled and redone from scratch.
 */
const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  OPEN: ["ASSIGNED", "IN_PROGRESS", "ON_HOLD", "CANCELLED"],
  ASSIGNED: ["OPEN", "IN_PROGRESS", "ON_HOLD", "CANCELLED"],
  IN_PROGRESS: ["ASSIGNED", "ON_HOLD", "PENDING_APPROVAL", "CANCELLED"],
  PENDING_APPROVAL: ["IN_PROGRESS", "COMPLETED", "CANCELLED"],
  ON_HOLD: ["ASSIGNED", "IN_PROGRESS", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

// ─── GET: list work orders ──────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");

    const { searchParams } = new URL(request.url);
    const { page, limit, skip } = parsePagination(searchParams);

    const where: Record<string, unknown> = {};

    // A building owner sees only work orders for the buildings they own.
    // Without this they received the entire fleet's maintenance history.
    // Uses the shared scope so this filter cannot drift from the other
    // owner-scoped routes.
    if (session.user.role === "BUILDING_OWNER") {
      where.elevator = { building: buildingScopeFor(session) };
    }
    const status = parseEnumParam(searchParams, "status", WORK_ORDER_STATUSES);
    const priority = parseEnumParam(
      searchParams,
      "priority",
      WORK_ORDER_PRIORITIES
    );
    const type = parseEnumParam(searchParams, "type", WORK_ORDER_TYPES);
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (type) where.type = type;

    for (const key of ["elevatorId", "assignedToId"] as const) {
      const value = searchParams.get(key);
      if (value) where[key] = value;
    }

    const [workOrders, total] = await Promise.all([
      prisma.workOrder.findMany({
        where,
        // `WorkOrderPriority` is declared LOW -> CRITICAL, and Postgres sorts
        // enums by declaration order, so `desc` puts the most urgent first.
        // (Reordering the enum in schema.prisma changes this silently.)
        orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
        take: limit,
        skip,
        include: WORK_ORDER_INCLUDE,
      }),
      prisma.workOrder.count({ where }),
    ]);

    return NextResponse.json({
      data: workOrders,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/work-orders");
      // Re-read the query string: the parsed values live in the `try` scope.
      const { searchParams } = new URL(request.url);
      const { limit, skip } = parsePagination(searchParams);
      return NextResponse.json(
        demoWorkOrders({
          status: searchParams.get("status"),
          priority: searchParams.get("priority"),
          type: searchParams.get("type"),
          elevatorId: searchParams.get("elevatorId"),
          assignedToId: searchParams.get("assignedToId"),
          limit,
          skip,
        })
      );
    }
    return handleRouteError(error);
  }
}

// ─── POST: create a work order ──────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES);
    const parsed = CreateWorkOrderSchema.parse(await readJson(request));

    const elevator = await prisma.elevator.findFirst({
      where: { id: parsed.elevatorId, isActive: true },
      select: { id: true },
    });
    if (!elevator) {
      throw notFound(`Ascenseur introuvable : ${parsed.elevatorId}`);
    }

    if (parsed.componentId) {
      const component = await prisma.elevatorComponent.findFirst({
        where: { id: parsed.componentId, elevatorId: parsed.elevatorId },
        select: { id: true },
      });
      if (!component) {
        throw notFound(
          `Composant introuvable sur cet ascenseur : ${parsed.componentId}`
        );
      }
    }

    if (parsed.assignedToId) {
      const tech = await prisma.user.findFirst({
        where: assignableUserWhere(parsed.assignedToId),
        select: { id: true },
      });
      if (!tech) {
        throw notFound(
          `Personne à affecter introuvable ou non affectable : ${parsed.assignedToId}`
        );
      }
    }

    // Attribute the order to the caller. The previous implementation always
    // wrote the earliest admin/manager as `createdBy`, so every order in the
    // system appeared to have been raised by the same seeded account and the
    // audit trail was worthless.
    const workOrder = await createWorkOrderWithUniqueNumber({
      title: parsed.title,
      description: parsed.description ?? null,
      type: parsed.type,
      priority: parsed.priority,
      elevatorId: parsed.elevatorId,
      componentId: parsed.componentId ?? null,
      assignedToId: parsed.assignedToId ?? null,
      createdById: session.user.id,
      scheduledDate: parsed.scheduledDate ? new Date(parsed.scheduledDate) : null,
      estimatedHours: parsed.estimatedHours ?? null,
      status: parsed.assignedToId ? "ASSIGNED" : "OPEN",
    });

    const enriched = await prisma.workOrder.findUniqueOrThrow({
      where: { id: workOrder.id },
      include: WORK_ORDER_INCLUDE,
    });

    // Creating an order with somebody already on it is an assignment like any
    // other, so the technician hears about it the same way he would from the
    // board. Fired and forgotten: the order is committed, and the answer to
    // this request does not depend on WhatsApp.
    if (parsed.assignedToId) {
      notifyTechnicianOfWorkOrderInBackground(workOrder.id);
    }

    return NextResponse.json({ data: enriched }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}

// ─── PATCH: update a work order ─────────────────────────────

export async function PATCH(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES);

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) throw badRequest("L'identifiant du bon de travail est requis");

    const parsed = UpdateWorkOrderSchema.parse(await readJson(request));

    /**
     * The row as it stands, read before anything is decided.
     *
     * `notes`, `partsReplaced` and `invoiceAmount` are here for the correction
     * journal rather than for the update itself: a revision is the difference
     * between these values and the ones arriving in the body, so both halves of
     * that comparison have to be in hand before the write. Reading them
     * afterwards would be reading what the update just wrote — a diff against
     * itself, which is always empty.
     */
    const current = await prisma.workOrder.findUnique({
      where: { id },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        assignedToId: true,
        startedAt: true,
        isBillable: true,
        invoiceAmount: true,
        notes: true,
        partsReplaced: true,
      },
    });
    if (!current) throw notFound(`Bon de travail introuvable : ${id}`);

    // A field technician may only touch work assigned to them, and may not
    // reassign it. Without this, any authenticated user — including a
    // building owner — could reassign or close any order in the system.
    if (!isSelfOrManager(session, current.assignedToId)) {
      throw forbidden("Ce bon de travail ne vous est pas affecté");
    }

    const updateData: Record<string, unknown> = {};

    /**
     * The one transition that is a refusal: a waiting report sent back.
     *
     * Deliberately not "any move out of PENDING_APPROVAL" — accepting a report
     * and cancelling one are decisions too, but only this one leaves work on a
     * technician's desk. He is the person who pays for a silent refusal: his
     * job reappears in his queue with no indication of what to change, and the
     * only way to find out is to ring the office.
     */
    const isRejection =
      current.status === "PENDING_APPROVAL" && parsed.status === "IN_PROGRESS";

    if (isRejection && !parsed.rejectionReason) {
      throw badRequest(
        "Indiquez au technicien ce qu'il doit corriger avant de lui renvoyer le rapport."
      );
    }

    if (parsed.status && parsed.status !== current.status) {
      const allowed = ALLOWED_TRANSITIONS[current.status] ?? [];
      if (!allowed.includes(parsed.status)) {
        throw conflict(
          `Impossible de faire passer le bon de travail de ${current.status} à ${parsed.status}`
        );
      }
      updateData.status = parsed.status;

      if (parsed.status === "IN_PROGRESS" && !current.startedAt) {
        updateData.startedAt = new Date();
      }
      if (parsed.status === "COMPLETED") {
        updateData.completedAt = new Date();
      }
      if (parsed.status === "OPEN" || parsed.status === "CANCELLED") {
        updateData.startedAt = null;
        updateData.completedAt = null;
      }

      /**
       * `reportSubmittedAt` is the clock the approval queue reads, so it has to
       * mean exactly one thing: this order is waiting, since then.
       *
       * It is set on the way in and cleared on the way back out to IN_PROGRESS,
       * because a report the office refused is no longer a report that is
       * waiting. It is deliberately *not* cleared on the way to COMPLETED: once
       * accepted, "submitted on the 12th, approved on the 15th" is the record.
       */
      if (parsed.status === "PENDING_APPROVAL") {
        updateData.reportSubmittedAt = new Date();
      } else if (
        current.status === "PENDING_APPROVAL" &&
        parsed.status !== "COMPLETED"
      ) {
        updateData.reportSubmittedAt = null;
      }
    }

    if (parsed.assignedToId !== undefined) {
      // Only managers and admins may reassign work.
      if (session.user.role === "FIELD_TECHNICIAN") {
        throw badRequest("Seuls les responsables peuvent réaffecter des bons de travail");
      }

      if (parsed.assignedToId) {
        const tech = await prisma.user.findFirst({
          where: assignableUserWhere(parsed.assignedToId),
          select: { id: true },
        });
        if (!tech) {
          throw notFound(
            `Personne à affecter introuvable ou non affectable : ${parsed.assignedToId}`
          );
        }
      }
      updateData.assignedToId = parsed.assignedToId;

      // Assigning an unassigned order advances it — but never resurrect a
      // closed order into ASSIGNED.
      if (
        parsed.assignedToId &&
        !parsed.status &&
        current.status === "OPEN"
      ) {
        updateData.status = "ASSIGNED";
      }
    }

    if (parsed.scheduledDate !== undefined) {
      updateData.scheduledDate = parsed.scheduledDate
        ? new Date(parsed.scheduledDate)
        : null;
    }
    if (parsed.actualHours !== undefined) updateData.actualHours = parsed.actualHours;
    if (parsed.partsReplaced !== undefined) updateData.partsReplaced = parsed.partsReplaced;
    if (parsed.notes !== undefined) updateData.notes = parsed.notes;
    if (parsed.photoUrls !== undefined) updateData.photoUrls = parsed.photoUrls;
    if (parsed.signatureUrl !== undefined) updateData.signatureUrl = parsed.signatureUrl;

    /**
     * An amount on a job that is not billable is a number waiting to be
     * believed.
     *
     * The portal sends both fields together and a technician who ticks the box,
     * types an amount and then thinks better of it would leave the amount
     * behind — invisible in the form, present in the database, and liable to
     * turn up on an invoice nobody meant to raise. So the amount follows the
     * flag: not billable means null, whichever half of the pair arrived.
     */
    const nextIsBillable =
      parsed.isBillable !== undefined ? parsed.isBillable : current.isBillable;
    if (parsed.isBillable !== undefined) updateData.isBillable = parsed.isBillable;
    if (!nextIsBillable) {
      if (parsed.invoiceAmount !== undefined || parsed.isBillable === false) {
        updateData.invoiceAmount = null;
      }
    } else if (parsed.invoiceAmount !== undefined) {
      updateData.invoiceAmount = parsed.invoiceAmount;
    }

    /**
     * The office's corrections to a report it is reviewing, collected before
     * the write so that they land *inside* it.
     *
     * Written through the nested create on the update below rather than in a
     * second statement afterwards, and the reason is not tidiness. A correction
     * and its record are one fact; two statements can be separated by a crash,
     * a timeout, or a later deploy, and the failure mode is the worst one this
     * feature has — an amount changed with nothing to show it was changed. In
     * a single statement they either both happen or neither does.
     *
     * Scoped to rows that are *already* pending. An order entering
     * PENDING_APPROVAL in this same request is the technician filing his
     * report, and his own first version of it is not a correction of itself;
     * journaling it would bury the office's edits under a line per submission.
     */
    const reportRevisions: RevisionDraft[] = [];

    if (current.status === "PENDING_APPROVAL") {
      // Read back out of `updateData` where the billing block decided them:
      // re-deriving "what the amount will be" here would be a second
      // implementation of the same invariant, and the two would eventually
      // disagree — with the journal recording a value the row does not hold.
      const effectiveInvoiceAmount =
        "invoiceAmount" in updateData
          ? decimalToText(
              updateData.invoiceAmount as { toString(): string } | null
            )
          : decimalToText(current.invoiceAmount);

      reportRevisions.push(
        ...diffReport(
          {
            notes: current.notes,
            isBillable: current.isBillable,
            invoiceAmount: decimalToText(current.invoiceAmount),
            partsReplaced: current.partsReplaced,
          },
          {
            notes: parsed.notes !== undefined ? parsed.notes : current.notes,
            isBillable: nextIsBillable,
            invoiceAmount: effectiveInvoiceAmount,
            partsReplaced:
              parsed.partsReplaced !== undefined
                ? parsed.partsReplaced
                : current.partsReplaced,
          }
        )
      );

      if (isRejection && parsed.rejectionReason) {
        reportRevisions.push(rejectionDraft(parsed.rejectionReason));
      }
    }

    if (reportRevisions.length > 0) {
      updateData.revisions = {
        create: reportRevisions.map((draft) => ({
          authorId: session.user.id ?? null,
          field: draft.field,
          oldValue: draft.oldValue,
          newValue: draft.newValue,
          note: draft.note ?? null,
        })),
      };
    }

    // An ASSIGNED order with no assignee is a dead end: it shows in the
    // "Assigned" column, is invisible to every technician's queue (which is
    // filtered by `assignedToId`), and cannot be dispatched. The kanban's
    // "Move to Assigned" button used to create exactly that.
    const nextStatus = String(updateData.status ?? current.status);
    const nextAssignee =
      parsed.assignedToId !== undefined ? parsed.assignedToId : current.assignedToId;
    if (nextStatus === "ASSIGNED" && !nextAssignee) {
      throw badRequest(
        "Un bon de travail ne peut pas être marqué ASSIGNED sans personne affectée. " +
          "Renseignez `assignedToId`, ou utilisez POST /api/work-orders/dispatch."
      );
    }

    /**
     * Le bon et le ticket de l'occupant avancé ensemble.
     *
     * C'est la moitié manquante de la boucle. Un incident signalé depuis
     * l'espace client crée un bon de travail, et la barre de progression que le
     * client regarde lit le statut de *l'incident*. Jusqu'ici rien ne le
     * faisait avancer au-delà de « intervention en cours » : les travaux
     * pouvaient être finis, le rapport validé et la facture émise, le client
     * voyait toujours un technicien censé être chez lui. Le seul écran qui
     * aurait pu le lui dire était celui de l'entreprise.
     *
     * Les deux écritures sont dans une transaction, contrairement aux
     * notifications et à la facture qui vivent volontairement à côté. La
     * différence est ce qui est raconté : une notification annonce un fait
     * déjà écrit, une facture est un document qui suit un autre document. Ici
     * les deux lignes disent la *même* chose — cette panne est terminée — et
     * deux états qui se contredisent sur ce point sont exactement ce que le
     * produit existe pour éviter.
     */
    const workOrder = await prisma.$transaction(async (tx) => {
      const updated = await tx.workOrder.update({
        where: { id },
        data: updateData,
        include: WORK_ORDER_INCLUDE,
      });

      if (updated.status === "COMPLETED") {
        // Les statuts depuis lesquels la clôture est permise, pris à la machine
        // à états : ceux qui sont déjà terminaux — CLOSED, et surtout
        // RESOLVED_BY_CLIENT — n'y sont pas, donc une panne que l'occupant a
        // résolue seul garde sa conclusion.
        await tx.incidentReport.updateMany({
          where: {
            workOrderId: updated.id,
            status: { in: statusesLeadingTo("CLOSED") },
          },
          data: { status: "CLOSED", resolvedAt: new Date() },
        });
      } else if (updated.status === "CANCELLED") {
        /**
         * Un bon annulé renvoie le ticket en arrière, il ne le laisse pas sur
         * « intervention en cours ».
         *
         * Personne ne vient plus, et la panne n'est pas réglée pour autant :
         * l'occupant doit lire qu'un technicien reste à affecter, pas qu'un
         * technicien est en route. C'est la seule transition inverse que la
         * machine à états autorise depuis IN_PROGRESS.
         */
        await tx.incidentReport.updateMany({
          where: { workOrderId: updated.id, status: "IN_PROGRESS" },
          data: { status: "TECHNICIAN_ASSIGNED" },
        });
      }

      return updated;
    });

    /**
     * A reassignment is a new instruction to a new person, and he has to hear
     * about it — the technician who lost the job is not the one who will turn
     * up.
     *
     * The `!== current.assignedToId` guard is the point of this block. Editing
     * an order that is already assigned to the same technician — adding a note,
     * correcting a date, moving it to IN_PROGRESS — sends `assignedToId` in the
     * body like any other field, and without the guard every one of those edits
     * would text him the same job again. A technician who receives the same
     * message three times stops reading them.
     */
    if (
      parsed.assignedToId &&
      parsed.assignedToId !== current.assignedToId
    ) {
      notifyTechnicianOfWorkOrderInBackground(workOrder.id);
    }

    /**
     * A finished or abandoned order frees whoever was holding it.
     *
     * Without this the `User.status` mirror only ever moves one way: check-in
     * sets ON_JOB, nothing ever clears it, and a technician who closed their
     * last job on Friday is still offered as "En intervention" on Monday. The
     * helper decides whether they are actually free — it re-counts their open
     * work rather than assuming this was the last one, and never touches an
     * OFF_DUTY or ON_LEAVE row.
     *
     * `PENDING_APPROVAL` belongs in this list even though the order is not
     * finished: the technician's part of it is. He has filed his report and
     * left the site, and the office review that follows is exactly the kind of
     * work he should not be held on the clock for — otherwise the busiest
     * technician is the one whose paperwork is slowest.
     */
    if (
      (parsed.status === "COMPLETED" ||
        parsed.status === "CANCELLED" ||
        parsed.status === "PENDING_APPROVAL") &&
      workOrder.assignedToId
    ) {
      await syncTechnicianStatus(prisma, workOrder.assignedToId);
    }

    /**
     * A filed report tells the office it is waiting.
     *
     * Without this the queue fills in silence. The only notification this
     * product sent on a work order before now was the *failure* path — a
     * reassignment, a refused check-in, an inspection that came back FAIL — so
     * the normal, successful end of a job reached nobody, and a report could sit
     * unread until somebody happened to look at the board. A queue nobody is
     * told about is a queue nobody works.
     *
     * Sent only when a *technician* files it. A manager moving an order into the
     * pending column is doing the office's own work, on the office's own screen,
     * and notifying the office about it would be a notification that tells
     * people what they just did.
     */
    if (
      parsed.status === "PENDING_APPROVAL" &&
      current.status !== "PENDING_APPROVAL" &&
      session.user.role === "FIELD_TECHNICIAN"
    ) {
      const billing = workOrder.isBillable
        ? formatDzd(decimalToText(workOrder.invoiceAmount)) ??
          "montant à compléter"
        : "non facturable";

      await notifyRoles(MANAGEMENT_ROLES, {
        title: "Rapport à valider",
        message:
          `${session.user.name ?? "Un technicien"} a soumis le rapport du bon ` +
          `${workOrder.orderNumber} (${workOrder.elevator.elevatorCode} — ` +
          `${workOrder.elevator.building.name}). Facturation : ${billing}.`,
        type: "work_order",
        linkUrl: `/bons-de-travail/${workOrder.id}`,
      });
    }

    /**
     * A report sent back reaches the person who has to redo it.
     *
     * The reason travels in the message rather than only on the work-order
     * page: he reads it on a phone, in a machine room, and a notification that
     * says "rapport renvoyé — voir le bon" is a notification that makes him go
     * looking for the thing it should have told him.
     *
     * Pointed at his own portal, not at the work-order page: that page carries
     * the office's controls and he has no business approving his own report.
     */
    if (isRejection && parsed.rejectionReason && workOrder.assignedToId) {
      await notify({
        userId: workOrder.assignedToId,
        title: "Rapport à corriger",
        message:
          `Le bureau a renvoyé le rapport du bon ${workOrder.orderNumber} : ` +
          parsed.rejectionReason,
        type: "work_order",
        linkUrl: "/technicien",
      });
    }

    /**
     * Un bon facturable qui se clôture reçoit sa facture.
     *
     * L'échec est avalé, et c'est une décision, pas de la négligence.
     *
     * L'émission ne peut pas vivre dans la transaction ci-dessus — la séquence
     * des numéros se lit, et une collision avorte la transaction PostgreSQL
     * entière, ce qui ferait échouer une validation parfaitement valide. Elle se
     * fait donc après, dans la sienne. Mais alors la clôture est déjà commitée :
     * relancer l'erreur ferait afficher « la validation a échoué » à un
     * administrateur dont la validation a réussi, et il la referait.
     *
     * Ce qui reste, c'est un bon clos sans facture. C'est un état visible — la
     * fiche du bon affiche « aucune facture émise » et propose de l'émettre — et
     * c'est un état réparable, ce que ne serait pas une validation perdue.
     */
    if (workOrder.status === "COMPLETED" && workOrder.isBillable) {
      try {
        await issueInvoiceForWorkOrder(workOrder.id, session.user.id ?? null);
      } catch (error) {
        console.error(
          `[invoices] émission échouée pour le bon ${workOrder.orderNumber}`,
          error
        );
      }
    }

    return NextResponse.json({ data: workOrder });
  } catch (error) {
    return handleRouteError(error);
  }
}
