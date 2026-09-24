/**
 * Demo-data fallback switch.
 *
 * WHAT IT DOES
 * When the database cannot be reached, each read endpoint serves a populated
 * fixture instead of failing, so the UI renders real-looking screens on a
 * machine with no PostgreSQL. See `src/lib/demo/dataset.ts` for the data and
 * `src/lib/demo/responses.ts` for the per-endpoint shapes.
 *
 * REAL DATA ALWAYS WINS
 * This is a *fallback*, not a replacement. Every route runs its genuine query
 * first and only reaches for the fixture inside its `catch`, and only for
 * connection-level failures. Point `DATABASE_URL` at a seeded database and the
 * demo data stops being consulted at all — there is nothing to switch off.
 *
 * IT CANNOT REACH PRODUCTION
 * As with open-access mode, `NODE_ENV === "production"` short-circuits the
 * answer to `false` before the flag is read, so a deployed build ignores
 * `DEMO_DATA` entirely and a database outage surfaces as a 503.
 *
 * That guard is the whole point. Silently serving fabricated telemetry and
 * alert history during an outage would let a real elevator fault disappear
 * behind invented "all normal" readings — the exact failure this platform
 * exists to prevent. In development the trade is worth it; in production it
 * would be indefensible.
 */

import { isDatabaseUnreachable } from "@/lib/db/errors";

/**
 * True when demo fallback is permitted in this process.
 *
 * `process.env.DEMO_DATA` is written as a literal member expression so
 * Next.js inlines it — see the note in `src/lib/auth/open-access.ts`.
 */
export function isDemoFallbackEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.DEMO_DATA === "true";
}

/**
 * True when this specific failure should be answered with fixture data.
 *
 * Routes call this from their existing `catch` block:
 *
 *   catch (error) {
 *     if (shouldServeDemoData(error)) return NextResponse.json(demoX());
 *     return handleRouteError(error);
 *   }
 */
export function shouldServeDemoData(error: unknown): boolean {
  return isDemoFallbackEnabled() && isDatabaseUnreachable(error);
}

let warned = false;

/** Logged once per process rather than once per request. */
export function warnDemoFallbackOnce(endpoint: string): void {
  if (warned) return;
  warned = true;
  console.warn(
    `[demo] database unreachable — ${endpoint} and other read endpoints are ` +
      "serving fixture data (DEMO_DATA=true). Set DEMO_DATA=\"false\" in .env " +
      "to get 503s instead, or start PostgreSQL for real data."
  );
}
