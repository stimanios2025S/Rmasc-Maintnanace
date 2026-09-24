import { PrismaClient } from "@prisma/client";
import { getEnv } from "@/lib/config/env";

// Fail fast and readably on a missing or malformed DATABASE_URL, rather than
// with a cryptic driver error on the first query.
const env = getEnv();

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
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
