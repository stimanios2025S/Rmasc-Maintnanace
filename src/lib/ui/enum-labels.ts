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

export const ENUM_LABELS: Record<string, string> = {
  // ─── Work order status ────────────────────────────────────
  OPEN: "Ouvert",
  ASSIGNED: "Assigné",
  IN_PROGRESS: "En cours",
  ON_HOLD: "En attente",
  COMPLETED: "Terminé",
  CANCELLED: "Annulé",

  // ─── Work order type ──────────────────────────────────────
  PREVENTIVE: "Préventif",
  PREDICTIVE: "Prédictif",
  CORRECTIVE: "Correctif",
  INSPECTION: "Inspection",

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
