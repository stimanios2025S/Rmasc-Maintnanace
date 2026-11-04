/**
 * Démarrage de développement avec un heap Node de 4 Go.
 *
 * POURQUOI CE LAUNCHER
 * `next dev` compile en parallèle dans des processus enfants (jest-worker).
 * Ce sont eux qui meurent les premiers quand la mémoire manque, et l'erreur
 * remonte sous la forme « Jest worker encountered N child process exceptions ».
 * Un `node --max-old-space-size=4096` sur le processus parent ne les aide pas :
 * la limite est fixée à la naissance de chaque enfant. `NODE_OPTIONS`, lui, est
 * hérité par toute la descendance — c'est donc la variable qu'on pose ici.
 *
 *   npm run dev:mem
 *
 * `npm run dev` reste le lancement standard, sans réglage mémoire.
 */
import { spawn } from "node:child_process";
import path from "node:path";

const nextBin = path.resolve("node_modules/next/dist/bin/next");

const child = spawn(
  process.execPath,
  [nextBin, "dev", "-H", "127.0.0.1", "-p", "3000"],
  {
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },
  }
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code) => process.exit(code ?? 0));
