/**
 * Le profil de l'entreprise, pour les écrans qui affichent un document.
 *
 * POURQUOI CETTE ROUTE
 * `/administration/devis/[id]` est un composant client : il ne peut pas lire
 * `process.env`, et dupliquer les coordonnées dans des variables `NEXT_PUBLIC_`
 * aurait créé une seconde source de vérité à côté de celle du PDF. La route
 * expose donc exactement le profil que l'en-tête imprimé utilise.
 *
 * CE QU'ELLE NE PORTE PAS
 * Aucune donnée client, aucun montant : le nom, les coordonnées, les
 * identifiants légaux et les coordonnées bancaires de l'entreprise — ce qui
 * figure déjà en tête et en pied de chaque devis remis.
 */

import { NextResponse } from "next/server";
import { companyProfile } from "@/lib/documents/charte";
import { handleRouteError } from "@/lib/api/http";

/** `charte` lit le disque pour le logo : jamais dans l'edge. */
export const runtime = "nodejs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    return NextResponse.json({ data: companyProfile() });
  } catch (error) {
    return handleRouteError(error);
  }
}
