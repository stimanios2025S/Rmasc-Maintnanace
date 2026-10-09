/**
 * French labels for every stored enumeration value.
 *
 * The enum *values* are the contract with PostgreSQL and with the API — they
 * are never renamed. This table is the single place that decides what a reader
 * sees for each of them, so two screens cannot render `ASSIGNED` as "Assigné"
 * on one and "Affecté" on the other.
 *
 * It lives under `lib/ui/` rather than `lib/` because it is imported by client
 * components; it must stay free of server-only imports (Prisma, NextAuth).
 * The key list mirrors `src/types/index.ts`, which remains the source of truth
 * for which values exist.
 *
 * `enumLabel()` falls back to the mechanical `SOME_VALUE` -> "Some Value"
 * transformation for anything missing, so a value added to the schema but not
 * here renders as readable English rather than as a key — visible enough to be
 * caught, harmless enough not to break a screen.
 */

import type { InvoiceStatus, PartUrgency } from "@/types";

export const ENUM_LABELS: Record<string, string> = {
  // ─── Work order status ────────────────────────────────────
  OPEN: "Ouvert",
  ASSIGNED: "Assigné",
  IN_PROGRESS: "En cours",
  PENDING_APPROVAL: "En attente de validation",
  ON_HOLD: "En attente",
  COMPLETED: "Terminé",
  CANCELLED: "Annulé",

  // ─── Work order type ──────────────────────────────────────
  PREVENTIVE: "Préventif",
  PREDICTIVE: "Prédictif",
  CORRECTIVE: "Correctif",
  INSPECTION: "Inspection",

  // ─── État d'une facture ───────────────────────────────────
  //
  // `CANCELLED` n'est PAS repris ici : la clé est déjà définie plus haut, pour
  // l'état d'un bon de travail, où elle se lit « Annulé ». Une facture est un
  // nom féminin et se lit « Annulée » ; une table indexée par la valeur stockée
  // ne peut pas porter les deux. C'est `INVOICE_STATUS_LABELS`, plus bas, qui
  // porte la forme accordée — et lui seul est importé par le registre.
  ISSUED: "Émise",
  PAID: "Réglée",

  // ─── Demande de pièce ─────────────────────────────────────
  //
  // `PREVENTIVE` n'est pas repris ici, pour la même raison que `CANCELLED`
  // ci-dessus : la clé est déjà prise par le type d'un bon de travail, où elle
  // se lit « Préventif ». Ici elle qualifie un remplacement, et le mot seul ne
  // le dit pas — voir `PART_URGENCY_LABELS`.
  IMMEDIATE: "Arrêt immédiat",
  PENDING: "En attente",
  APPROVED: "Validée",
  REJECTED: "Refusée",
  FULFILLED: "Posée",

  // ─── Priority ─────────────────────────────────────────────
  LOW: "Faible",
  MEDIUM: "Moyenne",
  HIGH: "Élevée",
  EMERGENCY: "Urgence",
  CRITICAL: "Critique",

  // ─── Incident status ──────────────────────────────────────
  ESCALATED: "Escaladé",
  TECHNICIAN_ASSIGNED: "Technicien affecté",
  CLOSED: "Clôturé",
  RESOLVED_BY_CLIENT: "Résolu par le client",

  // ─── Reported position source ─────────────────────────────
  //
  // Short enough to sit inside a sentence — the map reads them as
  // "Position : Téléphone du client". The distinction they carry is not
  // cosmetic: one is something a device measured, the other is the site's own
  // address standing in for a measurement that never arrived.
  GPS: "Téléphone du client",
  SITE: "Adresse du site",

  // ─── Elevator status ──────────────────────────────────────
  OPERATIONAL: "En service",
  SERVICE_REQUIRED: "Entretien requis",
  ANOMALY_DETECTED: "Anomalie détectée",
  CRITICAL_SHUTDOWN: "Arrêt critique",
  OFFLINE: "Hors ligne",

  // ─── Alert severity ───────────────────────────────────────
  INFO: "Information",
  WARNING: "Avertissement",
  ANOMALY: "Anomalie",

  // ─── Field technician status ──────────────────────────────
  AVAILABLE: "Disponible",
  ON_JOB: "En intervention",
  OFF_DUTY: "Hors service",
  ON_LEAVE: "En congé",

  // ─── Compétences des techniciens ──────────────────────────
  // `HYDRAULIC` n'est pas repris ici : la clé est déjà définie plus bas pour le
  // type de moteur. La redéclarer serait une erreur de compilation, et la
  // partager est correct — « hydraulique » désigne la même chose qu'on parle
  // d'un moteur ou de la compétence de quelqu'un qui le répare.
  ELECTRONICS: "Électronique",
  MECHANICS: "Mécanique",
  ROPES: "Câbles et suspension",
  DOORS: "Portes et automatismes",
  CONTROL_SYSTEMS: "Régulation et commande",

  // ─── User roles ───────────────────────────────────────────
  ADMIN: "Administrateur",
  MAINTENANCE_MANAGER: "Responsable maintenance",
  FIELD_TECHNICIAN: "Technicien de terrain",
  BUILDING_OWNER: "Propriétaire d'immeuble",

  // ─── Inspection check result ──────────────────────────────
  PASS: "Conforme",
  FAIL: "Non conforme",
  NEEDS_ATTENTION: "À surveiller",
  NOT_APPLICABLE: "Sans objet",

  // ─── Component types ──────────────────────────────────────
  TRACTION_MOTOR: "Moteur de traction",
  BRAKE_ASSEMBLY: "Ensemble de frein",
  DOOR_OPERATOR: "Opérateur de porte",
  STEEL_ROPES: "Câbles en acier",
  GUIDE_SHOES: "Patins de guidage",
  CONTROLLER_BOARD: "Carte de commande",
  COUNTERWEIGHT: "Contrepoids",
  CABIN: "Cabine",
  HYDRAULIC_UNIT: "Groupe hydraulique",
  SAFETY_GEAR: "Parachute",
  BUFFER: "Amortisseur",

  // ─── Motor types ──────────────────────────────────────────
  AC_GEARED: "Alternatif avec réducteur",
  AC_GEARDLESS: "Alternatif sans réducteur",
  DC_GEARED: "Continu avec réducteur",
  HYDRAULIC: "Hydraulique",

  // ─── Controller types ─────────────────────────────────────
  MICROPROCESSOR: "Microprocesseur",
  PLC: "Automate programmable",
  RELAY_LOGIC: "Logique à relais",
  FULLY_DIGITAL: "Entièrement numérique",

  // ─── Maintenance frequency ────────────────────────────────
  WEEKLY: "Hebdomadaire",
  BIWEEKLY: "Bimensuelle",
  MONTHLY: "Mensuelle",
  QUARTERLY: "Trimestrielle",
  SEMI_ANNUAL: "Semestrielle",
  ANNUAL: "Annuelle",
  BY_USAGE_CYCLES: "Selon les cycles d'utilisation",

  // ─── SLA tiers ────────────────────────────────────────────
  BASIC: "Basique",
  STANDARD: "Standard",
  PREMIUM: "Premium",
  ENTERPRISE: "Entreprise",

  // ─── Predictive risk level and trend ──────────────────────
  // LOW / MEDIUM / HIGH / CRITICAL are already above. `RiskTrend` is the one
  // union in `src/types/index.ts` declared in lower case; its keys follow.
  new: "Nouveau",
  improving: "En amélioration",
  stable: "Stable",
  worsening: "En dégradation",

  // ─── Elevator brands ──────────────────────────────────────
  // Proper nouns: unwritten in French any differently, so they are carried
  // here only so the fleet screens can read one table instead of keeping a
  // second copy of the list.
  OTIS: "OTIS",
  SCHINDLER: "SCHINDLER",
  THYSSENKRUPP: "THYSSENKRUPP",
  MITSUBISHI: "MITSUBISHI",
  HITACHI: "HITACHI",
  KONE: "KONE",

  // ─── Shared bucket ────────────────────────────────────────
  OTHER: "Autre",
};

/** `ASSIGNED` -> "Assigné". Unknown values fall back to "Some Value". */
export function enumLabel(value: string): string {
  const known = ENUM_LABELS[value];
  if (known) return known;

  return value
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * L'état d'une facture, tel que le registre et sa fiche le lisent.
 *
 * POURQUOI CETTE SECONDE TABLE
 * `ENUM_LABELS` est indexée par la valeur stockée, et une valeur ne peut y
 * porter qu'un libellé. Or `CANCELLED` s'accorde différemment selon ce qu'il
 * qualifie : un *bon de travail* est annulé, une *facture* est annulée, et le
 * même registre affiche les deux à quelques lignes d'écart. Écrire « Annulé »
 * sur une facture se voit immédiatement.
 *
 * Les deux valeurs qui n'ont pas ce problème sont lues depuis la table
 * commune, pour qu'il n'existe pas deux définitions de « Réglée ».
 */
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  ISSUED: ENUM_LABELS.ISSUED,
  PAID: ENUM_LABELS.PAID,
  CANCELLED: "Annulée",
};

/**
 * Le libellé d'un état de facture reçu comme une chaîne.
 *
 * Les routes et les exports manipulent le statut en `string` — il sort d'une
 * colonne, d'un paramètre d'adresse ou d'une ligne de fixture —, et un
 * `as InvoiceStatus` écrit à chaque appel site serait un endroit de plus où
 * oublier la valeur inconnue. Le repli est `enumLabel`, qui rend une forme
 * lisible plutôt qu'une clé.
 */
export function invoiceStatusLabel(status: string): string {
  return (
    INVOICE_STATUS_LABELS[status as InvoiceStatus] ?? enumLabel(status)
  );
}

/**
 * L'urgence d'une demande de pièce, telle que la fiche l'imprime.
 *
 * POURQUOI CETTE SECONDE TABLE
 * `PREVENTIVE` est déjà défini plus haut pour le *type* d'un bon de travail, où
 * il se lit « Préventif ». Appliqué à un remplacement de pièce, le mot seul est
 * ambigu — préventif par rapport à quoi ? — et la fiche doit dire ce qu'il
 * signifie : un remplacement que l'appareil ne réclame pas encore. Même
 * contrainte que `INVOICE_STATUS_LABELS`, même réponse.
 */
export const PART_URGENCY_LABELS: Record<PartUrgency, string> = {
  IMMEDIATE: ENUM_LABELS.IMMEDIATE,
  PREVENTIVE: "Remplacement préventif",
};

/** Le libellé d'une urgence reçue comme une chaîne. */
export function partUrgencyLabel(urgency: string): string {
  return PART_URGENCY_LABELS[urgency as PartUrgency] ?? enumLabel(urgency);
}
