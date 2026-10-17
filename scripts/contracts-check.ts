/**
 * Auto-contrôle des règles de contrat.
 *
 *   npx tsx scripts/contracts-check.ts
 *
 * POURQUOI CE FICHIER EXISTE
 * Le dépôt n'a aucun harnais de tests. Tant qu'il n'en a pas, une règle pure
 * qu'on n'a pas exécutée n'est qu'une règle qu'on a relue — et plusieurs défauts
 * de ce projet ont été trouvés en exerçant le code, pas en le relisant.
 *
 * Ce script n'est pas un cadre de test : c'est une liste de cas, un compteur, et
 * un code de sortie non nul au premier écart. Il disparaîtra le jour où un vrai
 * harnais existera ; d'ici là il empêche une régression silencieuse sur les
 * transitions et les échéances.
 */

import {
  DEFAULT_NOTICE_DAYS,
  SLA_COMMITMENTS,
  addMonthsUtc,
  datesRefusal,
  daysUntil,
  effectiveEndsAt,
  effectiveSlaTier,
  effectiveStatus,
  expiryAlert,
  nextTermEnd,
  renewalRefusal,
  revisionSummary,
  termMonths,
  terminationRefusal,
  transitionRefusal,
} from "../src/lib/contracts/status";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
  } else {
    failures.push(detail ? `${name} — ${detail}` : name);
  }
}

function eq<T>(name: string, actual: T, expected: T) {
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`
  );
}

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

// ─── Transitions ───────────────────────────────────────────

eq("brouillon → en vigueur", transitionRefusal("DRAFT", "ACTIVE"), null);
eq("brouillon → résilié", transitionRefusal("DRAFT", "TERMINATED"), null);
check(
  "brouillon → suspendu refusé",
  transitionRefusal("DRAFT", "SUSPENDED") !== null
);
eq("en vigueur → suspendu", transitionRefusal("ACTIVE", "SUSPENDED"), null);
eq("en vigueur → résilié", transitionRefusal("ACTIVE", "TERMINATED"), null);
eq("en vigueur → échu", transitionRefusal("ACTIVE", "EXPIRED"), null);
eq("suspendu → en vigueur", transitionRefusal("SUSPENDED", "ACTIVE"), null);
eq("échu → en vigueur (renouvellement)", transitionRefusal("EXPIRED", "ACTIVE"), null);
check(
  "échu → résilié refusé",
  transitionRefusal("EXPIRED", "TERMINATED") !== null
);
check(
  "résilié est terminal",
  transitionRefusal("TERMINATED", "ACTIVE") !== null &&
    transitionRefusal("TERMINATED", "DRAFT") !== null
);
eq("rejouer l'état est permis", transitionRefusal("ACTIVE", "ACTIVE"), null);

// ─── Dates ─────────────────────────────────────────────────

eq("terme de 12 mois", termMonths(D("2026-01-15"), D("2027-01-15")), 12);
eq("terme de 3 mois", termMonths(D("2026-01-15"), D("2026-04-15")), 3);
eq("terme dégénéré → 12", termMonths(D("2026-01-15"), D("2026-01-20")), 12);
eq(
  "31 janvier + 1 mois = 28 février",
  addMonthsUtc(D("2026-01-31"), 1).toISOString().slice(0, 10),
  "2026-02-28"
);
eq(
  "31 janvier + 13 mois = 28 février suivant",
  addMonthsUtc(D("2026-01-31"), 13).toISOString().slice(0, 10),
  "2027-02-28"
);

// ─── Statut effectif ───────────────────────────────────────

const manualEnded = {
  status: "ACTIVE" as const,
  renewalMode: "MANUAL" as const,
  startsAt: D("2025-01-01"),
  endsAt: D("2026-01-01"),
};

eq("manuel non renouvelé → échu", effectiveStatus(manualEnded, D("2026-06-01")), "EXPIRED");
eq("manuel avant échéance → en vigueur", effectiveStatus(manualEnded, D("2025-06-01")), "ACTIVE");

const autoEnded = { ...manualEnded, renewalMode: "AUTO" as const };
eq("tacite dépassée → reste en vigueur", effectiveStatus(autoEnded, D("2026-06-01")), "ACTIVE");
eq(
  "tacite repousse la date d'un an",
  effectiveEndsAt(autoEnded, D("2026-06-01")).toISOString().slice(0, 10),
  "2027-01-01"
);
eq(
  "tacite repousse de plusieurs années",
  effectiveEndsAt(autoEnded, D("2029-06-01")).toISOString().slice(0, 10),
  "2030-01-01"
);
eq(
  "sans renouvellement ne repousse pas",
  effectiveEndsAt({ ...autoEnded, renewalMode: "NONE" }, D("2026-06-01")).toISOString().slice(0, 10),
  "2026-01-01"
);

// ─── Alertes ───────────────────────────────────────────────

const far = expiryAlert(autoEnded, D("2025-06-01"));
eq("à 214 jours : aucune alerte", far.level, "none");

const notice = expiryAlert(autoEnded, D("2025-11-15"));
eq("à 47 jours : préavis", notice.level, "notice");

const urgent = expiryAlert(autoEnded, D("2025-12-15"));
eq("à 17 jours : imminent", urgent.level, "urgent");

const overdue = expiryAlert(manualEnded, D("2026-02-01"));
eq("dépassé : échu", overdue.level, "expired");

check(
  "l'alerte de reconduction dit ce qui va se passer",
  (notice.message ?? "").includes("Reconduction tacite"),
  notice.message ?? "aucun message"
);
eq(
  "prochaine échéance d'un terme de 3 mois",
  nextTermEnd({
    status: "ACTIVE",
    renewalMode: "MANUAL",
    startsAt: D("2026-01-15"),
    endsAt: D("2026-04-15"),
  })
    .toISOString()
    .slice(0, 10),
  "2026-07-15"
);
check(
  "l'alerte manuelle dit que le contrat s'arrêtera",
  (expiryAlert({ ...manualEnded, renewalMode: "MANUAL" }, D("2025-12-15")).message ?? "").includes(
    "s'arrêtera"
  )
);
eq("jours négatifs une fois dépassé", daysUntil(D("2026-01-01"), D("2026-01-11")), -10);

// ─── Cohérence ─────────────────────────────────────────────

check(
  "fin avant début refusée",
  datesRefusal({ startsAt: D("2026-06-01"), endsAt: D("2026-01-01"), noticeDays: 60 }) !== null
);
check(
  "préavis plus long que le terme refusé",
  datesRefusal({ startsAt: D("2026-01-01"), endsAt: D("2026-03-01"), noticeDays: 60 }) !== null
);
eq(
  "dates cohérentes acceptées",
  datesRefusal({ startsAt: D("2026-01-01"), endsAt: D("2027-01-01"), noticeDays: 60 }),
  null
);
check(
  "renouvellement vers le passé refusé",
  renewalRefusal({ currentEndsAt: D("2027-01-01"), newEndsAt: D("2026-01-01") }) !== null
);
eq(
  "renouvellement vers l'avant accepté",
  renewalRefusal({ currentEndsAt: D("2027-01-01"), newEndsAt: D("2028-01-01") }),
  null
);
check(
  "résiliation sans motif refusée",
  terminationRefusal({ status: "ACTIVE", reason: "  " }) !== null
);
eq(
  "résiliation motivée acceptée",
  terminationRefusal({ status: "ACTIVE", reason: "Client parti" }),
  null
);

// ─── Palier effectif ───────────────────────────────────────

eq("contrat actif gouverne", effectiveSlaTier({ slaTier: "PREMIUM", status: "ACTIVE" }, "BASIC"), "PREMIUM");
eq("brouillon ne gouverne pas", effectiveSlaTier({ slaTier: "PREMIUM", status: "DRAFT" }, "BASIC"), "BASIC");
eq("contrat résilié ne gouverne pas", effectiveSlaTier({ slaTier: "PREMIUM", status: "TERMINATED" }, "BASIC"), "BASIC");
eq("aucun contrat → repli immeuble", effectiveSlaTier(null, "STANDARD"), "STANDARD");

// ─── Barème ────────────────────────────────────────────────

eq("BASIC prise en charge 48 h", SLA_COMMITMENTS.BASIC.responseHours, 48);
eq("BASIC dépannage 120 h", SLA_COMMITMENTS.BASIC.interventionHours, 120);
eq("ENTERPRISE dépannage 24 h", SLA_COMMITMENTS.ENTERPRISE.interventionHours, 24);
eq("préavis par défaut 60 j", DEFAULT_NOTICE_DAYS, 60);

// ─── Journal ───────────────────────────────────────────────

eq("création", revisionSummary("CREATED", {}, {}), "Contrat créé.");
eq(
  "changement de palier",
  revisionSummary("TIER_CHANGED", { slaTier: "STANDARD" }, { slaTier: "PREMIUM" }),
  "Palier : STANDARD → PREMIUM"
);
eq(
  "deux champs",
  revisionSummary("DATES_CHANGED", { endsAt: D("2027-01-01") }, { endsAt: D("2028-01-01") }),
  "Fin : 2027-01-01 → 2028-01-01"
);
eq("aucun changement", revisionSummary("STATUS_CHANGED", { a: 1 }, { a: 1 }), "Aucun champ modifié.");

// ─── Bilan ─────────────────────────────────────────────────

console.log(`\nCas exécutés : ${passed + failures.length}`);
console.log(`Réussis      : ${passed}`);
console.log(`Échecs       : ${failures.length}`);

if (failures.length > 0) {
  console.error("\nÉCHECS :");
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log("\n✓ Toutes les règles exercées passent.");
