/**
 * Classification of database failures.
 *
 * Lives on its own so that both the error handler in `src/lib/api/http.ts` and
 * the demo-fallback switch in `src/lib/demo/mode.ts` can share one definition.
 * Duplicating the check would let the two drift, and the drift would be silent:
 * a route would report a database outage as a 500 while its neighbour served
 * fixtures for the same failure.
 */

/** Prisma error codes that mean "no connection", as opposed to "bad query". */
const UNREACHABLE_PRISMA_CODES = new Set([
  "P1000", // Authentication failed against the database server
  "P1001", // Can't reach database server
  "P1002", // Database server timed out
  "P1017", // Server has closed the connection
]);

/**
 * True when the failure is "the database is not there" rather than "the query
 * was wrong".
 *
 * The distinction matters: a constraint violation, a malformed query or schema
 * drift must keep surfacing as an error. Only genuine unavailability is treated
 * as an availability problem.
 */
export function isDatabaseUnreachable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  if ((error as { name?: string }).name === "PrismaClientInitializationError") {
    return true;
  }

  const code = (error as { code?: string }).code;
  if (typeof code === "string" && UNREACHABLE_PRISMA_CODES.has(code)) {
    return true;
  }

  // Node's own socket errors, and the wording the Prisma engine emits.
  const message = (error as { message?: string }).message ?? "";
  return /can't reach database server|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connection refused/i.test(
    message
  );
}
