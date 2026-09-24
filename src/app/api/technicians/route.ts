/**
 * ElevatorPulse – Technician Roster API
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

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError } from "@/lib/api/http";
import { MANAGEMENT_ROLES, requireRole } from "@/lib/api/guard";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoTechnicianRoster } from "@/lib/demo/responses";
import {
  DISPATCHABLE_TECHNICIAN_STATUSES,
  OPEN_INCIDENT_STATUSES,
} from "@/types";

// Session-dependent; never statically prerendered.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireRole(...MANAGEMENT_ROLES);

    const technicians = await prisma.user.findMany({
      /**
       * Three filters, all in the query rather than applied afterwards: an
       * off-boarded account, someone on leave and someone off duty must not
       * appear in the picker at all, and this way their rows are never read.
       *
       * `ON_JOB` passes. A technician already on a job is still queueable
       * behind it, which is precisely what dispatching to them means; only
       * OFF_DUTY and ON_LEAVE are people who are not at work. The list is
       * imported rather than spelled inline so the route, the fixture and the
       * modal cannot drift apart on who is reachable.
       */
      where: {
        role: "FIELD_TECHNICIAN",
        isActive: true,
        status: { in: [...DISPATCHABLE_TECHNICIAN_STATUSES] },
      },
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
      },
    });

    const roster = technicians
      .map((technician) => ({
        id: technician.id,
        name: technician.name,
        email: technician.email,
        phone: technician.phone,
        status: technician.status,
        openWorkOrders: technician._count.assignedWorkOrders,
        openIncidents: technician._count.assignedIncidents,
      }))
      // Least-loaded first, so the natural pick is the top of the list.
      .sort(
        (a, b) =>
          a.openWorkOrders +
            a.openIncidents -
            (b.openWorkOrders + b.openIncidents) || a.name.localeCompare(b.name)
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
