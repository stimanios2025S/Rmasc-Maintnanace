/**
 * Le mode démonstration de la liaison au magasin central.
 *
 * POURQUOI CE FICHIER EXISTE
 * Tant que `STOCK_API_URL`, `STOCK_API_KEY` et `STOCK_API_SECRET` ne sont pas
 * posées, la liaison réelle est impossible. L'écran « Magasinier » restait
 * pourtant consultable : le bureau veut voir comment un besoin part vers le
 * magasin avant d'avoir l'instance en face. Le mode démonstration sert ce
 * besoin-là — un catalogue fictif pour remplir les sélecteurs, et des envois
 * qui répondent sans rien écrire nulle part.
 *
 * RIEN N'EST SIMULÉ EN PRODUCTION
 * Comme `lib/demo/mode.ts` pour les données de base, `NODE_ENV === "production"`
 * court-circuite la réponse avant même de lire la configuration. Un déploiement
 * sans identifiants Magasin continue donc d'afficher l'avertissement de
 * configuration : il ne doit jamais faire croire qu'une pièce a été commandée.
 * Une ligne de démonstration qui « réussit » en production ferait attendre au
 * magasinier une pièce que personne n'a commandée — c'est exactement le défaut
 * que la route de transmission refuse d'introduire.
 *
 * MODULE SERVEUR
 * `isStockConfigured` vient de `lib/stock/client.ts`, qui importe `node:crypto`.
 * Ce fichier ne doit donc être importé que par des routes ou des scripts, jamais
 * par l'écran magasinier. L'écran apprend l'état par `GET .../transmit`.
 */

import { isStockConfigured, type StockArticle } from "./client";

/**
 * Le bandeau affiché en tête de l'écran.
 *
 * Il nomme la cause : « mode démonstration » seul laisserait chercher pourquoi,
 * et la réponse — les clés API Magasin — est justement ce qu'on oublie de poser.
 */
export const STOCK_DEMO_NOTICE =
  "Mode démonstration : catalogue et transmissions simulés " +
  "(clés API Magasin non configurées)";

/**
 * L'acquittement d'un envoi simulé.
 *
 * Le mot « simulée » est indispensable : c'est la seule chose qui distingue ce
 * message d'une vraie transmission dans l'historique de l'écran.
 */
export const STOCK_DEMO_ACK =
  "Transmission simulée avec succès en mode démonstration";

/**
 * Vrai quand la liaison doit être servie en démonstration.
 *
 * Deux conditions, et aucune ne se suffit :
 *
 *  1. **Pas de configuration réelle.** Dès que les trois variables sont posées,
 *     la vraie liaison reprend la main : le mode démonstration est un
 *     remplacement, pas un interrupteur qui cohabiterait avec elle.
 *  2. **Pas en production.** Voir la note en tête de fichier.
 */
export function isStockDemoMode(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return !isStockConfigured();
}

/**
 * Le catalogue fictif.
 *
 * Trois articles, choisis pour couvrir les trois formes que le sélecteur doit
 * savoir rendre : un article en stock confortable, un article sous son seuil
 * (le libellé ajoute « · en alerte »), et un article sans emplacement. Les
 * codes imitent ceux d'un magasin d'ascenseurs — c'est ce qui donne au
 * sélecteur l'aspect de l'écran réel.
 */
export const STOCK_DEMO_ARTICLES: StockArticle[] = [
  {
    codeRef: "BR-G-SET",
    designation: "Jeu de garnitures de frein",
    unite: "KIT",
    emplacement: "A-12",
    location: "Magasin central — allée A",
    quantiteStock: 8,
    seuilAlerte: 4,
    enAlerte: false,
  },
  {
    codeRef: "R-6x19-8MM",
    designation: "Jeu de câbles de traction",
    unite: "JEU",
    emplacement: "C-04",
    location: "Magasin central — allée C",
    quantiteStock: 3,
    seuilAlerte: 5,
    enAlerte: true,
  },
  {
    codeRef: "ECU-V4",
    designation: "Carte de commande",
    unite: "U",
    emplacement: null,
    location: "Magasin central — zone électronique",
    quantiteStock: 12,
    seuilAlerte: 3,
    enAlerte: false,
  },
];
