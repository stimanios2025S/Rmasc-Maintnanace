/**
 * Journal des mouvements de la réserve locale.
 *
 * POURQUOI CE MODULE
 * Trois routes écrivent dans le stock — le réapprovisionnement, la réservation
 * et la pose d'une pièce. Chacune doit laisser la même trace, avec la même
 * convention de signe. Écrire ce `create` trois fois aurait suffi jusqu'au
 * premier champ ajouté, puis les trois copies auraient divergé sans que rien
 * ne le signale.
 *
 * LA CONVENTION DE SIGNE
 * `quantity` est signé : positif pour une entrée, négatif pour une sortie ou
 * une réservation. La somme des lignes d'un article reconstitue sa quantité
 * courante. `ADJUSTMENT` porte la différence d'une correction d'inventaire,
 * qui peut donc être positive ou négative.
 */

import type { Prisma } from "@prisma/client";
import { notifyRoles } from "@/lib/notifications/service";
import { MANAGEMENT_ROLES } from "@/types";

export type StockMovementKind =
  | "ENTRY"
  | "EXIT"
  | "RESERVATION"
  | "ADJUSTMENT";

/** Écrit une ligne de journal dans la transaction de l'appelant. */
export async function recordStockMovement(
  db: Prisma.TransactionClient,
  input: {
    stockItemId: string;
    type: StockMovementKind;
    quantity: number;
    reason?: string | null;
    userId?: string | null;
  }
): Promise<void> {
  if (input.quantity === 0) return;

  await db.stockMovement.create({
    data: {
      stockItemId: input.stockItemId,
      type: input.type,
      quantity: input.quantity,
      reason: input.reason?.trim() || null,
      userId: input.userId ?? null,
    },
  });
}

/**
 * Prévient les rôles de gestion qu'un article est passé sous son seuil.
 *
 * APPELÉE APRÈS LA TRANSACTION, ET SEULEMENT SUR UNE BAISSE
 * Une alerte de stock est une conséquence, pas une partie de l'écriture : si
 * elle échoue, la réservation ou la réception reste valide. Et un
 * réapprovisionnement ne doit jamais déclencher « stock bas ».
 *
 * `notifyRoles` ne lève pas : une liste de destinataires vide ou une base
 * momentanément indisponible laisse le mouvement intact.
 */
export async function notifyLowStock(input: {
  reference: string;
  name: string;
  quantity: number;
  reorderThreshold: number;
}): Promise<void> {
  if (input.quantity > input.reorderThreshold) return;

  await notifyRoles(MANAGEMENT_ROLES, {
    title: `Stock bas : ${input.reference}`,
    message:
      `${input.name} — ${input.quantity} unité(s) en réserve, ` +
      `seuil d'alerte ${input.reorderThreshold}.`,
    type: "stock",
    linkUrl: "/administration/pieces",
  });
}
