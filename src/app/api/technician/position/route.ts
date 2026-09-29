/**
 * Maintenance RMASC – Technician Position API
 *
 * POST /api/technician/position – the portal reporting where its phone is.
 *
 * WHY THIS EXISTS
 * The technician portal has always known its own position — `watchPosition`
 * has been running there since check-in was geofenced. It kept that position
 * to itself, which was enough while the only question was "may this person
 * check in here, now". It is not enough for a dispatcher watching a job
 * unfold, who cannot answer "how far out is he" from the site's coordinates
 * and the site's coordinates alone.
 *
 * WHO IT WRITES FOR
 * The caller, and only the caller: the user id comes from the session and is
 * never read from the body. A route that accepted a target technician would
 * let one account place another on a map, which is the difference between a
 * device reporting itself and a person being reported on.
 *
 * ONE ROW, NO TRAIL
 * `lastLatitude`/`lastLongitude`/`lastPositionAt` are overwritten in place.
 * This is deliberately not an append-only history: a trail is a movement log
 * of named employees, and the product question being answered here is "how
 * far is he from the job", not "where has he been since eight o'clock". The
 * three columns are nullable, and NULL is a normal state — location refused,
 * a page not served over HTTPS, an account that never opened the portal.
 *
 * THROTTLED SERVER-SIDE AS WELL AS IN THE PORTAL
 * The portal sends one update every 45 seconds and only when the position has
 * actually moved. That is a courtesy, not a guarantee: a hand-written request,
 * a stale tab restored from a session, or a future caller all bypass it. The
 * interval is therefore enforced here too, where it holds regardless of who is
 * asking — see `MIN_INTERVAL_MS`. A throttled call is answered 200 with
 * `saved: false`: nothing went wrong, so the client should not retry it and
 * nothing should be logged as a failure.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { badRequest, handleRouteError, readJson } from "@/lib/api/http";
import { requireRole, OPS_ROLES } from "@/lib/api/guard";
import { readCoordinates } from "@/lib/geo/geofence";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";

// Session- and database-dependent; never statically prerendered.
export const dynamic = "force-dynamic";

/**
 * The shortest gap between two accepted writes, in milliseconds.
 *
 * Twenty seconds, comfortably under the portal's own 45-second cadence so a
 * slightly early send is never dropped, and long enough that a runaway loop
 * cannot turn one phone into a write flood. The cost of the throttle is that a
 * position reported inside the window is discarded rather than queued — at the
 * resolution a dispatcher reads ("1,2 km", "340 m"), a twenty-second-old fix is
 * the same answer.
 */
const MIN_INTERVAL_MS = 20_000;

const PositionSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  })
  .strict();

export async function POST(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES);
    const body = PositionSchema.parse(await readJson(request));

    // Re-validated through the shared predicate so a pair this route accepts is
    // a pair every other reader of coordinates accepts. `readCoordinates`
    // deliberately admits (0, 0) — the Gulf of Guinea is a real place to stand
    // — so this is a range check, not a plausibility check.
    const position = readCoordinates(body);
    if (!position) {
      throw badRequest("Position invalide");
    }

    const now = new Date();

    const current = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { lastPositionAt: true },
    });

    /**
     * No row for this session, which is not an error state.
     *
     * Open-access mode attributes every request to a sentinel id that is
     * deliberately not a `User` row (see `src/lib/auth/open-access.ts`), and an
     * account can be deleted while a phone still has the portal open. Writing
     * would raise P2025 and reach the browser as a 404 every 45 seconds of a
     * development session; there is nothing to record either way, so the
     * answer is the same benign shape a throttled call gets.
     */
    if (!current) {
      return NextResponse.json({
        data: { saved: false, reason: "unknown-user" },
      });
    }

    const sinceLast =
      current.lastPositionAt === null
        ? Number.POSITIVE_INFINITY
        : now.getTime() - current.lastPositionAt.getTime();

    if (sinceLast < MIN_INTERVAL_MS) {
      return NextResponse.json({
        data: {
          saved: false,
          reason: "throttled",
          retryAfterMs: MIN_INTERVAL_MS - sinceLast,
        },
      });
    }

    const saved = await prisma.user.update({
      where: { id: session.user.id },
      data: {
        lastLatitude: position.latitude,
        lastLongitude: position.longitude,
        lastPositionAt: now,
      },
      select: { lastLatitude: true, lastLongitude: true, lastPositionAt: true },
    });

    return NextResponse.json({
      data: {
        saved: true,
        latitude: saved.lastLatitude,
        longitude: saved.lastLongitude,
        recordedAt: saved.lastPositionAt,
      },
    });
  } catch (error) {
    /**
     * In demo mode there is no database to write to, and this endpoint is
     * called from a background timer on the portal. Answering the failure the
     * normal way would put an error in the browser console every 45 seconds of
     * a demonstration; the portal's position handling is unaffected either way,
     * because the check-in distance is computed on the device.
     */
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("POST /api/technician/position");
      return NextResponse.json({ data: { saved: false, reason: "demo" } });
    }
    return handleRouteError(error);
  }
}
