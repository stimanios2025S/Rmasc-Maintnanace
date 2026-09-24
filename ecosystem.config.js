/**
 * Configuration pm2 — Rmasc Maintenance (ElevatorPulse)
 *
 * Le processus permanent de l'application sur le serveur. Toutes les valeurs
 * modifiables sont en haut du fichier `apps[0]`.
 *
 * POURQUOI `fork` ET UNE SEULE INSTANCE
 * Le mode cluster de pm2 lancerait plusieurs serveurs Next.js derrière le même
 * port. L'application n'a aucun état en mémoire partagé (le cache pub/sub en
 * mémoire a été supprimé plutôt que laissé trompeur) et les sessions sont des
 * JWT, donc le cluster fonctionnerait — mais chaque instance ouvrirait son
 * propre pool de connexions Prisma, et le serveur héberge déjà d'autres
 * applications. Une instance, dimensionnée par `max_memory_restart`, est le
 * réglage honnête pour cette charge. Passer à `instances: 2` se fait ici, le
 * jour où la charge le justifie.
 *
 * POURQUOI `script` POINTE VERS LE BINAIRE DE NEXT
 * `pm2 start npm -- start` fonctionne mais fait de npm un processus
 * intermédiaire : pm2 surveille npm, pas Next.js. En visant directement le
 * binaire, le redémarrage, la mémoire et les signaux d'arrêt s'adressent au
 * vrai processus.
 */

module.exports = {
  apps: [
    {
      name: "rmasc-maintenance",

      // Le dossier d'où pm2 est appelé — donc la racine du projet cloné.
      cwd: __dirname,

      script: "node_modules/next/dist/bin/next",

      /**
       * Le port. DOIT être libre sur le serveur : vérifier avant avec
       * `ss -tlnp | grep :3010`. Si 3010 est pris, changer ici ET dans la
       * configuration du tunnel Cloudflare.
       */
      args: "start -p 3010",

      instances: 1,
      exec_mode: "fork",

      autorestart: true,
      watch: false,

      // Redémarre si le processus dépasse cette mémoire. Une fuite se traduit
      // par un redémarrage propre plutôt que par un serveur qui rame.
      max_memory_restart: "512M",

      // Horodate chaque ligne : sans cela, les logs pm2 sont inexploitables
      // pour reconstituer ce qui s'est passé.
      time: true,

      env: {
        NODE_ENV: "production",
      },

      // Les logs vont dans ~/.pm2/logs/rmasc-maintenance-{out,error}.log
      // (défaut pm2). Rien n'est écrit dans le dépôt.
    },
  ],
};
