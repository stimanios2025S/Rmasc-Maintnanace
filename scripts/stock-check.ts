/**
 * Vérifie la liaison au magasin central — **lecture seule**.
 *
 *   set -a; . ./.env; set +a; npx tsx scripts/stock-check.ts
 *
 * POURQUOI CE SCRIPT EXISTE
 * `GET /api/v1/external/stock` ne modifie rien : c'est la seule requête signée
 * qui prouve les identifiants sans créer de demande dans la base du magasin.
 * Tant qu'elle n'est pas passée, la signature n'est vérifiée que contre le
 * contrat écrit — jamais contre le vérificateur réel.
 *
 * IL RÉUTILISE `buildStockSignature`
 * Signer à la main ici testerait une seconde implémentation, pas celle qui
 * transmettra les demandes. Le script importe donc la fonction du client
 * lui-même ; tsx l'exécute depuis la source, sans build Next.
 *
 * IL N'AFFICHE NI LA CLÉ NI LE SECRET.
 */

import {
  buildStockSignature,
  stockConfigRefusal,
} from "../src/lib/stock/client";

/** Le seul point d'entrée signé qui ne modifie rien. */
const PATHNAME = "/api/v1/external/stock";
const TIMEOUT_MS = 10_000;

async function main() {
  const refusal = stockConfigRefusal();
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }

  const baseUrl = (process.env.STOCK_API_URL ?? "").trim().replace(/\/+$/, "");
  const key = (process.env.STOCK_API_KEY ?? "").trim();
  const secret = (process.env.STOCK_API_SECRET ?? "").trim();

  const timestamp = Math.floor(Date.now() / 1000);
  /** Une requête GET se signe avec un corps vide. */
  const rawBody = "";

  const signature = buildStockSignature({
    timestamp,
    method: "GET",
    pathname: PATHNAME,
    rawBody,
    secret,
  });

  const url = `${baseUrl}${PATHNAME}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        "x-rmasc-key": key,
        "x-rmasc-timestamp": String(timestamp),
        "x-rmasc-signature": signature,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: string }).name;
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      name === "TimeoutError" || name === "AbortError"
        ? `ÉCHEC : aucune réponse en ${TIMEOUT_MS / 1000} s (${url}).`
        : `ÉCHEC : injoignable (${url}) — ${message}`
    );
    process.exit(1);
  }

  const text = await response.text();

  console.log(`URL      : ${url}`);
  console.log(`HTTP     : ${response.status}`);
  console.log(`CONTENU  : ${text.slice(0, 4000) || "(vide)"}`);

  if (!response.ok) {
    console.error(
      "\nÉCHEC : le magasin central a refusé la requête signée. " +
        "Vérifier STOCK_API_KEY / STOCK_API_SECRET et l'horloge (tolérance ±300 s)."
    );
    process.exit(1);
  }

  console.log("\n✓ Signature acceptée par STOCK RMASC (lecture seule).");
  console.log("  La liaison est prouvée contre le vérificateur réel.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
