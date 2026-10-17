/**
 * Les règles de vie d'un contrat de maintenance.
 *
 * POURQUOI CE FICHIER EST PUR
 * Il ne porte ni `node:*`, ni Prisma, ni `fetch`. Trois appelants en dépendent :
 * la route qui écrit, l'écran qui affiche, et le futur travail planifié qui
 * lira. Une règle partagée qui importerait le client Prisma ne pourrait pas
 * entrer dans un bundle navigateur — c'est la même séparation que
 * `lib/parts/status.ts` et `lib/iot/metric-catalogue.ts`.
 *
 * UNE SEULE DÉFINITION PAR RÈGLE
 * Les transitions, les échéances, les seuils d'alerte et le barème SLA sont
 * écrits ici une fois. Un écran qui offrirait une action que la route refuse est
 * le défaut que ce dépôt corrige chaque fois qu'il le rencontre ; la seule façon
 * de ne pas le réintroduire est de n'écrire la règle qu'une fois.
 *
 * LE BARÈME EST UNE VALEUR PAR DÉFAUT, PAS UNE LOI
 * `SLA_COMMITMENTS` fournit les délais à la création d'un contrat. Les délais
 * réellement promis sont **stockés sur le contrat**, parce qu'un contrat négocié
 * peut promettre mieux que son palier. Les déduire à la lecture rendrait
 * impossible cette clause — c'est-à-dire précisément ce qu'un contrat sert à
 * écrire.
 */

import type {
  ContractRenewalMode,
  ContractStatus,
  ContractRevisionKind,
  SLATier,
} from "@/types";

// ─── Le barème, validé par l'exploitant ─────────────────────

/**
 * Les délais associés à chaque palier, en heures.
 *
 * `interventionHours` pour BASIC vaut 120 — cinq jours — et non 5 : tout est en
 * heures pour que les comparaisons et les affichages n'aient pas deux unités à
 * convertir. Un contrat qui promet « 5 jours » et un autre « 120 h » sont le
 * même engagement, et le stockage doit le dire de la même façon.
 */
export const SLA_COMMITMENTS: Record<
  SLATier,
  { responseHours: number; interventionHours: number }
> = {
  BASIC: { responseHours: 48, interventionHours: 120 },
  STANDARD: { responseHours: 24, interventionHours: 72 },
  PREMIUM: { responseHours: 8, interventionHours: 48 },
  ENTERPRISE: { responseHours: 4, interventionHours: 24 },
};

/** Le préavis par défaut, en jours, avant l'échéance. */
export const DEFAULT_NOTICE_DAYS = 60;

/** Seuil de l'alerte « l'échéance approche » — le préavis. */
export const EXPIRY_NOTICE_DAYS = 60;

/** Seuil de l'alerte « l'échéance est imminente ». */
export const EXPIRY_URGENT_DAYS = 30;

// ─── Le palier effectif ─────────────────────────────────────

/**
 * Le palier qui gouverne réellement un immeuble.
 *
 * Le contrat est la source de vérité ; `Building.slaTier` n'est qu'un repli pour
 * les sites qu'aucun contrat ne couvre. Une seule fonction porte cet arbitrage,
 * parce que trois écrans le lisent et qu'un désaccord entre eux serait invisible
 * — chacun afficherait une réponse cohérente avec lui-même.
 *
 * Un contrat non `ACTIVE` ne gouverne rien : un brouillon ne promet pas de
 * service, et un contrat résilié ne devrait plus teinter la fiche d'un site.
 */
export function effectiveSlaTier(
  contract: { slaTier: SLATier; status: ContractStatus } | null | undefined,
  buildingTier: SLATier
): SLATier {
  if (!contract) return buildingTier;
  return contract.status === "ACTIVE" ? contract.slaTier : buildingTier;
}

// ─── La machine à états ─────────────────────────────────────

/**
 * Ce qui empêche une transition, ou `null` si elle est permise.
 *
 * `from === to` est permis et ne fait rien : l'écran n'a pas à distinguer « je
 * l'ai activé » de « il l'était déjà ».
 *
 * LES DEUX SEULES RÈGLES QUI COMPTENT
 *
 *  1. **Un brouillon ne se résilie pas, il s'abandonne.** `DRAFT → TERMINATED`
 *     est permis, mais l'appelant doit écrire un motif qui dit « jamais signé ».
 *     Le geste est le même, le document produit ne l'est pas.
 *  2. **`TERMINATED` est terminal.** Un contrat résilié ne se rouvre pas par un
 *     changement d'état : il se remplace par un nouveau contrat. Rouvrir
 *     effacerait la trace de la résiliation, qui est exactement ce qu'un client
 *     contestataire demandera à voir.
 *
 * `EXPIRED → ACTIVE` est permis et c'est le renouvellement tardif : l'appelant
 * **doit** fournir de nouvelles dates, ce que cette fonction ne peut pas
 * vérifier. `renewalRefusal` s'en charge.
 */
export function transitionRefusal(
  from: ContractStatus,
  to: ContractStatus
): string | null {
  if (from === to) return null;

  if (from === "TERMINATED") {
    return (
      "Un contrat résilié ne se rouvre pas. Créez un nouveau contrat : la " +
      "résiliation doit rester lisible dans l'historique."
    );
  }

  switch (from) {
    case "DRAFT":
      if (to === "ACTIVE" || to === "TERMINATED") return null;
      return "Un brouillon s'active ou s'abandonne. Il ne se suspend pas.";

    case "ACTIVE":
      if (to === "SUSPENDED" || to === "TERMINATED" || to === "EXPIRED") {
        return null;
      }
      return "Un contrat en vigueur se suspend, se résilie ou arrive à échéance.";

    case "SUSPENDED":
      if (to === "ACTIVE" || to === "TERMINATED" || to === "EXPIRED") {
        return null;
      }
      return "Un contrat suspendu reprend, se résilie ou arrive à échéance.";

    case "EXPIRED":
      if (to === "ACTIVE") return null;
      return (
        "Un contrat échu se renouvelle (nouvelle période) ou reste échu. Il ne " +
        "se résilie pas : il n'y a plus rien à résilier."
      );

    default:
      return null;
  }
}

/** Vrai quand la transition est permise. Le pendant du refus, pour l'écran. */
export function canTransition(
  from: ContractStatus,
  to: ContractStatus
): boolean {
  return transitionRefusal(from, to) === null;
}

// ─── Dates ──────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

/**
 * Ajoute des mois en UTC, en ramenant le jour dans le mois d'arrivée.
 *
 * `setUTCMonth` seul déborde : le 31 janvier plus un mois devient le 3 mars.
 * Une échéance de contrat qui glisse de deux jours chaque année finit par
 * tomber après le préavis qu'elle est censée déclencher. Le jour est donc borné
 * au dernier jour du mois visé — le 31 janvier plus un mois est le 28 février.
 */
export function addMonthsUtc(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const daysInTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
  ).getUTCDate();
  result.setUTCDate(Math.min(day, daysInTargetMonth));
  return result;
}

/**
 * La durée d'un terme, en mois.
 *
 * Douze par défaut quand les dates ne couvrent pas un mois entier : un contrat
 * annuel est la norme du métier, et une durée nulle produirait une reconduction
 * qui ne repousse rien — c'est-à-dire une boucle infinie dans `effectiveEndsAt`.
 */
export function termMonths(startsAt: Date, endsAt: Date): number {
  const months =
    (endsAt.getUTCFullYear() - startsAt.getUTCFullYear()) * 12 +
    (endsAt.getUTCMonth() - startsAt.getUTCMonth());
  return months > 0 ? months : 12;
}

/** Jours entiers entre maintenant et une date. Négatif si elle est passée. */
export function daysUntil(target: Date, now: Date): number {
  return Math.ceil((target.getTime() - now.getTime()) / MS_PER_DAY);
}

// ─── Reconduction ───────────────────────────────────────────

interface DatedContract {
  status: ContractStatus;
  renewalMode: ContractRenewalMode;
  startsAt: Date;
  endsAt: Date;
}

/**
 * La date de fin réellement en vigueur, reconductions tacites comprises.
 *
 * POURQUOI CE N'EST PAS `endsAt`
 * Une reconduction tacite n'écrit pas en base chaque année : le travail planifié
 * la matérialise, mais l'écran ne peut pas attendre qu'il passe. Un contrat
 * `AUTO` dont la date est dépassée est **toujours en vigueur** ; la seule lecture
 * honnête est de repousser la date jusqu'à ce qu'elle soit future.
 *
 * La borne de sécurité n'est pas décorative : un terme de zéro mois produirait
 * une boucle infinie. `termMonths` garantit au moins douze mois, et le garde-fou
 * couvre le cas où une donnée corrompue passerait outre.
 *
 * Un contrat résilié, échu ou suspendu n'est pas reconduit : seule une période
 * en vigueur se reconduit.
 */
export function effectiveEndsAt(contract: DatedContract, now: Date): Date {
  if (contract.renewalMode !== "AUTO") return contract.endsAt;
  if (contract.status !== "ACTIVE" && contract.status !== "SUSPENDED") {
    return contract.endsAt;
  }

  const months = termMonths(contract.startsAt, contract.endsAt);
  let end = contract.endsAt;
  let guard = 0;

  while (end.getTime() <= now.getTime() && guard < 240) {
    end = addMonthsUtc(end, months);
    guard += 1;
  }

  return end;
}

/**
 * L'état réellement en vigueur à une date.
 *
 * `ACTIVE` et `SUSPENDED` sont les seuls états qui dépendent du temps : un
 * contrat non renouvelé devient `EXPIRED` à son échéance sans qu'aucune ligne
 * n'ait été écrite. Le calculer à la lecture plutôt que de compter sur une tâche
 * nocturne est ce qui empêche un écran d'afficher « en vigueur » sur un contrat
 * mort depuis trois semaines si le planificateur est en panne.
 */
export function effectiveStatus(
  contract: DatedContract,
  now: Date
): ContractStatus {
  if (contract.status !== "ACTIVE" && contract.status !== "SUSPENDED") {
    return contract.status;
  }
  if (contract.renewalMode === "AUTO") return contract.status;
  return now.getTime() > contract.endsAt.getTime() ? "EXPIRED" : contract.status;
}

/** La date de fin de la prochaine période, sans rien écrire. */
export function nextTermEnd(contract: DatedContract): Date {
  return addMonthsUtc(
    contract.endsAt,
    termMonths(contract.startsAt, contract.endsAt)
  );
}

// ─── Alertes d'échéance ─────────────────────────────────────

export type ExpiryLevel = "none" | "notice" | "urgent" | "expired";

export interface ExpiryAlert {
  level: ExpiryLevel;
  /** Jours restants ; négatif si l'échéance est passée. */
  days: number;
  /** La phrase à afficher, ou `null` quand il n'y a rien à signaler. */
  message: string | null;
}

/**
 * L'alerte d'échéance d'un contrat.
 *
 * DEUX SEUILS, ET PAS UN
 * Le préavis (60 jours) est le moment où il faut *décider* : renouveler,
 * renégocier, ou envoyer le congé. Trente jours est le moment où il faut
 * *agir* : la décision est prise ou elle ne le sera pas. Un seul seuil
 * mélangerait les deux et produirait une alerte qu'on apprend à ignorer.
 *
 * L'ALERTE EXISTE AUSSI EN RECONDUCTION TACITE
 * Un contrat `AUTO` n'expire pas — mais il se reconduit, et une reconduction
 * qu'on n'a pas vue passer est une année de plus au même prix. L'alerte dit
 * alors ce qui va se passer plutôt que ce qui va s'arrêter.
 */
export function expiryAlert(contract: DatedContract, now: Date): ExpiryAlert {
  const status = effectiveStatus(contract, now);

  if (status === "TERMINATED") {
    return { level: "none", days: 0, message: null };
  }

  if (status === "EXPIRED") {
    const days = daysUntil(contract.endsAt, now);
    return {
      level: "expired",
      days,
      message:
        contract.renewalMode === "NONE"
          ? "Contrat échu — aucun renouvellement n'était prévu."
          : "Contrat échu — le renouvellement n'a pas été décidé à temps.",
    };
  }

  const end = effectiveEndsAt(contract, now);
  const days = daysUntil(end, now);

  if (days > EXPIRY_NOTICE_DAYS) {
    return { level: "none", days, message: null };
  }

  const when = `dans ${days} jour${days > 1 ? "s" : ""}`;
  const tacit = contract.renewalMode === "AUTO";

  if (days <= 0) {
    return {
      level: "expired",
      days,
      message: "Contrat échu — la date de fin est atteinte.",
    };
  }

  if (days <= EXPIRY_URGENT_DAYS) {
    return {
      level: "urgent",
      days,
      message: tacit
        ? `Reconduction tacite ${when} — renégociez maintenant ou envoyez le congé.`
        : `Échéance ${when} — le contrat s'arrêtera sans renouvellement.`,
    };
  }

  return {
    level: "notice",
    days,
    message: tacit
      ? `Reconduction tacite ${when} — c'est le moment de décider.`
      : `Échéance ${when} — prévenez le client ou préparez le renouvellement.`,
  };
}

// ─── Contrôles de cohérence ─────────────────────────────────

interface ContractDates {
  startsAt: Date;
  endsAt: Date;
  noticeDays: number;
}

/**
 * Ce qui empêche un contrat d'avoir des dates cohérentes, ou `null`.
 *
 * Le préavis plus long que le terme est refusé : un contrat de trois mois avec
 * un préavis de soixante jours ne laisse jamais le temps de décider, et l'alerte
 * se déclencherait le jour de la signature.
 */
export function datesRefusal(contract: ContractDates): string | null {
  if (contract.endsAt.getTime() <= contract.startsAt.getTime()) {
    return "La date de fin doit être postérieure à la date de début.";
  }

  if (contract.noticeDays < 0) {
    return "Le préavis ne peut pas être négatif.";
  }

  const termDays = Math.floor(
    (contract.endsAt.getTime() - contract.startsAt.getTime()) / MS_PER_DAY
  );

  if (contract.noticeDays >= termDays) {
    return (
      `Le préavis (${contract.noticeDays} jours) doit être plus court que la ` +
      `durée du contrat (${termDays} jours), sinon l'alerte se déclenche le ` +
      "jour de la signature."
    );
  }

  return null;
}

/**
 * Ce qui empêche une reconduction, ou `null`.
 *
 * La nouvelle fin doit être postérieure à l'ancienne : renouveler vers le passé
 * créerait une période déjà échue, et la reconduction tacite la repousserait
 * indéfiniment sans qu'aucune date ne progresse.
 */
export function renewalRefusal(params: {
  currentEndsAt: Date;
  newEndsAt: Date;
}): string | null {
  if (params.newEndsAt.getTime() <= params.currentEndsAt.getTime()) {
    return "La nouvelle date de fin doit être postérieure à la précédente.";
  }
  return null;
}

/**
 * Ce qui empêche une résiliation, ou `null`.
 *
 * Un motif est exigé : « résilié sans motif » est une ligne qui ne répond à
 * aucune des questions qu'on posera six mois plus tard. La date et le motif sont
 * obligatoires ensemble — l'un sans l'autre produit un historique inutilisable.
 */
export function terminationRefusal(params: {
  status: ContractStatus;
  reason: string | null | undefined;
}): string | null {
  if (params.status === "TERMINATED") {
    return "Ce contrat est déjà résilié.";
  }
  if (!params.reason?.trim()) {
    return "Un motif de résiliation est obligatoire.";
  }
  return null;
}

// ─── Journal des révisions ──────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
  slaTier: "Palier",
  startsAt: "Début",
  endsAt: "Fin",
  renewalMode: "Renouvellement",
  noticeDays: "Préavis",
  status: "État",
  responseHours: "Prise en charge",
  interventionHours: "Intervention",
  amount: "Montant",
  currency: "Devise",
  buildings: "Immeubles",
  terminationReason: "Motif de résiliation",
};

/** Une valeur de champ, telle qu'elle apparaît dans le journal. */
export type RevisionValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined;

/**
 * La phrase du journal des révisions.
 *
 * Écrite ici plutôt qu'à chaque site d'appel : le journal est lu par un humain
 * qui cherche « qu'est-ce qui a changé ? », et deux formulations pour le même
 * changement rendraient l'historique illisible. La forme est
 * « Palier : STANDARD → PREMIUM · Fin : 2027-03-01 → 2028-03-01 ».
 *
 * Une clé inconnue n'est pas masquée : elle s'affiche sous son nom technique,
 * ce qui est laid mais honnête — un journal qui cache un champ modifié est pire
 * qu'un journal qui l'écrit mal.
 */
export function revisionSummary(
  kind: ContractRevisionKind,
  before: Record<string, RevisionValue>,
  after: Record<string, RevisionValue>
): string {
  if (kind === "CREATED") return "Contrat créé.";

  const parts: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of keys) {
    const from = before[key];
    const to = after[key];
    if (sameValue(from, to)) continue;

    const label = FIELD_LABELS[key] ?? key;
    parts.push(`${label} : ${render(from)} → ${render(to)}`);
  }

  if (parts.length === 0) {
    return "Aucun champ modifié.";
  }

  return parts.join(" · ");
}

function sameValue(a: RevisionValue, b: RevisionValue): boolean {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return a === b;
}

function render(value: RevisionValue): string {
  if (value === null || value === undefined) return "—";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "boolean") return value ? "oui" : "non";
  return String(value);
}
