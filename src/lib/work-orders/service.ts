/**
 * Work-order domain services shared by the ingestion, predictive and API
 * layers. Previously the "find a system user to own auto-created orders"
 * query was duplicated in three places, and the emergency-order path had a
 * de-duplication check that could never match.
 */

import { prisma } from "@/lib/db/prisma";
import { generateOrderNumber } from "@/lib/ids";
import type { Prisma } from "@prisma/client";

/** Open statuses — an order in one of these is still outstanding. */
export const OPEN_WORK_ORDER_STATUSES = [
  "OPEN",
  "ASSIGNED",
  "IN_PROGRESS",
  "ON_HOLD",
] as const;

const OPEN_STATUS_SET: ReadonlySet<string> = new Set(OPEN_WORK_ORDER_STATUSES);

/** Narrows an arbitrary status string to "still outstanding". */
export function isOpenStatus(status: string): boolean {
  return OPEN_STATUS_SET.has(status);
}

const SYSTEM_CREATOR_TTL_MS = 60_000;
let cachedCreator: { id: string | null; expiresAt: number } | null = null;

/**
 * Auto-created orders need a creator to satisfy the relation. Prefers the
 * earliest active ADMIN, falls back to a manager. Result is cached briefly so
 * the ingestion hot path does not issue this query on every reading.
 */
export async function getSystemCreatorId(): Promise<string | null> {
  const now = Date.now();
  if (cachedCreator && cachedCreator.expiresAt > now) return cachedCreator.id;

  const creator = await prisma.user.findFirst({
    where: { isActive: true, role: { in: ["ADMIN", "MAINTENANCE_MANAGER"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  cachedCreator = {
    id: creator?.id ?? null,
    expiresAt: now + SYSTEM_CREATOR_TTL_MS,
  };
  return cachedCreator.id;
}

export function invalidateSystemCreatorCache(): void {
  cachedCreator = null;
}

/**
 * Creates a work order, retrying once with a fresh order number if the
 * unique constraint on `orderNumber` is violated.
 */
export async function createWorkOrderWithUniqueNumber(
  data: Omit<Prisma.WorkOrderUncheckedCreateInput, "orderNumber">,
  kind?: string
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await prisma.workOrder.create({
        data: { ...data, orderNumber: generateOrderNumber(kind) },
      });
    } catch (error) {
      const err = error as { code?: string; meta?: { target?: unknown } };
      const target = err?.meta?.target;
      // Only retry when the collision is actually on the order number. Work
      // orders also have a unique `alertId`; retrying that would burn an
      // attempt and log a misleading message.
      const isOrderNumberCollision =
        Array.isArray(target)
          ? target.some((t) => String(t).includes("order_number"))
          : true;
      const shouldRetry =
        err?.code === "P2002" && attempt === 0 && isOrderNumberCollision;
      if (!shouldRetry) throw error;
      console.warn("[work-orders] order number collision, retrying");
    }
  }
  throw new Error("Failed to allocate a unique work order number");
}

export interface EmergencyWorkOrderInput {
  elevatorId: string;
  elevatorCode: string;
  alertId?: string;
  metricName: string;
  title: string;
  message: string;
  severity: "CRITICAL" | "EMERGENCY";
}

/**
 * Idempotently raises an emergency work order for a critical telemetry
 * breach.
 *
 * The previous implementation de-duplicated on `alertId`, but each breach
 * creates a *brand new* alert, so the lookup never matched an existing order
 * and a fresh EMERGENCY order was created for every reading. With the
 * simulator posting every two seconds that produced an unbounded flood of
 * orders for a single fault — and additionally collided on `orderNumber`,
 * because the identifier was built from a millisecond timestamp.
 *
 * De-duplication is now keyed on the fault itself: one open emergency order
 * per elevator per metric, regardless of how many alerts the fault emits.
 * Subsequent alerts are still recorded; they simply do not each spawn an
 * order.
 *
 * @returns the id of the existing or newly created order, or null when no
 *          system user exists to own it.
 */
export async function raiseEmergencyWorkOrder({
  elevatorId,
  elevatorCode,
  alertId,
  metricName,
  title,
  message,
  severity,
}: EmergencyWorkOrderInput): Promise<{ id: string; created: boolean } | null> {
  const existing = await prisma.workOrder.findFirst({
    where: {
      elevatorId,
      type: "EMERGENCY",
      status: { in: [...OPEN_WORK_ORDER_STATUSES] },
      alert: { metricName, resolvedAt: null },
    },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };

  const createdById = await getSystemCreatorId();
  if (!createdById) return null;

  const workOrder = await createWorkOrderWithUniqueNumber(
    {
      title,
      description: `${message} (Elevator: ${elevatorCode})`,
      type: "EMERGENCY",
      priority: severity === "EMERGENCY" ? "CRITICAL" : "EMERGENCY",
      elevatorId,
      alertId,
      createdById,
    },
    "EMRG"
  );

  return { id: workOrder.id, created: true };
}
