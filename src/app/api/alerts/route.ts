/**
 * ElevatorPulse – Alerts API
 *
 * GET    /api/alerts             – List alerts (filterable)
 * PATCH  /api/alerts?id=xxx      – Acknowledge / resolve an alert
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { z } from "zod";
import {
  badRequest,
  handleRouteError,
  notFound,
  parseBooleanParam,
  parseEnumParam,
  parsePagination,
  readJson,
} from "@/lib/api/http";
import { buildingScopeFor, OPS_ROLES, requireRole } from "@/lib/api/guard";
import { ALERT_SEVERITIES } from "@/types";
import type { Prisma } from "@prisma/client";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoAlerts } from "@/lib/demo/responses";

const UpdateAlertSchema = z
  .object({
    acknowledged: z.boolean().optional(),
    resolved: z.boolean().optional(),
  })
  .strict();

export async function GET(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");

    const { searchParams } = new URL(request.url);
    const { page, limit, skip } = parsePagination(searchParams, {
      maxLimit: 200,
    });

    // Staff see the whole fleet, as before. A BUILDING_OWNER is confined to
    // its own portfolio: without this the sidebar badge counted and the list
    // rendered every other customer's faults. Note this deliberately does not
    // add `elevator.isActive`, so an alert that is still open on a
    // decommissioned unit keeps surfacing to staff.
    const where: Prisma.AlertWhereInput =
      session.user.role === "BUILDING_OWNER"
        ? { elevator: { building: buildingScopeFor(session) } }
        : {};

    const elevatorId = searchParams.get("elevatorId");
    if (elevatorId) where.elevatorId = elevatorId;

    const severity = parseEnumParam(searchParams, "severity", ALERT_SEVERITIES);
    if (severity) where.severity = severity;

    const acknowledged = parseBooleanParam(searchParams, "acknowledged");
    if (acknowledged !== undefined) where.isAcknowledged = acknowledged;

    const resolved = parseBooleanParam(searchParams, "resolved");
    if (resolved !== undefined) {
      where.resolvedAt = resolved ? { not: null } : null;
    }

    const [alerts, total] = await Promise.all([
      prisma.alert.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip,
        include: {
          elevator: {
            select: {
              id: true,
              elevatorCode: true,
              status: true,
              building: { select: { name: true } },
            },
          },
        },
      }),
      prisma.alert.count({ where }),
    ]);

    return NextResponse.json({
      data: alerts,
      // `total` is kept at the top level for the sidebar's unread badge,
      // which reads `json.total` directly.
      total,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/alerts");
      // The filters were parsed inside the `try`, so `catch` cannot see them.
      // Re-reading the query string is safe: `parseEnumParam`/`parseBooleanParam`
      // already validated these values on the way in, or we would be handling a
      // 400 here rather than a connection failure.
      const { searchParams } = new URL(request.url);
      const { limit, skip } = parsePagination(searchParams, { maxLimit: 200 });
      return NextResponse.json(
        demoAlerts({
          elevatorId: searchParams.get("elevatorId"),
          severity: searchParams.get("severity"),
          acknowledged: parseBooleanParam(searchParams, "acknowledged") ?? null,
          resolved: parseBooleanParam(searchParams, "resolved") ?? null,
          limit,
          skip,
        })
      );
    }
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES);

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) throw badRequest("Alert ID is required");

    const parsed = UpdateAlertSchema.parse(await readJson(request));

    const existing = await prisma.alert.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw notFound(`Alert not found: ${id}`);

    const data: Record<string, unknown> = {};

    if (parsed.acknowledged !== undefined) {
      data.isAcknowledged = parsed.acknowledged;
      data.acknowledgedAt = parsed.acknowledged ? new Date() : null;
      // Record who acknowledged it. The column and the `acknowledgedByUser`
      // relation existed but were never populated, so there was no way to
      // answer "who signed off on this alert?".
      data.acknowledgedBy = parsed.acknowledged ? session.user.id : null;
    }

    if (parsed.resolved !== undefined) {
      data.resolvedAt = parsed.resolved ? new Date() : null;
    }

    const alert = await prisma.alert.update({
      where: { id },
      data,
      include: {
        elevator: { select: { elevatorCode: true } },
        acknowledgedByUser: { select: { id: true, name: true } },
      },
    });

    return NextResponse.json({ data: alert });
  } catch (error) {
    return handleRouteError(error);
  }
}
