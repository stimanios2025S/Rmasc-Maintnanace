/**
 * L'ouverture d'un devis.
 *
 * POURQUOI LA NUMÉROTATION VIT ICI
 * `DEV-2026/0042` est un numéro séquentiel comme celui des factures, et il
 * porte le même genre de risque : deux demandes simultanées calculent le même
 * numéro, et la contrainte d'unicité en refuse une. La facture a résolu le
 * problème avec une boucle de réessai — voir `lib/invoices/service.ts`, qui
 * explique longuement pourquoi l'émission ne vit pas dans la transaction du bon.
 *
 * Le devis a le même besoin et une raison de plus : une demande part du
 * *portail client*, donc de quelqu'un qui n'est pas au bureau et qui ne peut
 * rien faire d'un échec. La boucle est ici, à côté du format.
 */

import { prisma } from "@/lib/db/prisma";

/**
 * `DEV-2026/0042`.
 *
 * La barre oblique est celle du formulaire — For: APP/DA/04/14 porte
 * « Devis N° : DEV-202.../.......... ». Elle est conservée parce que le bureau
 * lit et dicte ce numéro au téléphone, et qu'un numéro qui ne ressemble pas à
 * celui du papier oblige à traduire à chaque appel.
 *
 * Le millésime est en tête et la séquence repart à 1 chaque année : c'est ce
 * que le formulaire montre, et c'est ce qui permet de retrouver un devis dans
 * un classeur annuel.
 */
export function formatQuoteNumber(year: number, sequence: number): string {
  return `DEV-${year}/${String(sequence).padStart(4, "0")}`;
}

export interface NewQuoteInput {
  clientId: string | null;
  requestedById: string | null;
  buildingId: string;
  elevatorId: string | null;
  need: string;
  validityDays?: number;
}

/**
 * Le devis créé, dans la forme que la route rend.
 *
 * Écrit explicitement plutôt que dérivé de `ReturnType<typeof createQuote>` :
 * l'alias se référençait lui-même, et le compilateur ne pouvait plus typer la
 * fonction. Un type nommé se lit aussi mieux à l'appel.
 */
export interface CreatedQuote {
  id: string;
  number: string;
  status: string;
  need: string;
  createdAt: Date;
  validityDays: number;
}

/**
 * Ouvre une demande de devis.
 *
 * TROIS TENTATIVES, ET TROIS SEULEMENT — la même borne que la facture, pour la
 * même raison : une collision de numéro est un événement de concurrence qui se
 * résout en relisant, et une quatrième tentative masquerait un problème réel —
 * une base qui refuse toute écriture — derrière ce qui ressemblerait à de la
 * malchance répétée.
 */
export async function createQuote(
  input: NewQuoteInput
): Promise<CreatedQuote> {
  const year = new Date().getFullYear();

  for (let attempt = 0; attempt < 3; attempt++) {
    const last = await prisma.quote.findFirst({
      where: { year },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const sequence = (last?.sequence ?? 0) + 1;

    try {
      return await prisma.quote.create({
        data: {
          number: formatQuoteNumber(year, sequence),
          year,
          sequence,
          clientId: input.clientId,
          requestedById: input.requestedById,
          buildingId: input.buildingId,
          elevatorId: input.elevatorId,
          need: input.need,
          validityDays: input.validityDays ?? 30,
        },
        select: {
          id: true,
          number: true,
          status: true,
          need: true,
          createdAt: true,
          validityDays: true,
        },
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "P2002" || attempt === 2) throw error;
      console.warn(
        `[quotes] collision de numéro pour l'année ${year}, nouvelle tentative`
      );
    }
  }

  // Inatteignable : la boucle renvoie ou relance. Gardé pour que le type de
  // retour ne dépende pas d'une analyse que le compilateur doit deviner.
  throw new Error("Création de devis : la boucle de numérotation s'est épuisée.");
}
