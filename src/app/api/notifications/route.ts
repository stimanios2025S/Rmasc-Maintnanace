/**
 * ElevatorPulse – In-App Notifications API
 *
 * GET   /api/notifications              – the caller's own notifications
 * PATCH /api/notifications              – mark one, or all, as read
 *
 * Every role uses this, including BUILDING_OWNER, and every caller sees only
 * its own rows. There is deliberately no `userId` parameter anywhere in this
 * file: a notification is addressed to a person, and letting a caller name a
 * different person would turn a mailbox into a broadcast channel.
 *
 * The `Notification` model existed from the first schema but nothing ever
 * wrote to it — the whole pipeline was inert. `src/lib/notifications/service.ts`
 * is now the only writer.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  badRequest,
  handleRouteError,
  parseBooleanParam,
  parsePagination,
  readJson,
} from "@/lib/api/http";
import { requireSession } from "@/lib/api/guard";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoNotifications } from "@/lib/demo/responses";
import type { Prisma } from "@prisma/client";

const PatchSchema = z
  .object({
    /** Omit both to mark everything read — the "clear all" affordance. */
    id: z.string().min(1).optional(),
    all: z.boolean().optional(),
  })
  .strict();

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();
    const { searchParams } = request.nextUrl;
    const { page, limit, skip } = parsePagination(searchParams, {
      defaultLimit: 30,
      maxLimit: 100,
    });

    const isRead = parseBooleanParam(searchParams, "isRead");

    const where: Prisma.NotificationWhereInput = {
      userId: session.user.id,
      ...(isRead === undefined ? {} : { isRead }),
    };

    const [total, unread, notifications] = await Promise.all([
      prisma.notification.count({ where }),
      // Counted independently of the filter: the sidebar badge must show the
      // true unread total even while the tray is filtered to read items.
      prisma.notification.count({
        where: { userId: session.user.id, isRead: false },
      }),
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return NextResponse.json({ data: notifications, total, unread, page, limit });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/notifications");
      return NextResponse.json(demoNotifications());
    }
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await requireSession();
    const body = PatchSchema.parse(await readJson(request));

    if (!body.id && !body.all) {
      throw badRequest('Provide either "id" or "all": true.');
    }

    // `updateMany` scoped on userId rather than `update` by id: marking
    // another user's notification read is then impossible to express, rather
    // than something a handler has to remember to check for.
    const result = await prisma.notification.updateMany({
      where: {
        userId: session.user.id,
        isRead: false,
        ...(body.id ? { id: body.id } : {}),
      },
      data: { isRead: true },
    });

    return NextResponse.json({ data: { updated: result.count } });
  } catch (error) {
    return handleRouteError(error);
  }
}
