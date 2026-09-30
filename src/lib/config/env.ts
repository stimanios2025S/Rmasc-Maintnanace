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
    .min(1, "DATABASE_URL est obligatoire")
    .refine(
      (value) =>
        value.startsWith("postgresql://") || value.startsWith("postgres://"),
      "DATABASE_URL doit être une chaîne de connexion PostgreSQL"
    ),

  NEXTAUTH_URL: optionalString(z.string().url()),
  NEXTAUTH_SECRET: optionalString(z.string().min(16)),

  /** When set, POST /api/telemetry requires this bearer token. */
  IOT_INGEST_TOKEN: optionalString(z.string().min(1)),

  /**
   * The number an escalated incident is messaged on WhatsApp.
   *
   * Optional, because in-app notifications already reach every manager and a
   * deployment that has not chosen an on-call number must still boot. But
   * leaving it unset silently disables the out-of-band alert, and someone
   * will assume they are being messaged — so `getEnv` warns about it in
   * production rather than staying quiet (see below).
   */
  ADMIN_PHONE_NUMBER: optionalString(z.string().min(5)),

  // ─── WhatsApp / Evolution API ─────────────────────────────
  //
  // All four are optional, and a deployment with none of them is a normal
  // state rather than a broken one: `src/lib/notifications/whatsapp.ts` stays
  // completely inert, logs the message it would have sent, and reports
  // `no-transport` without failing any caller. Nothing needs to be switched
  // off while the Evolution instance does not exist yet.

  /**
   * Base URL of the Evolution API instance, e.g. `http://127.0.0.1:8080`.
   *
   * A trailing slash is tolerated — it is stripped before the path is joined.
   */
  EVOLUTION_API_URL: optionalString(z.string().url()),

  /**
   * The instance's API key, sent as the `apikey` header.
   *
   * A secret. It belongs in `.env` on the server and nowhere else — never in
   * the repository, never in a chat, never in a log line. The transport
   * reports Evolution's response body but never this value.
   */
  EVOLUTION_API_KEY: optionalString(z.string().min(1)),

  /** The instance name, as it appears in the Evolution dashboard. */
  EVOLUTION_INSTANCE: optionalString(z.string().min(1)),

  /**
   * The country code used to complete a number written the local way.
   *
   * `0661234567` cannot be sent as it stands: the digits mean nothing without a
   * country, and sending them anyway is how a message lands on a stranger's
   * phone. When this is set — `213` for Algeria — a leading zero is replaced
   * with it. When it is not, a number that is not already in international form
   * is refused with `bad-number` rather than guessed at.
   *
   * Digits only, no `+`.
   */
  WHATSAPP_DEFAULT_COUNTRY_CODE: optionalString(
    z.string().regex(/^\d{1,4}$/, "indicatif du pays attendu, chiffres seulement")
  ),
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
      `Configuration d'environnement invalide :\n${issues}\n\n` +
        "Voir .env.example pour la liste des variables attendues."
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
        "NEXTAUTH_SECRET est obligatoire en production (à générer avec : openssl rand -base64 32)"
      );
    }
    if (!env.NEXTAUTH_URL) {
      problems.push("NEXTAUTH_URL est obligatoire en production");
    }
    if (!env.IOT_INGEST_TOKEN) {
      // Not fatal — some deployments terminate telemetry at a gateway — but
      // an unauthenticated write endpoint on the public internet is worth
      // shouting about.
      console.warn(
        "[env] IOT_INGEST_TOKEN n'est pas défini en production : POST /api/telemetry acceptera des écritures non authentifiées."
      );
    }
    if (!env.ADMIN_PHONE_NUMBER) {
      // Also not fatal, and also worth saying out loud. The alternative is a
      // silent gap: escalations keep working, the in-app bell keeps ringing,
      // and the one channel that reaches somebody who is not looking at the
      // dashboard is simply off — which nobody notices until an emergency
      // goes unanswered.
      console.warn(
        "[env] ADMIN_PHONE_NUMBER n'est pas défini : aucune alerte WhatsApp ne sera envoyée lors d'une escalade. " +
          "Les notifications in-app restent actives."
      );
    }
  }

  /**
   * A half-configured WhatsApp instance, which is the one shape of this
   * configuration that lies.
   *
   * All three set and the messages go out. None set and the module says so
   * loudly and does nothing, which is honest and obvious. Two of three set is
   * the dangerous middle: it looks like a working deployment from `.env`, and
   * every send quietly reports `no-transport` because one variable is missing.
   * Checked in every environment rather than only in production, because this
   * is exactly the mistake made while setting it up for the first time.
   */
  const evolutionParts = [
    ["EVOLUTION_API_URL", env.EVOLUTION_API_URL],
    ["EVOLUTION_API_KEY", env.EVOLUTION_API_KEY],
    ["EVOLUTION_INSTANCE", env.EVOLUTION_INSTANCE],
  ] as const;
  const evolutionSet = evolutionParts.filter(([, value]) => Boolean(value));
  if (evolutionSet.length > 0 && evolutionSet.length < evolutionParts.length) {
    const missing = evolutionParts
      .filter(([, value]) => !value)
      .map(([name]) => name)
      .join(", ");
    console.warn(
      `[env] Configuration WhatsApp incomplète : ${missing} manque${
        missing.includes(",") ? "nt" : ""
      }. ` +
        "Aucun message WhatsApp ne partira tant que les trois ne sont pas définies. " +
        "Voir .env.example."
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Configuration d'environnement invalide :\n${problems
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
