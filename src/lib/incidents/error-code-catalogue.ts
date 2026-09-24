/**
 * The standard elevator error-code catalogue.
 *
 * ONE SOURCE OF TRUTH
 * This copy is read by three consumers that must not disagree: the client
 * portal's troubleshooting wizard (through `GET /api/error-codes`), the demo
 * fixtures (`src/lib/demo/dataset.ts`) and `prisma/seed.ts`. A building
 * occupant following the steps for E-201 has to read the same instructions
 * whichever of those served them — divergence would mean the guidance shown
 * in a demo is not the guidance in production.
 *
 * WHY FRENCH
 * The audience is a building occupant standing in a lobby, not a technician.
 * The codes themselves are the manufacturer's and stay exactly as printed on
 * the controller; only the explanation is translated.
 *
 * NO IMPORTS ON PURPOSE
 * `prisma/seed.ts` runs under `tsx`, outside the Next.js build, where the `@/`
 * path alias is not guaranteed to resolve. A module with no imports of its own
 * can be reached from the seed by plain relative path.
 *
 * SAFETY LANGUAGE MATTERS HERE
 * Several of these steps tell someone to stop trying and wait. That is the
 * correct instruction — a passenger who forces a door or leaves a stalled
 * cabin between floors is in far more danger than one who waits for a
 * technician — so the wording is deliberately direct rather than reassuring.
 */

export interface CatalogueErrorCode {
  code: string;
  title: string;
  description: string;
  /**
   * Newline-separated. `splitSolution` in `src/lib/incidents/error-codes.ts`
   * turns it into the numbered list the wizard renders.
   */
  solution: string;
}

export const ELEVATOR_ERROR_CODES: readonly CatalogueErrorCode[] = [
  {
    code: "E-101",
    title: "La porte ne se ferme pas",
    description:
      "La cabine reste immobile portes ouvertes. Un obstacle ou un capteur sale en est le plus souvent la cause.",
    solution:
      "Écartez tout objet ou toute personne de l'ouverture des portes.\nVérifiez qu'aucun carton, colis ou meuble ne bloque le seuil.\nNettoyez délicatement la cellule photoélectrique située de chaque côté de la porte.\nAppuyez sur le bouton de fermeture pendant 5 secondes.\nSi les portes restent ouvertes, appuyez sur le bouton d'appel.",
  },
  {
    code: "E-102",
    title: "La porte ne s'ouvre pas",
    description:
      "La cabine est à l'étage mais les portes restent verrouillées. N'essayez jamais de les forcer.",
    solution:
      "N'essayez pas d'ouvrir les portes manuellement.\nAppuyez sur le bouton d'ouverture pendant 5 secondes.\nAppuyez sur le bouton de l'étage où vous vous trouvez.\nSi les portes restent fermées, utilisez le téléphone de cabine ou le bouton d'appel.",
  },
  {
    code: "E-201",
    title: "Cabine bloquée entre deux étages",
    description:
      "L'ascenseur s'est arrêté entre deux niveaux. La cabine est immobilisée en sécurité et ne présente pas de danger immédiat.",
    solution:
      "Restez calme : la cabine est freinée et ne peut pas chuter.\nN'essayez jamais de sortir par une trappe ou d'ouvrir les portes.\nAppuyez sur le bouton d'alarme pour prévenir la réception.\nUtilisez le téléphone de cabine pour signaler votre position.\nAttendez l'arrivée du technicien sans forcer les portes.",
  },
  {
    code: "E-202",
    title: "Arrêt d'urgence déclenché",
    description:
      "Le bouton d'arrêt d'urgence a été actionné. L'ascenseur ne redémarrera pas tant qu'il n'est pas réarmé.",
    solution:
      "Localisez le bouton rouge d'arrêt d'urgence dans la cabine.\nTournez-le dans le sens des flèches pour le réarmer.\nAppuyez ensuite sur le bouton de l'étage souhaité.\nSi l'ascenseur ne redémarre pas, appuyez sur le bouton d'appel.",
  },
  {
    code: "E-301",
    title: "Surcharge de la cabine",
    description:
      "Le poids embarqué dépasse la charge nominale autorisée. L'ascenseur refuse de démarrer par sécurité.",
    solution:
      "Faites sortir une ou plusieurs personnes jusqu'à l'extinction du signal sonore.\nNe laissez pas de chariot ou de matériel encombrant bloquer l'accès.\nAttendez que l'alarme sonore s'arrête avant de sélectionner un étage.\nSi l'alarme persiste cabine vide, appuyez sur le bouton d'appel.",
  },
  {
    code: "E-302",
    title: "Défaut moteur ou variateur",
    description:
      "Le système de traction a signalé une anomalie. L'ascenseur a interrompu son service pour se protéger.",
    solution:
      "N'essayez pas de redémarrer l'ascenseur de manière répétée.\nNotez l'heure à laquelle le défaut est apparu si vous la connaissez.\nVérifiez qu'aucune odeur de brûlé ni aucun bruit anormal ne provient de la machinerie.\nAppuyez sur le bouton d'appel pour signaler le défaut.",
  },
  {
    code: "E-401",
    title: "Coupure d'alimentation",
    description:
      "L'ascenseur ne reçoit plus de courant. Il s'agit le plus souvent d'une coupure générale de l'immeuble.",
    solution:
      "Vérifiez si l'éclairage de l'immeuble est également coupé.\nSi la coupure est générale, attendez le rétablissement du courant.\nSi seul l'ascenseur est concerné, vérifiez le disjoncteur dédié au tableau électrique.\nAppuyez sur le bouton d'appel si l'ascenseur ne redémarre pas après le retour du courant.",
  },
  {
    code: "E-402",
    title: "Alarme incendie — retour au niveau de dégagement",
    description:
      "Le signal incendie a été reçu : l'ascenseur rejoint automatiquement le rez-de-chaussée et ouvre ses portes.",
    solution:
      "N'utilisez pas l'ascenseur tant que l'alarme incendie est active.\nÉvacuez par les escaliers.\nN'appelez le service de maintenance qu'après la levée de l'alarme par les pompiers.\nAppuyez sur le bouton d'appel si l'ascenseur reste immobilisé après la levée de l'alarme.",
  },
  {
    code: "E-501",
    title: "Arrêt imprécis à l'étage",
    description:
      "La cabine s'arrête à quelques centimètres du niveau du palier, créant un risque de trébuchement.",
    solution:
      "Signalez l'écart au gestionnaire de l'immeuble.\nÉvitez d'utiliser l'ascenseur si l'écart est important.\nNe tentez pas de franchir le seuil si l'écart dépasse la hauteur d'une marche.\nAppuyez sur le bouton d'appel pour signaler l'arrêt imprécis.",
  },
  {
    code: "E-502",
    title: "Éclairage de cabine hors service",
    description:
      "L'éclairage intérieur ne fonctionne plus. L'ascenseur reste utilisable mais l'accès n'est pas sûr.",
    solution:
      "Si possible, utilisez un autre ascenseur de l'immeuble.\nNe montez pas dans une cabine totalement obscure.\nSignalez le défaut au gestionnaire de l'immeuble.\nAppuyez sur le bouton d'appel si aucun autre ascenseur n'est disponible.",
  },
];
