/**
 * Maintenance RMASC – Technician Roster API
 *
 * GET /api/technicians – active field technicians, least-loaded first.
 *
 * WHY THIS EXISTS
 * Dispatching an incident means naming the person who attends. The only
 * alternative the platform had was "auto-dispatch", where the server picks —
 * fine for routing a routine order, wrong for an emergency a manager is
 * looking at and wants to give to a specific engineer.
 *
 * WHO IS REACHABLE
 * `User.status` is a `TechnicianStatus` (AVAILABLE / ON_JOB / OFF_DUTY /
 * ON_LEAVE). The roster returns only AVAILABLE and ON_JOB; OFF_DUTY and
 * ON_LEAVE are people who are not at work, and offering them produces a
 * dispatch nobody answers. `ON_JOB` stays in because a technician already on a
 * job is queueable behind it — that is what dispatching to them means.
 *
 * The *load* is still derived rather than stored: it is the count of open
 * assignments, because a counter column would have to be kept in step with
 * every status transition and would be wrong the first time one was missed.
 *
 * WHY MANAGEMENT ONLY
 * The roster carries every technician's name, email, phone and workload. That
 * is an internal staffing view: a building owner has no business listing the
 * company's engineers, and a technician does not need a colleague's queue.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError } from "@/lib/api/http";
import { MANAGEMENT_ROLES, requireRole } from "@/lib/api/guard";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoTechnicianRoster } from "@/lib/demo/responses";
import {
  DISPATCHABLE_TECHNICIAN_STATUSES,
  OPEN_INCIDENT_STATUSES,
} from "@/types";
import type { Prisma } from "@prisma/client";

// Session-dependent; never statically prerendered.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireRole(...MANAGEMENT_ROLES);

    /**
     * `all=1` ouvre la liste à toute l'équipe, y compris ceux qui ne sont pas
     * joignables.
     *
     * Le sélecteur de dispatch garde la liste restreinte — on n'affecte pas une
     * urgence à quelqu'un en congé. Le suivi de flotte a besoin de l'inverse :
     * « qui est hors service » est précisément l'information qu'il doit rendre.
     */
    const includeAll = request.nextUrl.searchParams.get("all") === "1";

    const where: Prisma.UserWhereInput = {
      role: "FIELD_TECHNICIAN",
      isActive: true,
      ...(includeAll
        ? {}
        : { status: { in: [...DISPATCHABLE_TECHNICIAN_STATUSES] } }),
    };

    const technicians = await prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        status: true,
        _count: {
          select: {
            assignedWorkOrders: {
              where: { status: { in: ["ASSIGNED", "IN_PROGRESS", "ON_HOLD"] } },
            },
            assignedIncidents: {
              where: { status: { in: [...OPEN_INCIDENT_STATUSES] } },
            },
          },
        },
        /**
         * L'intervention en cours, pour dire *où* est le technicien.
         *
         * « En mission » sans le site oblige le dispatcheur à ouvrir la fiche
         * du bon pour savoir si l'ingénieur est à dix minutes ou à l'autre bout
         * du parc — et c'est exactement la question qu'il se pose en choisissant.
         */
        assignedWorkOrders: {
          where: { status: { in: ["ASSIGNED", "IN_PROGRESS", "ON_HOLD"] } },
          orderBy: { updatedAt: "desc" },
          take: 3,
          select: {
            id: true,
            status: true,
            startedAt: true,
            arrivedAt: true,
            elevator: {
              select: {
                elevatorCode: true,
                building: {
                  select: { name: true, address: true, accessCode: true },
                },
              },
            },
          },
        },
      },
    });

    const ids = technicians.map((technician) => technician.id);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [completedToday, lastCompleted] = await Promise.all([
      // Combien de missions terminées aujourd'hui, par technicien.
      prisma.workOrder.groupBy({
        by: ["assignedToId"],
        where: {
          assignedToId: { in: ids },
          status: "COMPLETED",
          completedAt: { gte: startOfDay },
        },
        _count: { _all: true },
      }),
      /**
       * Le dernier site visité, pour le code d'accès.
       *
       * Ce n'est pas un journal d'usage : la base ne conserve pas l'historique
       * des codes consultés. C'est le code du dernier appareil sur lequel le
       * technicien a effectivement travaillé — la meilleure réponse honnête à
       * « le dernier code qu'il a eu en main ».
       */
      prisma.workOrder.findMany({
        where: { assignedToId: { in: ids }, status: "COMPLETED" },
        orderBy: { completedAt: "desc" },
        distinct: ["assignedToId"],
        select: {
          assignedToId: true,
          elevator: { select: { building: { select: { accessCode: true } } } },
        },
      }),
    ]);

    const completedByTechnician = new Map(
      completedToday.map((row) => [row.assignedToId, row._count._all])
    );
    const lastCodeByTechnician = new Map(
      lastCompleted.map((row) => [
        row.assignedToId,
        row.elevator.building.accessCode,
      ])
    );

    const roster = technicians
      .map((technician) => {
        const current =
          technician.assignedWorkOrders.find(
            (order) => order.status === "IN_PROGRESS"
          ) ??
          technician.assignedWorkOrders[0] ??
          null;

        return {
          id: technician.id,
          name: technician.name,
          email: technician.email,
          phone: technician.phone,
          status: technician.status,
          openWorkOrders: technician._count.assignedWorkOrders,
          openIncidents: technician._count.assignedIncidents,
          /** L'immeuble de l'intervention en cours, ou null. */
          currentBuilding: current?.elevator.building.name ?? null,
          /**
           * La mission en cours, avec son heure de début réelle.
           *
           * `startedAt` est le moment où le technicien a démarré ; `arrivedAt`
           * celui où il est arrivé sur site. Le suivi affiche le premier des
           * deux renseignés, et ne prétend pas que l'un vaut l'autre.
           */
          currentMission: current
            ? {
                orderId: current.id,
                status: current.status,
                elevatorCode: current.elevator.elevatorCode,
                buildingName: current.elevator.building.name,
                address: current.elevator.building.address,
                accessCode: current.elevator.building.accessCode,
                startedAt: current.startedAt ?? current.arrivedAt,
              }
            : null,
          completedToday: completedByTechnician.get(technician.id) ?? 0,
          remainingToday: technician._count.assignedWorkOrders,
          lastAccessCode:
            current?.elevator.building.accessCode ??
            lastCodeByTechnician.get(technician.id) ??
            null,
        };
      })
      // Les joignables d'abord, puis le moins chargé : la même lecture que le
      // sélecteur de dispatch, pour qu'une carte ne contredise pas la liste.
      .sort(
        (a, b) =>
          Number(a.status === "OFF_DUTY" || a.status === "ON_LEAVE") -
            Number(b.status === "OFF_DUTY" || b.status === "ON_LEAVE") ||
          a.openWorkOrders +
            a.openIncidents -
            (b.openWorkOrders + b.openIncidents) ||
          a.name.localeCompare(b.name)
      );

    return NextResponse.json({ data: roster });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/technicians");
      return NextResponse.json({ data: demoTechnicianRoster() });
    }
    return handleRouteError(error);
  }
}
