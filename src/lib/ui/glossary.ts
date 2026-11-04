/**
 * Le lexique métier, en clair.
 *
 * POURQUOI UN FICHIER, ET PAS DES BULLES ÉCRITES DANS CHAQUE ÉCRAN
 * Une infobulle recopiée sur trois écrans finit par dire trois choses
 * différentes — c'est arrivé aux libellés de statut avant qu'ils soient
 * centralisés. Ce module est la seule définition de « ce que ce mot veut dire
 * pour quelqu'un qui n'est pas du métier ».
 *
 * Les termes restent affichés : un technicien et un gestionnaire les cherchent
 * par leur nom. Ce qui change, c'est qu'ils sont désormais expliqués à côté,
 * au lieu d'être supposés connus. `InfoHint` lit ce fichier.
 *
 * Module pur : aucun import serveur, il est lu par des composants client.
 */

export type GlossaryKey =
  | "sla"
  | "tier"
  | "tacitRenewal"
  | "noticeDays"
  | "threshold"
  | "rul"
  | "health"
  | "workOrder"
  | "escalation"
  | "coverage"
  | "preventive"
  | "palier";

export interface GlossaryEntry {
  /** Le mot tel qu'il s'affiche à côté de l'infobulle. */
  term: string;
  /** Une phrase, pour la bulle. */
  short: string;
  /** Une explication plus longue, quand le survol ne suffit pas. */
  long?: string;
}

export const GLOSSARY: Record<GlossaryKey, GlossaryEntry> = {
  sla: {
    term: "Engagement de service (SLA)",
    short:
      "Délai promis au client pour prendre en charge une panne puis intervenir sur place.",
    long:
      "Le SLA (« service level agreement ») est la promesse de délai du contrat : nombre d'heures avant la prise en charge, puis avant l'arrivée du technicien. Il s'affiche sur les fiches d'appareil et dans l'espace client.",
  },
  tier: {
    term: "Palier de service",
    short:
      "Niveau d'engagement du contrat : Basic, Standard, Premium ou Entreprise.",
    long:
      "Le palier fixe les deux délais promis (prise en charge et intervention). Un palier plus élevé engage l'entreprise plus vite, il ne change pas la nature des travaux.",
  },
  palier: {
    term: "Palier",
    short: "Niveau d'engagement du contrat, qui fixe les délais promis.",
  },
  tacitRenewal: {
    term: "Reconduction tacite",
    short:
      "Le contrat se renouvelle automatiquement à son échéance, sauf si le client ou le bureau donne son préavis.",
    long:
      "Sans préavis dans le délai prévu, le contrat repart pour une période identique. C'est une sécurité pour le client comme pour l'entreprise, mais elle doit se voir : le registre signale les contrats qui arrivent dans la fenêtre de préavis.",
  },
  noticeDays: {
    term: "Préavis",
    short:
      "Nombre de jours avant l'échéance pour dénoncer ou renouveler le contrat.",
    long:
      "Le préavis est exprimé en jours et propre à chaque contrat. Passé ce délai, la reconduction tacite s'applique, si le contrat en prévoit une.",
  },
  threshold: {
    term: "Seuil d'alerte",
    short:
      "Valeur mesurée à partir de laquelle une alerte est créée automatiquement.",
    long:
      "Un seuil porte sur une mesure de l'appareil (température moteur, vibration, charge…). Il produit une alerte à chaque dépassement ; les plus graves ouvrent une intervention d'urgence.",
  },
  rul: {
    term: "Durée de vie restante (RUL)",
    short:
      "Estimation du temps qui reste à un composant avant qu'il ne tombe en panne.",
    long:
      "La RUL (« remaining useful life ») est calculée à partir de l'usure observée — heures de fonctionnement, cycles de porte, vibrations. C'est une estimation, pas une certitude : elle sert à planifier, pas à garantir.",
  },
  health: {
    term: "Santé de l'appareil",
    short:
      "Note de 0 à 100 calculée à partir des mesures, des pannes et de l'usure.",
    long:
      "100 signifie « aucune anomalie connue ». La note se dégrade avec les alertes et l'usure des composants ; elle ne remplace pas une visite de contrôle.",
  },
  workOrder: {
    term: "Intervention",
    short:
      "Travail planifié sur un appareil : dépannage, entretien ou inspection.",
    long:
      "Une intervention porte un numéro, une priorité et un technicien affecté. C'est ce que l'on appelait un « bon de travail » ; les deux termes désignent la même chose.",
  },
  escalation: {
    term: "Escalade",
    short:
      "Transmission d'une panne au bureau pour qu'un technicien soit affecté.",
    long:
      "Le client signale une panne, tente les gestes simples, puis escalade si le problème persiste. L'escalade crée une intervention et prévient les gestionnaires.",
  },
  coverage: {
    term: "Couverture contractuelle",
    short:
      "Le contrat réellement en vigueur qui couvre un immeuble à la date du jour.",
    long:
      "Un immeuble peut porter un palier dans sa fiche sans être couvert : le contrat peut avoir été suspendu ou résilié. La couverture est calculée à la lecture, jamais recopiée.",
  },
  preventive: {
    term: "Entretien préventif",
    short:
      "Visite planifiée pour éviter la panne, par opposition au dépannage.",
    long:
      "Les visites préventives suivent le programme d'entretien du contrat. Elles se planifient à l'avance et produisent un rapport d'inspection.",
  },
};

/** Le libellé court d'un terme, pour une bulle. */
export function glossaryText(key: GlossaryKey): string {
  return GLOSSARY[key].short;
}

/** Le libellé d'un terme, pour un titre accessible. */
export function glossaryTerm(key: GlossaryKey): string {
  return GLOSSARY[key].term;
}
