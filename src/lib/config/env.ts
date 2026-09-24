/**
 * Runtime environment validation.
 *
 * Validated once on first import and cached. Imported from the Prisma client
 * module, which every data-touching route already depends on, so a
 * misconfiguration surfaces immediately with a readable message instead of a
 * confusing failure deep inside a query or an auth callback.
 *
 * Note the deliberate lack of a default for NEXTAUTH_SECRET in production:
 * the shipped `.env.example` previously contained the literal placeholder
 * "change-me-in-production", which meant a deployment that simply copied the
 * example ran with a publicly known signing key. Better to refuse to start.
 */

import { z } from "zod";

/**
 * `.env` files express "not set" as `KEY=""` at least as often as they omit the
 * line entirely. Without this, the shipped `.env.example` — which sets
 * `NEXTAUTH_SECRET=""` and `IOT_INGEST_TOKEN=""` — would fail validation with
 * "must contain at least 1 character" on a perfectly normal local setup.
 */
const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = (schema: z.ZodString) =>
  z.preprocess(emptyToUndefined, schema.optional());

const ServerEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (value) =>
        value.startsWith("postgresql://") || value.startsWith("postgres://"),
      "DATABASE_URL must be a PostgreSQL connection string"
    ),

  NEXTAUTH_URL: optionalString(z.string().url()),
  NEXTAUTH_SECRET: optionalString(z.string().min(16)),

  /** When set, POST /api/telemetry requires this bearer token. */
  IOT_INGEST_TOKEN: optionalString(z.string().min(1)),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let cached: ServerEnv | null = null;

/**
 * `next build` imports every route module to collect metadata, which would
 * otherwise make a missing runtime secret fail the *build* rather than the
 * deployment. Validation is therefore skipped while the production bundle is
 * being compiled; it still runs in full on server start.
 */
function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

export function getEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = ServerEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    if (isBuildPhase()) {
      // Best-effort defaults; nothing connects to the database during a build.
      cached = ServerEnvSchema.parse({
        NODE_ENV: process.env.NODE_ENV ?? "production",
        DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://build:build@localhost:5432/build",
        NEXTAUTH_URL: process.env.NEXTAUTH_URL,
        NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
        IOT_INGEST_TOKEN: process.env.IOT_INGEST_TOKEN,
      });
      return cached;
    }

    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\nSee .env.example for the expected variables.`
    );
  }

  const env = parsed.data;

  if (isBuildPhase()) {
    cached = env;
    return cached;
  }

  const problems: string[] = [];

  if (env.NODE_ENV === "production") {
    if (!env.NEXTAUTH_SECRET) {
      problems.push(
        "NEXTAUTH_SECRET is required in production (generate with: openssl rand -base64 32)"
      );
    }
    if (!env.NEXTAUTH_URL) {
      problems.push("NEXTAUTH_URL is required in production");
    }
    if (!env.IOT_INGEST_TOKEN) {
      // Not fatal — some deployments terminate telemetry at a gateway — but
      // an unauthenticated write endpoint on the public internet is worth
      // shouting about.
      console.warn(
        "[env] IOT_INGEST_TOKEN is unset in production: POST /api/telemetry will accept unauthenticated writes."
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${problems
        .map((p) => `  - ${p}`)
        .join("\n")}`
    );
  }

  cached = env;
  return env;
}

/** Test seam. */
export function resetEnvCache(): void {
  cached = null;
}
