/**
 * Le code couleur universel : vert, orange, rouge — et gris pour l'inconnu.
 *
 * POURQUOI UNE SEULE TABLE
 * Les écrans avaient chacun leur vocabulaire : un ascenseur « en service »
 * était vert ici, bleu là ; un contrat « hors contrat » était gris sur une fiche
 * et rouge ailleurs. Un utilisateur ne peut pas apprendre quatre codes. Cette
 * table est la seule définition des couleurs d'état ; `status-styles.ts`, les
 * badges de contrat et le portail client la lisent tous.
 *
 * POURQUOI UN QUATRIÈME NIVEAU
 * « Hors ligne » n'est ni une panne ni un fonctionnement normal : c'est un état
 * que l'on ne connaît pas. Le peindre en vert affirmerait que tout va bien ; le
 * peindre en rouge alarmerait pour une machine qui n'a simplement pas remonté
 * de mesure. Le gris dit exactement ce qu'on sait — rien — et il est expliqué
 * dans la légende plutôt que laissé à l'interprétation.
 *
 * Module pur : aucun import serveur.
 */

export type TrafficLevel = "ok" | "warning" | "danger" | "neutral";

export interface TrafficStyle {
  /** Pastille pleine. */
  dot: string;
  /** Fond discret et bordure, pour une pilule ou une carte. */
  bg: string;
  border: string;
  /** Couleur du texte sur le fond discret. */
  text: string;
  /** Fond plein, pour un bouton ou un indicateur massif. */
  solid: string;
  /** Texte sur le fond plein. */
  solidText: string;
  /** Libellé par défaut du niveau. */
  label: string;
  /** Ce que le niveau veut dire, en une phrase. */
  description: string;
}

export const TRAFFIC_LEVELS: Record<TrafficLevel, TrafficStyle> = {
  ok: {
    dot: "bg-green-500",
    bg: "bg-green-50 dark:bg-green-950/40",
    border: "border-green-200 dark:border-green-800",
    text: "text-green-700 dark:text-green-300",
    solid: "bg-green-600",
    solidText: "text-white",
    label: "En service",
    description: "Tout va bien : l'appareil fonctionne, le contrat est actif.",
  },
  warning: {
    dot: "bg-amber-500",
    bg: "bg-amber-50 dark:bg-amber-950/40",
    border: "border-amber-200 dark:border-amber-800",
    text: "text-amber-800 dark:text-amber-300",
    solid: "bg-amber-500",
    solidText: "text-white",
    label: "Vigilance",
    description:
      "À surveiller : entretien à prévoir, contrat à renouveler, demande en attente.",
  },
  danger: {
    dot: "bg-red-500",
    bg: "bg-red-50 dark:bg-red-950/40",
    border: "border-red-200 dark:border-red-800",
    text: "text-red-700 dark:text-red-300",
    solid: "bg-red-600",
    solidText: "text-white",
    label: "Critique",
    description:
      "Action requise : panne critique, appareil hors contrat, intervention urgente.",
  },
  neutral: {
    dot: "bg-gray-400",
    bg: "bg-gray-50 dark:bg-gray-800/60",
    border: "border-gray-200 dark:border-gray-700",
    text: "text-gray-600 dark:text-gray-300",
    solid: "bg-gray-500",
    solidText: "text-white",
    label: "État inconnu",
    description:
      "Aucune information récente : l'appareil est hors ligne ou n'a jamais remonté de mesure.",
  },
};

export function trafficStyle(level: TrafficLevel): TrafficStyle {
  return TRAFFIC_LEVELS[level];
}

/**
 * Le niveau d'un ascenseur.
 *
 * `ANOMALY_DETECTED` est orange et non rouge : une anomalie est une dérive à
 * traiter à la prochaine visite, pas un arrêt en cours. Seul
 * `CRITICAL_SHUTDOWN` est rouge, parce que seul cet état signifie que la cabine
 * ne assure plus son service.
 */
export function elevatorTrafficLevel(status: string): TrafficLevel {
  switch (status) {
    case "OPERATIONAL":
      return "ok";
    case "SERVICE_REQUIRED":
    case "ANOMALY_DETECTED":
      return "warning";
    case "CRITICAL_SHUTDOWN":
      return "danger";
    default:
      return "neutral";
  }
}

/** Le libellé lisible d'un état d'appareil, accordé au niveau. */
export function elevatorTrafficLabel(status: string): string {
  switch (status) {
    case "OPERATIONAL":
      return "En service";
    case "SERVICE_REQUIRED":
      return "Entretien à prévoir";
    case "ANOMALY_DETECTED":
      return "Anomalie détectée";
    case "CRITICAL_SHUTDOWN":
      return "Hors service";
    case "OFFLINE":
      return "Hors ligne";
    default:
      return "État inconnu";
  }
}

/**
 * Une forme minimale, pour ne pas dépendre du type de couverture complet.
 *
 * `coverage.ts` décrit ce qu'un écran de badge a besoin de savoir ; ce module
 * décrit une couleur. Prendre la structure plutôt que le type évite que le
 * registre des contrats (qui porte les montants) devienne une dépendance du
 * module de couleurs.
 */
export interface ContractTrafficInput {
  effectiveStatus: string;
  expiry?: { level: string } | null;
}

/**
 * Le niveau d'un contrat.
 *
 * L'ordre des tests porte la règle métier : un contrat résilié reste rouge même
 * si sa date n'est pas encore passée, et un contrat suspendu est orange même
 * s'il est encore « actif » administrativement. L'absence de contrat est rouge,
 * pas grise : « hors contrat » est une information actionnable, pas une donnée
 * manquante.
 */
export function contractTrafficLevel(
  contract: ContractTrafficInput | null | undefined
): TrafficLevel {
  if (!contract) return "danger";
  switch (contract.effectiveStatus) {
    case "ACTIVE":
      return contract.expiry?.level === "notice" ||
        contract.expiry?.level === "urgent"
        ? "warning"
        : "ok";
    case "SUSPENDED":
      return "warning";
    case "DRAFT":
      return "neutral";
    default:
      return "danger";
  }
}

/** Le libellé d'un contrat, accordé à son niveau. */
export function contractTrafficLabel(
  contract: ContractTrafficInput | null | undefined
): string {
  if (!contract) return "Hors contrat";
  switch (contract.effectiveStatus) {
    case "ACTIVE":
      if (contract.expiry?.level === "urgent") return "Échéance proche";
      if (contract.expiry?.level === "notice") return "À renouveler";
      return "Contrat actif";
    case "SUSPENDED":
      return "Contrat suspendu";
    case "DRAFT":
      return "Brouillon";
    case "EXPIRED":
      return "Contrat échu";
    case "TERMINATED":
      return "Contrat résilié";
    default:
      return "Hors contrat";
  }
}

/**
 * Le niveau d'un bon de travail, d'après sa priorité.
 *
 * `EMERGENCY` n'appartient pas à `WORK_ORDER_PRIORITIES` mais subsiste dans des
 * charges utiles historiques : il est rouge plutôt que sans témoin. Une
 * priorité inconnue est grise — le module dit « on ne sait pas » au lieu de
 * peindre en vert ce qu'il n'a pas reconnu.
 */
export function priorityTrafficLevel(priority: string): TrafficLevel {
  switch (priority) {
    case "CRITICAL":
    case "HIGH":
    case "EMERGENCY":
      return "danger";
    case "MEDIUM":
      return "warning";
    case "LOW":
      return "ok";
    default:
      return "neutral";
  }
}
