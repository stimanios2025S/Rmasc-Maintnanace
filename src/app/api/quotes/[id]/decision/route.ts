/**
 * La décision du client sur un devis remis.
 *
 * POST /api/quotes/[id]/decision   { decision: "ACCEPT" | "REFUSE" }
 *
 * POURQUOI UNE ROUTE À PART
 * `PATCH /api/quotes` est le poste du bureau : il modifie les lignes, les
 * notes, l'état d'envoi. Un client n'a rien à y faire, et lui ouvrir la route
 * pour deux boutons exposerait tout le reste. Ici, le seul geste possible est
 * d'accepter ou de refuser une offre *déjà remise* — c'est-à-dire exactement ce
 * que le papier demande au bas de la page.
 *
 * CE QUI N'EST PAS PERMIS
 * Un devis `REQUESTED` n'a pas encore de prix : l'accepter reviendrait à signer
 * une page blanche. `quoteTransitionRefusal` refuse toute décision hors de
 * l'état `SENT`, et c'est la même fonction que le bureau lit.
 *
 * CLoisonnement : un compte client ne voit que ses devis. La condition est
 * dans la requête, pas dans un test après lecture — un identifiant d'un autre
 * client rend « introuvable », pas « interdit ».
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  badRequest,
  handleRouteError,
  jsonOk,
  notFound,
  readJson,
} from "@/lib/api/http";
import { requireRole } from "@/lib/api/guard";
import { quoteTransitionRefusal } from "@/lib/quotes/status";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import type { QuoteStatus } from "@/types";

export const dynamic = "force-dynamic";

const DecisionSchema = z
  .object({
    decision: z.enum(["ACCEPT", "REFUSE"], {
      errorMap: () => ({
        message: "Décision attendue : « ACCEPT » ou « REFUSE »",
      }),
    }),
  })
  .strict();

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  let decision: { decision: "ACCEPT" | "REFUSE" } | null = null;

  try {
    /**
     * Un client décide pour lui-même. L'administrateur est admis pour la même
     * raison que le portail lui est ouvert : il doit pouvoir constater ce que
     * le client voit, et une démonstration sans PostgreSQL n'a pas de compte
     * client pour le faire.
     */
    const session = await requireRole("BUILDING_OWNER", "ADMIN");
    decision = DecisionSchema.parse(await readJson(request));

    const quote = await prisma.quote.findFirst({
      where: {
        id: params.id,
        ...(session.user.role === "BUILDING_OWNER"
          ? { clientId: session.user.id }
          : {}),
      },
      select: {
        id: true,
        number: true,
        status: true,
        clientId: true,
      },
    });

    if (!quote) throw notFound(`Devis introuvable : ${params.id}`);

    const nextStatus: QuoteStatus =
      decision.decision === "ACCEPT" ? "ACCEPTED" : "REFUSED";

    const refusal = quoteTransitionRefusal(
      quote.status as QuoteStatus,
      nextStatus,
      []
    );
    if (refusal) throw badRequest(refusal);

    const updated = await prisma.quote.update({
      where: { id: quote.id },
      data: {
        status: nextStatus,
        decidedAt: new Date(),
        decidedById: session.user.id,
      },
      select: { id: true, number: true, status: true, decidedAt: true },
    });

    return jsonOk({ quote: updated });
  } catch (error) {
    /**
     * Mode démonstration : la décision est acquittée, pas écrite.
     *
     * La page met sa ligne à jour localement et affiche le message « en mode
     * démonstration ». Rien n'est conservé, comme pour les autres écritures de
     * démonstration.
     */
    if (decision && shouldServeDemoData(error)) {
      warnDemoFallbackOnce("POST /api/quotes/[id]/decision");
      return NextResponse.json({
        data: {
          quote: {
            id: params.id,
            status: decision.decision === "ACCEPT" ? "ACCEPTED" : "REFUSED",
            decidedAt: new Date().toISOString(),
          },
        },
        demo: true,
      });
    }
    return handleRouteError(error);
  }
}
