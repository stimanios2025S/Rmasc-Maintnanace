/**
 * La grille de la fiche d'entretien mensuel — For: APP/DA/04/13.
 *
 * POURQUOI CE FICHIER EST SÉPARÉ
 * Comme le catalogue des seuils : les libellés sont lus par le portail
 * technicien (composant client) et par la feuille imprimée (autre composant
 * client). Les laisser dans un module qui importe la base de données tirerait
 * le moteur dans le bundle du navigateur.
 *
 * TRANSCRITE TELLE QUELLE
 * Les intitulés sont ceux du formulaire de l'entreprise, recopiés sans être
 * réécrits. Une feuille réglementaire se reconnaît à ses mots : « coulisseaux »,
 * « sabot », « cuvette » ne sont pas des synonymes interchangeables, et reformuler
 * pour faire plus clair ferait diverger le papier de l'écran — puis l'écran du
 * papier, à la première correction faite d'un seul côté.
 *
 * LA NUMÉROTATION EST CELLE DU PAPIER
 * `1.1`, `2.3`, `3.6` : le technicien qui relève un défaut le note par son
 * numéro, et le bureau qui lit « 2.3 » doit trouver la même ligne. Renuméroter
 * par position dans un tableau casserait ce lien dès qu'une ligne est ajoutée.
 *
 * UN ÉCART RELEVÉ DANS LE DOCUMENT SOURCE
 * Le formulaire annonce « 13 points de contrôle » et en liste **14** :
 * 4 au local technique, 4 en gaine, 6 en cabine. La liste est ce que le
 * technicien coche, et c'est donc elle qui fait foi ici ; l'intitulé « 13 » est
 * repris à part, dans `ENTRETIEN_FORM_TITLE`, pour qu'il ne soit pas propagé
 * silencieusement dans quatorze lignes numérotées.
 */

/** Le code du formulaire, tel qu'il s'imprime en pied de feuille. */
export const ENTRETIEN_FORM_CODE = "For: APP/DA/04/13";

/** Le titre porté par le formulaire. Voir la note sur l'écart 13/14. */
export const ENTRETIEN_FORM_TITLE = "Fiche d'entretien mensuel";

export interface ChecklistItem {
  /** Le numéro du papier : « 2.3 ». */
  code: string;
  label: string;
}

export interface ChecklistGroup {
  /** Le titre du groupe tel qu'il s'imprime, en capitales sur le formulaire. */
  title: string;
  items: readonly ChecklistItem[];
}

/** Les trois groupes de la grille, dans l'ordre du formulaire. */
export const ENTRETIEN_CHECKLIST: readonly ChecklistGroup[] = [
  {
    title: "LOCAL TECHNIQUE & MACHINERIE",
    items: [
      { code: "1.1", label: "Nettoyage local, état du treuil / moteur / frein" },
      { code: "1.2", label: "Vérification du niveau d'huile et réducteur" },
      { code: "1.3", label: "Armoire de commande, contacteurs, fusibles" },
      { code: "1.4", label: "Poulie de traction et limiteur de vitesse" },
    ],
  },
  {
    title: "GAINE & GAINE D'ASCENSEUR",
    items: [
      { code: "2.1", label: "État des câbles de traction et fixations" },
      { code: "2.2", label: "Guidage, coulisseaux et graissage des guides" },
      { code: "2.3", label: "Contacts de fin de course et sécurité gaine" },
      { code: "2.4", label: "Éclairage de gaine et nettoyage cuvette" },
    ],
  },
  {
    title: "CABINE & PORTES",
    items: [
      { code: "3.1", label: "Opérateur de porte, galets, courroies et sabots" },
      { code: "3.2", label: "Cellule photoélectrique / Barrière infrarouge" },
      { code: "3.3", label: "Serrures de portes palières et contacts électriques" },
      { code: "3.4", label: "Boutons poussoirs, voyants, afficheurs et alarme" },
      { code: "3.5", label: "Éclairage cabine et secours / Interphone" },
      { code: "3.6", label: "Précision d'arrêt aux étages / Nivelage" },
    ],
  },
];

/**
 * Les intitulés à plat, dans l'ordre du formulaire.
 *
 * C'est ce que le portail technicien envoie comme `checkName`, et c'est donc ce
 * qui est stocké puis relu. La feuille imprimée retrouve le numéro en
 * recherchant l'intitulé ici — une ligne dont l'intitulé ne serait plus dans le
 * catalogue (un rapport ancien, ou un point ajouté à la main) s'imprime avec sa
 * position plutôt qu'avec un numéro faux.
 */
export const ENTRETIEN_CHECK_NAMES: readonly string[] = ENTRETIEN_CHECKLIST.flatMap(
  (group) => group.items.map((item) => item.label)
);

/** Le numéro d'un intitulé, ou `null` s'il n'est pas au catalogue. */
export function entretienCodeFor(label: string): string | null {
  for (const group of ENTRETIEN_CHECKLIST) {
    const found = group.items.find((item) => item.label === label);
    if (found) return found.code;
  }
  return null;
}

/**
 * Les deux cases du formulaire, et ce que l'application en fait.
 *
 * LE POINT DÉLICAT, ET IL EST VISIBLE SUR LE PAPIER
 * La grille officielle n'offre que « Conforme » et « Non Conf. ». L'application
 * en enregistre quatre, parce qu'un technicien a souvent besoin de dire « ce
 * n'est pas encore une non-conformité, mais il faut surveiller ».
 *
 * Imprimer « Non conforme » sur un point qui n'est qu'à surveiller serait une
 * déclaration fausse sur un document réglementaire — la seule chose qu'une
 * feuille de contrôle ne peut pas se permettre. La correspondance est donc :
 *
 *   PASS             → case « Conforme »
 *   FAIL             → case « Non Conf. »
 *   NEEDS_ATTENTION  → case « Non Conf. », et les observations commencent par
 *                      « À surveiller : » — le papier dit ainsi ce que
 *                      l'application distingue, sans le taire
 *   NOT_APPLICABLE   → aucune case cochée, « Sans objet » en observations
 *
 * Aucune de ces correspondances n'invente une case cochée qui n'a pas été
 * constatée, et la feuille porte la légende qui l'explique.
 */
export const ENTRETIEN_LEGEND =
  "« À surveiller » est porté sur la ligne « Non Conf. » et détaillé en " +
  "observations ; « Sans objet » ne coche aucune case.";
