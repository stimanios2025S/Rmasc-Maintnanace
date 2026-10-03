/**
 * Le compteur d'alertes de la coque, et comment le prévenir.
 *
 * LE PROBLÈME
 * Le badge rouge de l'en-tête est un `useState` dans `AppShell` : il se
 * remplit par son propre sondage, toutes les soixante secondes. La page des
 * alertes, elle, est un enfant de cette coque et ne peut pas atteindre cet
 * état — React fait descendre les props, pas monter les écritures.
 *
 * Sans rien, acquitter une alerte laissait le badge afficher l'ancien nombre
 * pendant une minute — c'est-à-dire exactement le temps qu'il faut à
 * l'utilisateur pour croire que le bouton n'a rien fait.
 *
 * POURQUOI UN ÉVÉNEMENT DE FENÊTRE, ET PAS UN CONTEXTE
 * Un contexte React aurait demandé de remonter l'état, de le passer par un
 * fournisseur, et de faire consommer ce fournisseur par la coque *et* par
 * chaque page — pour un seul entier. L'événement fait le même travail en six
 * lignes, ne crée aucune dépendance, et laisse le compteur là où il est déjà :
 * dans la coque, qui reste la seule à savoir le lire.
 *
 * Le sondage de soixante secondes ne disparaît pas pour autant. Il reste le
 * filet de sécurité — une alerte créée par la télémétrie pendant que personne
 * ne regarde doit finir par apparaître, et aucun événement ne l'annoncera.
 */

const ALERTS_CHANGED_EVENT = "rmasc:alerts-changed";

/**
 * Prévient la coque que le nombre d'alertes non acquittées a changé.
 *
 * À appeler après toute écriture réussie sur `/api/alerts`. Sans effet sur le
 * serveur — c'est une conversation entre deux composants du même onglet — et
 * sans effet non plus pendant un rendu serveur, où `window` n'existe pas.
 */
export function announceAlertsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(ALERTS_CHANGED_EVENT));
}

/**
 * Écoute les changements annoncés dans cet onglet.
 *
 * Rend la fonction de désabonnement, telle que `useEffect` l'attend.
 */
export function onAlertsChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(ALERTS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(ALERTS_CHANGED_EVENT, listener);
}
