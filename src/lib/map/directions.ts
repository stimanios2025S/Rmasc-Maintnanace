/**
 * Liens de navigation externe.
 *
 * Le format Google Maps Directions est écrit une seule fois : la fiche du bon,
 * le panneau de site et, demain, n'importe quel autre écran doivent ouvrir la
 * même destination. Un paramètre recopié dans trois composants finit par
 * diverger sur le nom du paramètre ou l'encodage de la virgule.
 */

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** Les coordonnées utilisables, ou `null` quand l'une des deux manque. */
export function coordinatesOf(
  latitude: number | null | undefined,
  longitude: number | null | undefined
): Coordinates | null {
  return typeof latitude === "number" && typeof longitude === "number"
    ? { latitude, longitude }
    : null;
}

/**
 * Itinéraire routier vers un point.
 *
 * `destination` accepte la paire `latitude,longitude` : Google Maps ouvre
 * directement le guidage, sans géocodage d'adresse et sans ambiguïté entre
 * deux immeubles qui portent le même nom.
 */
export function googleMapsDirectionsUrl(
  latitude: number,
  longitude: number
): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}`;
}
