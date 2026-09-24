/**
 * Shared HTTP plumbing for route handlers.
 *
 * Centralises the error contract, pagination parsing and validation-response
 * shaping so every endpoint behaves identically. Previously each route
 * re-implemented its own `try/catch`, and the query-parameter parsing had
 * diverged between routes (some clamped `limit`, some did not; none handled
 * non-numeric input, so `?limit=abc` produced a Prisma error and a 500).
 */

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { isDatabaseUnreachable } from "@/lib/db/errors";

// ─── Error taxonomy ─────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, message, details);
export const unauthorized = (message = "Authentication required") =>
  new ApiError(401, message);
export const forbidden = (message = "Insufficient permissions") =>
  new ApiError(403, message);
export const notFound = (message: string) => new ApiError(404, message);
export const conflict = (message: string) => new ApiError(409, message);

// ─── Responses ──────────────────────────────────────────────

export function jsonOk<T>(data: T, status = 200) {
  return NextResponse.json({ data }, { status });
}

export function jsonError(
  status: number,
  error: string,
  details?: unknown
) {
  return NextResponse.json(
    details === undefined ? { error } : { error, details },
    { status }
  );
}

/**
 * Single place where a thrown value becomes an HTTP response.
 *
 * Zod issues become a 400 with a field-level breakdown; `ApiError` carries
 * its own status; `PrismaClientKnownRequestError` codes are mapped to
 * meaningful statuses (notably P2025 -> 404, which previously surfaced as a
 * 500 from `findUniqueOrThrow`); anything else is logged and reported as a
 * 500 without leaking internals to the client.
 */
export function handleRouteError(error: unknown): NextResponse {
  // Next.js uses thrown errors as control flow and identifies them by `digest`.
  // A blanket catch must let these through untouched:
  //   - DYNAMIC_SERVER_USAGE: `headers()`/`cookies()` accessed during static
  //     generation — swallowing it logs a bogus 500 and hides the signal Next
  //     needs to mark the route dynamic.
  //   - NEXT_REDIRECT / NEXT_NOT_FOUND: `redirect()` and `notFound()`.
  const digest = (error as { digest?: unknown })?.digest;
  if (
    typeof digest === "string" &&
    (digest === "DYNAMIC_SERVER_USAGE" ||
      digest === "NEXT_REDIRECT" ||
      digest === "NEXT_NOT_FOUND")
  ) {
    throw error;
  }

  if (error instanceof ZodError) {
    return jsonError(400, "Validation failed", {
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  if (error instanceof ApiError) {
    return jsonError(error.status, error.message, error.details);
  }

  // An unreachable database is an availability problem, not a defect. It gets
  // its own status so the UI can say "database unavailable" rather than the
  // generic failure, and so genuine bugs keep the 500 bucket to themselves.
  //
  // This is checked before the `P`-code switch below: `PrismaClientInitializationError`
  // is not always accompanied by a `code`, and when it is, the code describes
  // the connection rather than a query, so the generic "Database error" reply
  // would be misleading.
  if (isDatabaseUnreachable(error)) {
    console.error(
      "[api] database unreachable:",
      (error as { message?: string }).message ?? error
    );
    return jsonError(503, "Database unavailable", {
      code: "DATABASE_UNAVAILABLE",
      hint:
        "Start PostgreSQL, then run `npm run db:push` and `npm run db:seed`. " +
        "For a UI-only preview with no database, set DEMO_DATA=\"true\" in .env.",
    });
  }

  const prismaCode = (error as { code?: string })?.code;
  if (typeof prismaCode === "string" && prismaCode.startsWith("P")) {
    switch (prismaCode) {
      case "P2025":
        return jsonError(404, "Resource not found");
      case "P2002":
        return jsonError(409, "Resource already exists");
      case "P2003":
        return jsonError(409, "Referenced resource does not exist");
      default:
        console.error("[api] prisma error", prismaCode, error);
        return jsonError(500, "Database error");
    }
  }

  console.error("[api] unhandled error:", error);
  return jsonError(500, "Internal server error");
}

// ─── Query parameter parsing ────────────────────────────────

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface Pagination {
  page: number;
  limit: number;
  skip: number;
}

/**
 * Parses `page` / `limit` defensively.
 *
 * `limit` is clamped to [1, MAX_LIMIT] and `skip` is derived from the
 * *clamped* limit, so `take` and `skip` always agree. Non-numeric, zero,
 * negative and absurd values all fall back to sane defaults instead of
 * reaching Prisma as `NaN`, which previously produced a 500.
 */
export function parsePagination(
  searchParams: URLSearchParams,
  options: { defaultLimit?: number; maxLimit?: number } = {}
): Pagination {
  const maxLimit = options.maxLimit ?? MAX_LIMIT;
  const defaultLimit = Math.min(options.defaultLimit ?? DEFAULT_LIMIT, maxLimit);

  const rawLimit = Number.parseInt(searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), maxLimit)
    : defaultLimit;

  const rawPage = Number.parseInt(searchParams.get("page") ?? "", 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  return { page, limit, skip: (page - 1) * limit };
}

/** Reads an optional enum query parameter, rejecting unknown values. */
export function parseEnumParam<T extends string>(
  searchParams: URLSearchParams,
  key: string,
  allowed: readonly T[]
): T | undefined {
  const raw = searchParams.get(key);
  if (!raw) return undefined;
  if (!allowed.includes(raw as T)) {
    throw badRequest(`Invalid ${key}: ${raw}`, { allowed });
  }
  return raw as T;
}

/** Reads an optional boolean query parameter ("true"/"false"). */
export function parseBooleanParam(
  searchParams: URLSearchParams,
  key: string
): boolean | undefined {
  const raw = searchParams.get(key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === null) return undefined;
  throw badRequest(`Invalid ${key}: expected "true" or "false"`);
}

/**
 * Parses a JSON request body, converting malformed JSON into a 400 rather
 * than an unhandled exception.
 */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
}
