/**
 * Maintenance RMASC – Single work order
 *
 * GET /api/work-orders/:id – one work order, with its report and its history
 *
 * WHY THIS IS NOT `GET /api/work-orders?id=…`
 * The list endpoint already accepts filters, and an `id` filter on it would
 * have been three lines. It is the wrong three lines: that handler returns the
 * *card* shape, capped at `limit` rows and ordered by urgency, and the work
 * order page needs a different object — the full site address, the inspection
 * report the order produced, and the office's own corrections to it. Adding
 * those to the list include would ship a JSON column's worth of history for
 * every tile on a board that renders dozens of them.
 *
 * AUTHORISATION
 * `BUILDING_OWNER` is allowed in, scoped exactly as the list endpoint scopes
 * it — the same `buildingScopeFor` filter, applied the same way — so an owner
 * can open a link the board gave them and cannot enumerate their way to
 * somebody else's unit by guessing ids. Applying the scope always (rather than
 * only for owners) would have been a behaviour difference from the list: a
 * staff member opening an order whose elevator has since been deactivated
 * would get a 404 for a row they can still see on the board.
 */

import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError, notFound } from "@/lib/api/http";
import { buildingScopeFor, OPS_ROLES, requireRole } from "@/lib/api/guard";
import { WORK_ORDER_DETAIL_INCLUDE } from "@/lib/work-orders/includes";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoWorkOrderById } from "@/lib/demo/responses";

type Params = { params: { id: string } };

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");

    const where: Prisma.WorkOrderWhereInput = { id: params.id };
    if (session.user.role === "BUILDING_OWNER") {
      where.elevator = { building: buildingScopeFor(session) };
    }

    // `findFirst` rather than `findUnique`: the scope turns `where` into a
    // compound predicate, and a row inside another portfolio's buildings comes
    // back as null — which is already the 404 the caller should get. An
    // existence check that answered "this order exists but is not yours" would
    // leak the difference.
    const workOrder = await prisma.workOrder.findFirst({
      where,
      include: WORK_ORDER_DETAIL_INCLUDE,
    });

    if (!workOrder) throw notFound(`Bon de travail introuvable : ${params.id}`);

    return NextResponse.json({ data: workOrder });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/work-orders/[id]");
      const workOrder = demoWorkOrderById(params.id);
      if (!workOrder) {
        return handleRouteError(
          notFound(`Bon de travail introuvable : ${params.id}`)
        );
      }
      return NextResponse.json({ data: workOrder });
    }
    return handleRouteError(error);
  }
}
