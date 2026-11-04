/**
 * Maintenance RMASC – pointage de fin d'intervention.
 *
 * POST /api/work-orders/:id/check-out – « J'ai terminé, je quitte le site »
 *
 * WHY A SECOND ENDPOINT
 * `POST /check-in` records the arrival; the completion report records what was
 * done and hands the order to the office. Neither answers the question the
 * payroll and the invoice actually ask: how long was somebody on site? The
 * report can be filed hours later, from the van, and `completedAt` is written
 * when the *office* approves it — days later. This route stamps the moment the
 * technician leaves, which is the only honest second end of the interval.
 *
 * WHY IT WRITES `actualHours`
 * The duration is derived here, once, from `arrivedAt` and this timestamp, and
 * stored on the order. A screen that recomputed it would disagree with the
 * report the moment either timestamp was corrected; the office reads one
 * number, and it is the one written at the moment of the departure.
 *
 * IDEMPOTENT BY PRECONDITION
 * The `updateMany` is filtered on `departedAt: null`, exactly as the check-in
 * is filtered on `arrivedAt: null`. A second tap on a phone receives a 409
 * carrying the first time instead of silently overwriting the labour duration
 * with a longer one.
 *
 * NO GEOFENCE HERE
 * The geofence exists to prove presence when work *starts*. Refusing a
 * departure because the technician is already in the lift lobby would leave
 * the order open forever, which is worse than a slightly early timestamp.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  conflict,
  forbidden,
  handleRouteError,
  notFound,
} from "@/lib/api/http";
import {
  isSelfOrManager,
  MANAGEMENT_ROLES,
  OPS_ROLES,
  requireRole,
} from "@/lib/api/guard";
import { prisma } from "@/lib/db/prisma";
import { notifyRoles } from "@/lib/notifications/service";

type Params = { params: { id: string } };

/** Arrondi au centième d'heure — la précision de `actualHours` (Float). */
function hoursBetween(start: Date, end: Date): number {
  const hours = (end.getTime() - start.getTime()) / 3_600_000;
  return Math.max(0, Math.round(hours * 100) / 100);
}

export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireRole(...OPS_ROLES);

    const workOrder = await prisma.workOrder.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        assignedToId: true,
        arrivedAt: true,
        departedAt: true,
        elevator: {
          select: {
            elevatorCode: true,
            building: { select: { name: true } },
          },
        },
      },
    });

    if (!workOrder) {
      throw notFound(`Bon de travail introuvable : ${params.id}`);
    }

    if (!isSelfOrManager(session, workOrder.assignedToId)) {
      throw forbidden("Ce bon de travail ne vous est pas affecté");
    }

    if (!workOrder.arrivedAt) {
      throw conflict(
        "Pointez d'abord votre arrivée sur le site avant de pointer la fin."
      );
    }

    if (workOrder.departedAt) {
      throw conflict(
        `La fin d'intervention a déjà été pointée sur ${workOrder.orderNumber} ` +
          `à ${workOrder.departedAt.toLocaleTimeString("fr-FR", {
            hour: "2-digit",
            minute: "2-digit",
          })}.`
      );
    }

    const departedAt = new Date();
    const actualHours = hoursBetween(workOrder.arrivedAt, departedAt);

    const updated = await prisma.$transaction(async (tx) => {
      const claimed = await tx.workOrder.updateMany({
        where: {
          id: workOrder.id,
          departedAt: null,
          arrivedAt: { not: null },
        },
        data: { departedAt, actualHours },
      });

      if (claimed.count === 0) {
        throw conflict(
          `Un pointage de fin a déjà été enregistré sur ${workOrder.orderNumber}.`
        );
      }

      return tx.workOrder.findUniqueOrThrow({
        where: { id: workOrder.id },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          arrivedAt: true,
          departedAt: true,
          actualHours: true,
        },
      });
    });

    /**
     * Courtesy, after the commit. The departure is recorded whether or not the
     * office hears about it — a notification failure must not tell a
     * technician who has already left the building that their pointage did not
     * happen.
     */
    await notifyRoles([...MANAGEMENT_ROLES], {
      title: `Fin d'intervention – ${workOrder.elevator.elevatorCode}`,
      message:
        `Le technicien a quitté ${workOrder.elevator.building.name} sur le bon ` +
        `${workOrder.orderNumber} après ${actualHours.toLocaleString("fr-FR")} h ` +
        "de présence sur site.",
      type: "work_order",
      linkUrl: `/bons-de-travail/${workOrder.id}`,
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    return handleRouteError(error);
  }
}
