/**
 * Reconduction tacite et alertes d'échéance des contrats — passage manuel.
 *
 *   npx tsx scripts/contracts-rollover.ts --dry-run
 *   npx tsx scripts/contracts-rollover.ts
 *
 * Le même module que `POST /api/cron/contracts-rollover` : ce script est le
 * chemin d'un planificateur système, la route celui d'un planificateur HTTP.
 *
 * `--dry-run` lit la base et rapporte ce qui serait fait, sans écrire. C'est le
 * mode à utiliser pour vérifier un déploiement avant de laisser un cron écrire
 * des dates de contrats.
 *
 * POURQUOI `.env` EST LU ICI
 * Next charge `.env` tout seul ; un script `tsx` non. Sans cette lecture,
 * `getEnv()` lèverait avant même la première requête et l'erreur parlerait de
 * configuration plutôt que du travail demandé. Le fichier est lu avant
 * l'import dynamique du module, parce qu'un import statique serait évalué avant
 * la première ligne de `main`.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RolloverOutcome } from "../src/lib/contracts/rollover";

/**
 * Lecture minimale d'un `.env` : `CLÉ=valeur`, guillemets optionnels, `#` en
 * début de ligne. Pas d'expansion de variables, pas de `export` — le fichier du
 * projet n'en contient pas, et en inventer serait une deuxième syntaxe.
 */
function loadEnvFile(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function day(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 10);
}

/** Le compte rendu, tel qu'un opérateur le lit dans un terminal. */
function report(outcome: RolloverOutcome, dryRun: boolean): void {
  // ─── Reconductions ────────────────────────────────────────
  if (outcome.renewed.length === 0) {
    console.log("· Aucune reconduction tacite à matérialiser.");
  } else {
    console.log(`· ${outcome.renewed.length} reconduction(s) :`);
    for (const renewal of outcome.renewed) {
      console.log(
        `    ${renewal.reference} — ${day(renewal.previousEndsAt)} → ${day(
          renewal.newEndsAt
        )} (${renewal.clientName})`
      );
    }
  }

  // ─── Alertes ──────────────────────────────────────────────
  if (outcome.alerts.length === 0) {
    console.log("· Aucun contrat dans la fenêtre de préavis.");
  } else {
    console.log(`· ${outcome.alerts.length} contrat(s) en fenêtre de préavis :`);
    for (const notice of outcome.alerts) {
      const state = notice.alreadyNotified
        ? "déjà notifié"
        : notice.notified
          ? "notifié"
          : "serait notifié";
      console.log(
        `    ${notice.reference} — ${notice.level === "urgent" ? "30 j" : "60 j"} ` +
          `(J-${notice.days}) · ${state}`
      );
    }
  }

  // ─── WhatsApp ─────────────────────────────────────────────
  if (!outcome.whatsapp.attempted) {
    console.log(`· WhatsApp non sollicité (${outcome.whatsapp.reason ?? "—"}).`);
  } else if (outcome.whatsapp.delivered) {
    console.log("· Résumé WhatsApp accepté par le transport.");
  } else {
    console.log(
      `· Résumé WhatsApp non délivré (${outcome.whatsapp.reason ?? "raison inconnue"}).`
    );
  }

  console.log(
    dryRun ? "\nTerminé — rien n'a été écrit." : "\nTerminé — écritures appliquées."
  );
}

async function main(): Promise<void> {
  loadEnvFile();

  const dryRun = process.argv.includes("--dry-run");

  // Imports dynamiques : les modules (et `getEnv`) ne sont évalués qu'une fois
  // `.env` chargé. Un import statique serait hissé au-dessus de `loadEnvFile()`.
  const { runContractsRollover } = await import(
    "../src/lib/contracts/rollover"
  );
  const { prisma } = await import("../src/lib/db/prisma");

  console.log(
    dryRun
      ? "Mode aperçu — aucune écriture ne sera faite.\n"
      : "Passage réel — les reconductions et les notifications seront écrites.\n"
  );

  try {
    const outcome = await runContractsRollover({ dryRun });
    report(outcome, dryRun);
  } finally {
    // Sans cela, le moteur de requête garde le processus en vie après le
    // dernier `console.log` : un script qui semble terminé mais ne rend pas la
    // main est le défaut classique d'un passage planifié.
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(
    "\nPassage interrompu :",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
});
