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
 *
 * EN DÉMONSTRATION, UN CATALOGUE FICTIF
 * Sans les trois variables Magasin, aucun article réel ne peut être lu. La route
 * sert alors les articles de `lib/stock/demo.ts` et le marque `demo: true` :
 * l'écran reste utilisable, et rien ne laisse croire que ces articles existent
 * dans le stock réel.
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
import {
  isStockDemoMode,
  STOCK_DEMO_ARTICLES,
  STOCK_DEMO_NOTICE,
} from "@/lib/stock/demo";

export const dynamic = "force-dynamic";

/** `node:crypto` entre par `lib/stock/client.ts`. */
export const runtime = "nodejs";

export async function GET() {
  try {
    await requireRole(...MANAGEMENT_ROLES);

    /**
     * En démonstration, le catalogue fictif remplace la lecture réelle — et
     * n'échoue donc jamais. C'est ce qui permet au sélecteur de l'écran de se
     * remplir avant même que l'instance du magasin existe.
     *
     * `demo: true` accompagne la réponse : l'écran distingue le catalogue
     * fictif d'un vrai, et le bandeau le dit à l'utilisateur.
     */
    if (isStockDemoMode()) {
      return jsonOk({
        articles: STOCK_DEMO_ARTICLES,
        total: STOCK_DEMO_ARTICLES.length,
        demo: true,
        message: STOCK_DEMO_NOTICE,
      });
    }

    const refusal = stockConfigRefusal();
    if (refusal) throw badRequest(refusal);

    const result = await fetchStockArticles();
    if (!result.ok) throw badRequest(result.error);

    return jsonOk({ articles: result.articles, total: result.articles.length });
  } catch (error) {
    return handleRouteError(error);
  }
}
