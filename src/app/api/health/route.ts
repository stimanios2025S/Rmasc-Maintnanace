/**
 * ElevatorPulse – Health probe
 *
 * GET /api/health
 *
 * Public (see `src/middleware.ts`). Intended for container liveness/readiness
 * checks and for uptime monitoring.
 *
 * Returns 200 only when the process is up *and* the database answers. A
 * process that cannot reach Postgres is not healthy, and reporting 200 in that
 * state would keep a broken instance in the load-balancer rotation.
 *
 * The response deliberately omits error details, connection strings and
 * versions: this endpoint is unauthenticated, so anything it says is public.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

// Never cache, and never let Next.js try to evaluate this at build time.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const DB_TIMEOUT_MS = 3_000;

async function checkDatabase(): Promise<boolean> {
  try {
    // `$queryRaw` with a timeout so a hung database cannot hang the probe and
    // cascade into failing health checks across the whole pool.
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("database probe timed out")), DB_TIMEOUT_MS)
      ),
    ]);
    return true;
  } catch (error) {
    // Logged server-side only; the response body stays generic.
    console.error("[health] database probe failed", error);
    return false;
  }
}

export async function GET() {
  const database = await checkDatabase();

  const body = {
    status: database ? "ok" : "degraded",
    checks: { database },
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(body, {
    status: database ? 200 : 503,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
