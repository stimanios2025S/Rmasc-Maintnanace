/**
 * La couverture contractuelle telle que les écrans la lisent.
 *
 * POURQUOI UN TYPE À PART DE CELUI DU REGISTRE
 * Le registre des contrats est un écran du bureau : il porte le montant, la
 * devise, l'adresse du client et son historique. Un badge sur une fiche
 * d'ascenseur, et plus encore le portail client, n'ont besoin que de la
 * couverture : quel palier, quels engagements, quelles dates, quels immeubles.
 * Servir la ligne entière à ces écrans exposerait des montants à des rôles qui
 * n'ont pas à les lire — et un jour quelqu'un les afficherait « puisqu'ils sont
 * là ».
 *
 * Module pur : aucun Prisma, aucun nœud serveur. Il est importé par des
 * composants client, comme `status.ts`.
 */

import type { ExpiryLevel } from "@/lib/contracts/status";
import type {
  ContractRenewalMode,
  ContractStatus,
  SLATier,
} from "@/types";

export interface CoverageContract {
  id: string;
  reference: string;
  /** Le palier engagé par le contrat — pas celui de l'immeuble. */
  slaTier: SLATier;
  /** L'état enregistré. */
  status: ContractStatus;
  /** L'état réellement en vigueur, calculé à la date de la réponse. */
  effectiveStatus: ContractStatus;
  startsAt: string;
  endsAt: string;
  /** La fin réellement en vigueur, reconduction tacite comprise. */
  effectiveEndsAt: string;
  renewalMode: ContractRenewalMode;
  noticeDays: number;
  /** Les deux délais promis, stockés sur le contrat. */
  responseHours: number;
  interventionHours: number;
  buildings: { id: string; name: string; city: string }[];
  expiry: { level: ExpiryLevel; days: number; message: string | null };
}

/**
 * Le contrat qui couvre un immeuble, ou `null`.
 *
 * LA RÈGLE DE CHOIX
 * Un immeuble n'est couvert que par un contrat actif à la fois — c'est la règle
 * métier, contrôlée à la création et à la modification. Mais elle n'est pas une
 * contrainte de base : si deux lignes se glissent, l'écran doit choisir de
 * façon déterministe plutôt qu'afficher le premier résultat venu. Un contrat en
 * vigueur l'emporte sur un contrat suspendu, puis le plus récent l'emporte.
 */
export function contractForBuilding(
  contracts: readonly CoverageContract[],
  buildingId: string
): CoverageContract | null {
  const covering = contracts.filter((contract) =>
    contract.buildings.some((building) => building.id === buildingId)
  );

  covering.sort((a, b) => {
    const rank = (status: ContractStatus) => (status === "ACTIVE" ? 0 : 1);
    const byStatus = rank(a.effectiveStatus) - rank(b.effectiveStatus);
    if (byStatus !== 0) return byStatus;
    return new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime();
  });

  return covering[0] ?? null;
}
