/**
 * Maintenance RMASC – le catalogue du magasin central, en lecture seule.
 *
 * GET /api/parts-replacement/stock-catalogue
 *
 * POURQUOI CETTE ROUTE EXISTE
 * Le magasin refuse une ligne de demande sans `codeRef`. Notre application n'a
 * aucun catalogue d'articles : le chef de service technique doit donc choisir
 * l'article du magasin qui correspond à la pièce demandée, et pour choisir il
 * faut les voir.
 *
 * C'EST UN RELAIS, PAS UNE COPIE
 * Le catalogue est lu à chaque appel depuis le magasin. Le stocker ici
 * produirait une seconde vérité qui divergerait au premier réapprovisionnement,
 * et l'écran proposerait des articles qui n'existent plus.
 *
 * RÉSERVÉ AUX RÔLES DE GESTION
 * Comme la transmission elle-même : consulter le stock n'est pas un geste du
 * terrain, et l'écran qui s'en sert est celui du bureau.
 */

import {
  badRequest,
  handleRouteError,
  jsonOk,
} from "@/lib/api/http";
import { MANAGEMENT_ROLES, requireRole } from "@/lib/api/guard";
import {
  fetchStockArticles,
  stockConfigRefusal,
} from "@/lib/stock/client";

export const dynamic = "force-dynamic";

/** `node:crypto` entre par `lib/stock/client.ts`. */
export const runtime = "nodejs";

export async function GET() {
  try {
    await requireRole(...MANAGEMENT_ROLES);

    const refusal = stockConfigRefusal();
    if (refusal) throw badRequest(refusal);

    const result = await fetchStockArticles();
    if (!result.ok) throw badRequest(result.error);

    return jsonOk({ articles: result.articles, total: result.articles.length });
  } catch (error) {
    return handleRouteError(error);
  }
}
