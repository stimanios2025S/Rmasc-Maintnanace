/**
 * Route-handler authorisation guards.
 *
 * `src/middleware.ts` keeps anonymous traffic out of `/api/*`, but it does
 * *not* perform any role checks on API routes, and middleware is an easy
 * thing to accidentally widen (its matcher is a glob list). These guards are
 * the authoritative authorisation boundary and run inside each handler.
 *
 * Usage:
 *   const session = await requireRole("ADMIN", "MAINTENANCE_MANAGER");
 */

import { getServerSession } from "next-auth";
import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth/options";
import {
  isOpenAccessEnabled,
  openAccessSession,
} from "@/lib/auth/open-access";
import {
  DISPATCHABLE_TECHNICIAN_STATUSES,
  MANAGEMENT_ROLES,
  OPS_ROLES,
} from "@/types";
import type { UserRole } from "@/types";
import { forbidden, unauthorized } from "./http";

// Re-exported for existing server-side call sites. The definitions themselves
// live in `@/types` so client components can use them without importing this
// module (and, transitively, the Prisma client).
export { MANAGEMENT_ROLES, OPS_ROLES };

/**
 * The single place every handler reads the caller's identity from.
 *
 * Open-access mode is intercepted *here* rather than inside `authOptions` so
 * that the real NextAuth machinery — providers, JWT callbacks, the session
 * cookie — keeps working untouched and turning the flag off restores normal
 * behaviour with nothing to unwind.
 */
export async function getSession(): Promise<Session | null> {
  if (isOpenAccessEnabled()) return openAccessSession();
  return getServerSession(authOptions);
}

/** Requires any authenticated user. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session?.user) throw unauthorized();
  return session;
}

/** Requires an authenticated user holding one of `roles`. */
export async function requireRole(
  ...roles: readonly UserRole[]
): Promise<Session> {
  const session = await requireSession();
  const role = session.user.role;
  if (!role || !roles.includes(role)) {
    throw forbidden(
      `This action requires one of: ${roles.join(", ")}`
    );
  }
  return session;
}

/**
 * True when the session user is a technician acting on their own record.
 * A FIELD_TECHNICIAN may only mutate work orders assigned to them; managers
 * and admins may mutate any.
 */
export function isSelfOrManager(
  session: Session,
  ownerUserId: string | null
): boolean {
  if (session.user.role === "ADMIN") return true;
  if (session.user.role === "MAINTENANCE_MANAGER") return true;
  return ownerUserId !== null && session.user.id === ownerUserId;
}

/**
 * The `Building` filter a session is allowed to see.
 *
 * A BUILDING_OWNER is a customer account for one portfolio, not a staff
 * member: it may read its own buildings and nothing else. Every other role
 * sees the active fleet.
 *
 * This exists because the boundary was being re-derived per route and most
 * routes forgot. `/api/dashboard` scoped owners correctly while
 * `/api/elevators`, `/api/elevators/[id]`, `/api/buildings`, `/api/alerts`,
 * `/api/predictive` and `/api/telemetry` did not — so an owner who followed
 * the "Elevators" link in their own sidebar received the whole fleet,
 * including every other customer's address, site contact name, email and
 * phone number. `/api/elevators/[id]` was worse still: a bare ID lookup, so
 * any owner could read any unit's alert and work-order history by iterating
 * ids.
 *
 * Routes that authorise a BUILDING_OWNER MUST route every query through this
 * helper (directly, or via the nested `building: buildingScopeFor(session)`
 * form used by the elevator-scoped resources).
 */
export function buildingScopeFor(
  session: Session
): Prisma.BuildingWhereInput {
  return session.user.role === "BUILDING_OWNER"
    ? { isActive: true, ownerId: session.user.id }
    : { isActive: true };
}

/**
 * The `Elevator` filter a session is allowed to see — the same portfolio rule
 * as `buildingScopeFor`, expressed one relation out.
 *
 * Spread it into the WHERE clause of the read itself rather than fetching by
 * id and checking ownership afterwards. A scoped `findFirst({ where: { id,
 * ...scope } })` returns null for a unit outside the portfolio, which is
 * already the 404 the caller should receive, and an existence check that
 * leaks "this id is real but not yours" becomes impossible to write by
 * accident.
 */
export function elevatorScopeFor(
  session: Session
): Prisma.ElevatorWhereInput {
  return { isActive: true, building: buildingScopeFor(session) };
}

/**
 * The `User` filter for "work may be assigned to this person".
 *
 * Three states gate an assignment, and they are not interchangeable:
 *
 *  - `isActive` — the account exists and is enabled.
 *  - `role` — an assignee is staff. Managers assign orders to themselves too,
 *    so this is `OPS_ROLES`, not `FIELD_TECHNICIAN`.
 *  - `status` — a *technician's* dispatchability. `ON_LEAVE` and `OFF_DUTY`
 *    cannot be sent to a job; `AVAILABLE` and `ON_JOB` can, the second because
 *    work can be queued behind the job they are on.
 *
 * The status test only applies to technicians, because the column describes
 * them: an admin or manager row carries the `AVAILABLE` default and is never
 * meant to be read as a work state.
 *
 * This is the write-side rule, not a UI convenience. The dispatch roster hides
 * unavailable technicians, but a dialog holds its list from when it opened and
 * a request can be made by hand — and the assignment was previously accepted on
 * `isActive` alone, so an engineer on leave could be booked onto an emergency.
 */
export function assignableUserWhere(
  userId: string
): Prisma.UserWhereInput {
  return {
    id: userId,
    isActive: true,
    role: { in: [...OPS_ROLES] },
    OR: [
      { role: { not: "FIELD_TECHNICIAN" } },
      { status: { in: [...DISPATCHABLE_TECHNICIAN_STATUSES] } },
    ],
  };
}
