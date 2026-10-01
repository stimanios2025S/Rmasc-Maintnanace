/**
 * The Prisma `include` clauses for reading a work order.
 *
 * These lived in `src/app/api/work-orders/route.ts` until the single-order
 * endpoint needed one of its own. A second copy is how the board and the
 * work-order page start disagreeing about what a work order *is* — one of them
 * gains a field, the other does not, and the same row renders differently
 * depending on how you arrived at it.
 *
 * The two are deliberately different sizes, and the difference is the point:
 *
 *  - `WORK_ORDER_INCLUDE` is what a *card* needs. The board renders dozens of
 *    these at once, so it carries only what fits on a tile — the unit, the
 *    building name, the assignee, the component, and the incident the order
 *    came from.
 *  - `WORK_ORDER_DETAIL_INCLUDE` is what a *page* needs, for exactly one
 *    order: the full site address, the inspection report the order produced,
 *    and the corrections the office made to that report.
 *
 * Both are `as const satisfies`, and the two halves are not redundant. `as
 * const` is what keeps the `true`s literal, which is what Prisma's generated
 * `GetFindResult` reads to decide which relations the payload actually carries
 * — widen them to `boolean` and every query silently degrades to the full-model
 * type, the narrow `select` is lost, and a component reading a field it never
 * asked for still compiles. `satisfies` is the other half: a field renamed in
 * `schema.prisma` breaks the build here rather than returning `undefined` to a
 * screen that renders it.
 */

import type { Prisma } from "@prisma/client";

export const WORK_ORDER_INCLUDE = {
  elevator: {
    select: {
      id: true,
      elevatorCode: true,
      building: { select: { name: true } },
    },
  },
  assignedTo: { select: { id: true, name: true, email: true } },
  component: { select: { name: true, componentType: true } },
  /**
   * The incident this order was raised from, when there was one.
   *
   * Read-only context for the board, and the reason it is on the include
   * rather than left to the incident endpoint: a dispatcher looking at a
   * corrective order needs to know it came from a customer escalation, and
   * which fault code, *before* deciding who to send. Most orders have none —
   * the relation is nullable and the field reads as absent.
   */
  incident: {
    select: {
      id: true,
      incidentNumber: true,
      status: true,
      isDirectTransfer: true,
      errorCode: { select: { code: true, title: true } },
    },
  },
} as const satisfies Prisma.WorkOrderInclude;

export const WORK_ORDER_DETAIL_INCLUDE = {
  ...WORK_ORDER_INCLUDE,
  elevator: {
    select: {
      id: true,
      elevatorCode: true,
      model: true,
      brand: true,
      floorsServed: true,
      status: true,
      nextMaintenance: true,
      building: {
        select: {
          id: true,
          name: true,
          address: true,
          city: true,
          contactPerson: true,
          contactPhone: true,
        },
      },
    },
  },
  /**
   * The signed inspection, if the technician filed one.
   *
   * Selected rather than included whole: `signatures` is a JSON column holding
   * canvas captures capped at 200 KB each, and this endpoint returns after
   * every approval decision. The reviewer does not need the strokes to decide —
   * the report's own page draws them — so what travels here is the reference
   * needed to link to it, plus the result, which is the one field the reviewer
   * has to see without leaving.
   */
  inspectionReports: {
    select: {
      id: true,
      reportNumber: true,
      title: true,
      overallResult: true,
      submittedAt: true,
    },
    orderBy: { submittedAt: "desc" },
  },
  /**
   * The office's own corrections, oldest first — a timeline reads forwards.
   *
   * `author` is selected to the name and nothing else: the page credits the
   * correction to a person, and pulling their email, role or status onto a
   * billing screen would put an HR record one devtools tab away from a client's
   * invoice.
   */
  revisions: {
    select: {
      id: true,
      field: true,
      oldValue: true,
      newValue: true,
      note: true,
      createdAt: true,
      author: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
  },
  /**
   * La facture, quand le bon a été facturé.
   *
   * Sélectionnée au minimum : la fiche n'a besoin que de renvoyer vers le PDF,
   * et le document lui-même se lit dans le fichier, pas à l'écran. Charger les
   * adresses figées ici les ferait voyager à chaque ouverture de la fiche pour
   * un contenu que personne n'y lit.
   */
  invoice: {
    select: {
      id: true,
      number: true,
      issuedAt: true,
      amount: true,
      currency: true,
    },
  },
} as const satisfies Prisma.WorkOrderInclude;
