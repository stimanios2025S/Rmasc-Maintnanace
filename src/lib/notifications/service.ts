/**
 * Notification pipeline.
 *
 * The `Notification` model has existed since the first schema but nothing ever
 * wrote to it — the one place that did (work-order dispatch) created the row
 * inline, in its own try/catch, with its own copy of the reasoning. This
 * module is that reasoning, written down once.
 *
 * THE ONE RULE
 * A notification is a courtesy, never a precondition. Every function here
 * swallows its own failures and logs them. That is deliberate: by the time one
 * of these is called, the real work — the assignment, the escalation, the
 * closure — has already been committed. Letting a failed notification bubble
 * would report a successful dispatch as a failed request, and the caller would
 * retry straight into "already assigned by another request" on an order that
 * is in fact assigned correctly.
 *
 * That is also why these are *not* wrapped in a transaction with their
 * caller's work. A notification that rolls back an escalation is worse than a
 * notification that never arrives.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { UserRole } from "@/types";

/** Anything that can run a Prisma write — the client or a transaction. */
type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Matches the free-text `type` column on `Notification`. It is a plain
 * `String` in the schema rather than an enum, so this union is the only
 * enforcement there is — keep it in step with the schema comment.
 */
export type NotificationType =
  | "alert"
  | "work_order"
  | "incident"
  | "inspection"
  | "system";

export interface NotifyInput {
  userId: string;
  title: string;
  message: string;
  type: NotificationType;
  /** In-app path the notification should open, e.g. `/administration/incidents`. */
  linkUrl?: string;
}

/**
 * Writes one notification. Never throws.
 *
 * Pass `db` to run inside a caller's transaction; omit it to write standalone
 * (which is the normal case — see the note above about not coupling these to
 * the work they announce).
 */
export async function notify(
  input: NotifyInput,
  db: Db = prisma
): Promise<void> {
  try {
    await db.notification.create({
      data: {
        userId: input.userId,
        title: input.title,
        message: input.message,
        type: input.type,
        ...(input.linkUrl ? { linkUrl: input.linkUrl } : {}),
      },
    });
  } catch (error) {
    console.error(
      `[notify] failed to notify user ${input.userId} (${input.type})`,
      error
    );
  }
}

/** Writes the same notification to several users. Never throws. */
export async function notifyMany(
  userIds: readonly string[],
  input: Omit<NotifyInput, "userId">,
  db: Db = prisma
): Promise<void> {
  if (userIds.length === 0) return;

  try {
    await db.notification.createMany({
      data: userIds.map((userId) => ({
        userId,
        title: input.title,
        message: input.message,
        type: input.type,
        linkUrl: input.linkUrl ?? null,
      })),
    });
  } catch (error) {
    console.error(`[notify] failed to notify ${userIds.length} users`, error);
  }
}

/**
 * Notifies every active user holding one of `roles`.
 *
 * Used for the "someone needs to look at this" direction — an escalated
 * incident goes to whoever dispatches, not to a named individual. Resolving
 * the roster here rather than at the call site keeps the two escalation paths
 * (customer says "not resolved", customer hits the emergency button) from
 * each inventing their own idea of who should hear about it.
 */
export async function notifyRoles(
  roles: readonly UserRole[],
  input: Omit<NotifyInput, "userId">,
  db: Db = prisma
): Promise<void> {
  try {
    const users = await db.user.findMany({
      where: { role: { in: [...roles] }, isActive: true },
      select: { id: true },
    });
    await notifyMany(
      users.map((user) => user.id),
      input,
      db
    );
  } catch (error) {
    console.error("[notify] failed to resolve role recipients", error);
  }
}
