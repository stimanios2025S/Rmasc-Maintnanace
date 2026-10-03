/**
 * Ce qu'un compte client a le droit d'ouvrir.
 *
 * POURQUOI CETTE RÈGLE VIT ICI ET NON DANS LE MIDDLEWARE
 * Parce qu'elle doit être exécutable. Une garde d'accès enfermée dans un
 * `middleware.ts` ne se vérifie qu'en fabriquant un jeton du bon rôle et en
 * naviguant à la main — ce qui, sur cette machine, est impossible : sans base
 * de données il n'existe aucun compte client, et le mode accès libre fait de
 * chaque requête un administrateur. La règle est donc une fonction pure, que
 * l'on peut interroger sur une liste d'adresses réelles et voir répondre.
 *
 * UNE LISTE BLANCHE, PAS UNE LISTE NOIRE
 * Le rôle client est le seul compte externe de l'application. Une liste de
 * routes interdites se trompe par omission : chaque écran ajouté plus tard
 * serait ouvert à un client tant que personne n'a pensé à l'y inscrire. Ici,
 * l'écran qu'on oublie est fermé — c'est le sens dans lequel l'erreur doit
 * aller.
 *
 * CE QUE CETTE FONCTION NE PROTÈGE PAS
 * Les données. Elle décide quelles *pages* un client peut ouvrir ; ce que ces
 * pages contiennent est décidé par chaque route API, dans
 * `src/lib/api/guard.ts` et les handlers qui l'appellent. C'est pour cette
 * raison que les routes `/api/*` sont exemptées ici : elles portent leur propre
 * cloisonnement, et rediriger un `fetch` vers une page HTML ne protégerait rien
 * — cela casserait simplement l'écran.
 */

/** Les deux écrans d'un compte client, et leur préfixe imbriqué. */
export const CLIENT_ALLOWED_PATHS = ["/tableau-de-bord", "/client"] as const;

/**
 * Vrai si un compte client peut ouvrir cette adresse.
 *
 * L'égalité exacte *et* le préfixe sont testés : `/client/fiche-technique` est
 * une page réelle du portail (le formulaire de fiche technique d'un client sans
 * contrat), et l'exigerait. Le `/` final de la comparaison de préfixe évite
 * qu'un futur `/client-archive` ne passe pour un sous-chemin de `/client`.
 */
export function isClientAllowedPath(pathname: string): boolean {
  // Les routes API sont hors sujet : voir la note en tête de fichier.
  if (pathname === "/api" || pathname.startsWith("/api/")) return true;

  return CLIENT_ALLOWED_PATHS.some(
    (base) => pathname === base || pathname.startsWith(`${base}/`)
  );
}
