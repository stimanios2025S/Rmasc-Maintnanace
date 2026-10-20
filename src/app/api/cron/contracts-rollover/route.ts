/**
 * Le passage planifié de reconduction et d'alertes de contrats.
 *
 * POST /api/cron/contracts-rollover            — le passage complet
 * POST /api/cron/contracts-rollover?dryRun=1   — l'aperçu, sans écriture
 *
 * POURQUOI UNE URL, QUAND UN SCRIPT EXISTE DÉJÀ
 * Le script (`scripts/contracts-rollover.ts`) est le chemin d'un poste ou d'une
 * tâche cron système. Cette route est le chemin d'un planificateur qui ne sait
 * appeler qu'une URL — et c'est le cas de la plupart des hébergeurs. Les deux
 * appellent le même module, `runContractsRollover` : une correction n'arrive
 * jamais dans l'un sans l'autre.
 *
 * DEUX FAÇONS D'ÊTRE AUTORISÉ, ET AUCUNE TROISIÈME
 *  1. `Authorization: Bearer $CONTRACTS_CRON_TOKEN` — le planificateur. La
 *     comparaison est à temps constant : un secret comparé avec `===` se laisse
 *     deviner par la mesure.
 *  2. Une session de gestion — le déclenchement manuel depuis un poste.
 *
 * Si `CONTRACTS_CRON_TOKEN` n'est pas configuré, seul le second chemin existe.
 * La route n'est donc jamais ouverte : le middleware la laisse entrer pour que
 * le jeton puisse être vérifié ici, et c'est ici que la décision se prend.
 *
 * Le mode `dryRun` lit la base mais n'écrit rien. C'est ce qui permet de voir
 * ce qu'un passage produirait avant de l'exécuter.
 */

import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { handleRouteError, jsonOk } from "@/lib/api/http";
import { MANAGEMENT_ROLES, requireRole } from "@/lib/api/guard";
import { runContractsRollover } from "@/lib/contracts/rollover";

/** Lit et écrit la base : jamais dans l'edge. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Comparaison à temps constant, et de longueur égale avant d'appeler. */
function bearerMatches(header: string | null, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7).trim(), "utf8");
  const secret = Buffer.from(expected, "utf8");
  return provided.length === secret.length && timingSafeEqual(provided, secret);
}

export async function POST(request: NextRequest) {
  try {
    const expected = process.env.CONTRACTS_CRON_TOKEN?.trim() ?? "";
    const tokenAccepted =
      expected.length > 0 &&
      bearerMatches(request.headers.get("authorization"), expected);

    if (!tokenAccepted) {
      // Une session de gestion suffit. Sans jeton configuré, c'est le seul
      // chemin — et `requireRole` lève une 401 nommée sinon.
      await requireRole(...MANAGEMENT_ROLES);
    }

    const flag = request.nextUrl.searchParams.get("dryRun");
    const dryRun = flag === "1" || flag === "true";

    const outcome = await runContractsRollover({ dryRun });
    return jsonOk(outcome);
  } catch (error) {
    return handleRouteError(error);
  }
}
