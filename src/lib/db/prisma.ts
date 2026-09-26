import { PrismaClient } from "@prisma/client";
import { getEnv } from "@/lib/config/env";
import { logSmsTransport } from "@/lib/notifications/sms";

// Fail fast and readably on a missing or malformed DATABASE_URL, rather than
// with a cryptic driver error on the first query.
const env = getEnv();

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Separate global: this one outlives the client across hot reloads.
const globalForStartup = globalThis as unknown as {
  __smsNoticeLogged?: true;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

// Reuse the client across hot reloads in development so we do not exhaust
// the connection pool. In production a single instance is created per
// process, which is what we want.
if (env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * Says once, at boot, whether an escalated incident actually reaches a phone.
 *
 * This module is the right host for it because every data-touching route
 * imports `prisma` before it can raise or read an incident, so the warning has
 * certainly run by the time one could be missed. `sms.ts` is safe to import
 * here: it reads `getEnv` only inside its functions, never at module scope, so
 * it cannot turn a malformed environment into an import-time crash — and this
 * file already calls `getEnv()` on the line above anyway.
 *
 * Guarded on the global so a development hot reload does not repeat it, and
 * skipped while the production bundle is being compiled — `next build`
 * imports every route module to collect metadata, which would otherwise smear
 * this notice across the build output and read as a problem with the build
 * rather than a fact about the deployment. It runs on server start, which is
 * when somebody is actually looking.
 */
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

if (!isBuildPhase && !globalForStartup.__smsNoticeLogged) {
  globalForStartup.__smsNoticeLogged = true;
  logSmsTransport();
}
