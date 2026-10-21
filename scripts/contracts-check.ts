/**
 * Harnais de contrôle des règles pures des contrats.
 *
 *   npm run contracts:check
 *   npx tsx scripts/contracts-check.ts
 *
 * POURQUOI CE FICHIER EXISTE
 * Le dépôt n'a aucun runner de tests. Une règle pure qu'on n'a pas exécutée
 * n'est qu'une règle qu'on a relue — et les défauts les plus coûteux de ce
 * projet ont été trouvés en exerçant le code, pas en le relisant. Ce script est
 * le harnais minimal : des cas, un compteur, un code de sortie non nul au
 * premier écart. Il couvre l'intégralité de `lib/contracts/status.ts`, la
 * matrice complète des transitions, et la règle de couverture ajoutée pour les
 * badges.
 *
 * CE QU'IL N'EXERCE PAS
 * Le batch (`lib/contracts/rollover.ts`) parle à PostgreSQL et à WhatsApp : il
 * demande une base et une instance, et se vérifie par un passage `--dry-run`
 * sur un déploiement, pas ici. Les routes API de même : elles ajoutent
 * l'autorisation et la sérialisation, pas la règle.
 *
 * S'il échoue, le premier écart est nommé et le script sort en erreur — c'est ce
 * qui le rend utilisable avant un commit, et un jour dans une CI.
 */

import {
  DEFAULT_NOTICE_DAYS,
  EXPIRY_NOTICE_DAYS,
  EXPIRY_URGENT_DAYS,
  SLA_COMMITMENTS,
  addMonthsUtc,
  canTransition,
  datesRefusal,
  daysUntil,
  decisionLevel,
  effectiveEndsAt,
  effectiveSlaTier,
  effectiveStatus,
  expiryAlert,
  nextTermEnd,
  renewalRefusal,
  requiresDecision,
  revisionSummary,
  termMonths,
  terminationRefusal,
  transitionRefusal,
} from "../src/lib/contracts/status";
import { contractForBuilding } from "../src/lib/contracts/coverage";
import type { CoverageContract } from "../src/lib/contracts/coverage";

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

/** `2026-01-31` — la forme sous laquelle une date se lit dans un échec. */
function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

// ─── 1. Matrice complète des transitions ────────────────────

const STATUSES = ["DRAFT", "ACTIVE", "SUSPENDED", "TERMINATED", "EXPIRED"] as const;
type Status = (typeof STATUSES)[number];

/**
 * Les seules transitions autorisées.
 *
 * `from === to` est toujours permis et ne fait rien : l'écran n'a pas à
 * distinguer « je l'ai activé » de « il l'était déjà ». `TERMINATED` ne figure
 * donc que vers lui-même — un contrat résilié se remplace, il ne se rouvre pas.
 */
const ALLOWED: Record<Status, readonly Status[]> = {
  DRAFT: ["DRAFT", "ACTIVE", "TERMINATED"],
  ACTIVE: ["ACTIVE", "SUSPENDED", "TERMINATED", "EXPIRED"],
  SUSPENDED: ["SUSPENDED", "ACTIVE", "TERMINATED", "EXPIRED"],
  EXPIRED: ["EXPIRED", "ACTIVE"],
  TERMINATED: ["TERMINATED"],
};

for (const from of STATUSES) {
  for (const to of STATUSES) {
    const expected = ALLOWED[from].includes(to);
    const refusal = transitionRefusal(from, to);

    check(
      `transition ${from} → ${to} : ${expected ? "permise" : "refusée"}`,
      expected ? refusal === null : typeof refusal === "string" && refusal.length > 0,
      expected ? `refus inattendu : ${refusal}` : "aurait dû être refusée"
    );
    eq(`canTransition ${from} → ${to}`, canTransition(from, to), expected);
  }
}

check(
  "un contrat résilié ne se rouvre pas",
  (transitionRefusal("TERMINATED", "ACTIVE") ?? "").includes("ne se rouvre pas")
);
check(
  "un brouillon ne se suspend pas",
  (transitionRefusal("DRAFT", "SUSPENDED") ?? "").includes("ne se suspend pas")
);
check(
  "un échu ne se résilie pas",
  (transitionRefusal("EXPIRED", "TERMINATED") ?? "").includes("plus rien à résilier")
);

// ─── 2. Dates et durées ─────────────────────────────────────

eq("terme de 12 mois", termMonths(D("2026-01-15"), D("2027-01-15")), 12);
eq("terme de 3 mois", termMonths(D("2026-01-15"), D("2026-04-15")), 3);
eq("terme de 24 mois", termMonths(D("2024-01-01"), D("2026-01-01")), 24);
eq("terme dégénéré → 12", termMonths(D("2026-01-15"), D("2026-01-20")), 12);
eq("terme nul → 12", termMonths(D("2026-01-01"), D("2026-01-01")), 12);
eq("terme inversé → 12", termMonths(D("2026-06-01"), D("2026-01-01")), 12);

eq(
  "31 janvier + 1 mois = 28 février",
  day(addMonthsUtc(D("2026-01-31"), 1)),
  "2026-02-28"
);
eq(
  "31 janvier 2024 + 1 mois = 29 février",
  day(addMonthsUtc(D("2024-01-31"), 1)),
  "2024-02-29"
);
eq(
  "31 mars + 1 mois = 30 avril",
  day(addMonthsUtc(D("2026-03-31"), 1)),
  "2026-04-30"
);
eq(
  "31 janvier + 13 mois = 28 février suivant",
  day(addMonthsUtc(D("2026-01-31"), 13)),
  "2027-02-28"
);
eq(
  "décembre + 1 mois = janvier suivant",
  day(addMonthsUtc(D("2026-12-15"), 1)),
  "2027-01-15"
);
eq(
  "janvier - 1 mois = décembre précédent",
  day(addMonthsUtc(D("2026-01-15"), -1)),
  "2025-12-15"
);

eq("jours entiers positifs", daysUntil(D("2026-01-11"), D("2026-01-01")), 10);
eq("jours entiers nuls", daysUntil(D("2026-01-01"), D("2026-01-01")), 0);
eq("jours négatifs", daysUntil(D("2026-01-01"), D("2026-01-11")), -10);
eq(
  "arrondi supérieur d'une demi-journée",
  daysUntil(new Date("2026-01-02T12:00:00Z"), D("2026-01-01")),
  2
);

// ─── 3. État effectif ───────────────────────────────────────

const beforeEnd = D("2025-06-01");
const afterEnd = D("2026-06-01");
const endsAt = D("2026-01-01");
const startsAt = D("2025-01-01");

for (const status of ["ACTIVE", "SUSPENDED"] as const) {
  for (const renewalMode of ["AUTO", "MANUAL", "NONE"] as const) {
    const contract = { status, renewalMode, startsAt, endsAt };

    eq(
      `${status}/${renewalMode} avant échéance`,
      effectiveStatus(contract, beforeEnd),
      status
    );
    eq(
      `${status}/${renewalMode} après échéance`,
      effectiveStatus(contract, afterEnd),
      renewalMode === "AUTO" ? status : "EXPIRED"
    );
  }
}

for (const status of ["DRAFT", "EXPIRED", "TERMINATED"] as const) {
  eq(
    `${status} reste ${status} même en tacite`,
    effectiveStatus(
      { status, renewalMode: "AUTO", startsAt, endsAt },
      afterEnd
    ),
    status
  );
}

// ─── 4. Date de fin effective et reconduction ──────────────

for (const status of ["ACTIVE", "SUSPENDED"] as const) {
  eq(
    `${status}/AUTO repousse la date`,
    day(effectiveEndsAt({ status, renewalMode: "AUTO", startsAt, endsAt }, afterEnd)),
    "2027-01-01"
  );
  eq(
    `${status}/MANUAL ne repousse pas`,
    day(effectiveEndsAt({ status, renewalMode: "MANUAL", startsAt, endsAt }, afterEnd)),
    "2026-01-01"
  );
  eq(
    `${status}/NONE ne repousse pas`,
    day(effectiveEndsAt({ status, renewalMode: "NONE", startsAt, endsAt }, afterEnd)),
    "2026-01-01"
  );
}

for (const status of ["DRAFT", "EXPIRED", "TERMINATED"] as const) {
  eq(
    `${status}/AUTO ne repousse pas`,
    day(effectiveEndsAt({ status, renewalMode: "AUTO", startsAt, endsAt }, afterEnd)),
    "2026-01-01"
  );
}

eq(
  "tacite repousse de plusieurs périodes",
  day(
    effectiveEndsAt(
      { status: "ACTIVE", renewalMode: "AUTO", startsAt, endsAt },
      D("2029-06-01")
    )
  ),
  "2030-01-01"
);
eq(
  "tacite d'un terme de 3 mois",
  day(
    effectiveEndsAt(
      {
        status: "ACTIVE",
        renewalMode: "AUTO",
        startsAt: D("2025-10-15"),
        endsAt: D("2026-01-15"),
      },
      D("2026-06-01")
    )
  ),
  "2026-07-15"
);
eq(
  "prochaine échéance d'un terme de 3 mois",
  day(
    nextTermEnd({
      status: "ACTIVE",
      renewalMode: "MANUAL",
      startsAt: D("2026-01-15"),
      endsAt: D("2026-04-15"),
    })
  ),
  "2026-07-15"
);
eq(
  "prochaine échéance d'un terme dégénéré",
  day(
    nextTermEnd({
      status: "ACTIVE",
      renewalMode: "MANUAL",
      startsAt: D("2026-01-15"),
      endsAt: D("2026-01-20"),
    })
  ),
  "2027-01-20"
);

// ─── 5. Alertes d'échéance ─────────────────────────────────

const autoContract = {
  status: "ACTIVE" as const,
  renewalMode: "AUTO" as const,
  startsAt,
  endsAt,
};
const manualContract = { ...autoContract, renewalMode: "MANUAL" as const };
const noneContract = { ...autoContract, renewalMode: "NONE" as const };

eq("à 214 jours : aucune alerte", expiryAlert(autoContract, D("2025-06-01")).level, "none");
eq("à 61 jours : aucune alerte", expiryAlert(autoContract, D("2025-11-01")).level, "none");
eq("à 60 jours : préavis", expiryAlert(autoContract, D("2025-11-02")).level, "notice");
eq("à 47 jours : préavis", expiryAlert(autoContract, D("2025-11-15")).level, "notice");
eq("à 31 jours : préavis", expiryAlert(autoContract, D("2025-12-01")).level, "notice");
eq("à 30 jours : imminent", expiryAlert(autoContract, D("2025-12-02")).level, "urgent");
eq("à 17 jours : imminent", expiryAlert(autoContract, D("2025-12-15")).level, "urgent");
eq("à 1 jour : imminent", expiryAlert(autoContract, D("2025-12-31")).level, "urgent");

check(
  "l'alerte tacite annonce la reconduction",
  (expiryAlert(autoContract, D("2025-11-15")).message ?? "").includes(
    "Reconduction tacite"
  )
);
check(
  "l'urgence tacite dit de renégocier",
  (expiryAlert(autoContract, D("2025-12-15")).message ?? "")
    .toLowerCase()
    .includes("renégociez")
);
check(
  "l'alerte manuelle annonce l'échéance",
  (expiryAlert(manualContract, D("2025-11-15")).message ?? "").includes("Échéance")
);
check(
  "l'urgence manuelle dit que le contrat s'arrêtera",
  (expiryAlert(manualContract, D("2025-12-15")).message ?? "").includes("s'arrêtera")
);
check(
  "un contrat tacite n'est jamais « échu » : il se reconduit",
  expiryAlert(autoContract, D("2026-02-01")).level === "none"
);

const manualExpired = expiryAlert(manualContract, D("2026-02-01"));
eq("manuel dépassé : échu", manualExpired.level, "expired");
check(
  "l'échéance manquée est dite",
  (manualExpired.message ?? "").includes("n'a pas été décidé à temps")
);
check(
  "un contrat sans renouvellement le dit",
  (expiryAlert(noneContract, D("2026-02-01")).message ?? "").includes(
    "aucun renouvellement"
  )
);
eq(
  "un contrat résilié n'a aucune alerte",
  expiryAlert({ ...autoContract, status: "TERMINATED" }, D("2025-11-15")),
  { level: "none", days: 0, message: null }
);

/*
 * La borne exacte : à l'instant même de la date de fin, `effectiveStatus`
 * compare `now > endsAt` — donc le contrat est encore en vigueur, et c'est
 * `daysUntil` qui rend zéro. Un contrat manuel y est déjà échu (la date est
 * atteinte), un contrat tacite a déjà repris sa période suivante.
 */
eq(
  "à la date de fin exacte, un contrat manuel est échu",
  expiryAlert(manualContract, endsAt),
  {
    level: "expired",
    days: 0,
    message: "Contrat échu — la date de fin est atteinte.",
  }
);
eq(
  "à la date de fin exacte, la tacite a déjà repris",
  expiryAlert(autoContract, endsAt).level,
  "none"
);

// ─── 6. File « Décision requise » ──────────────────────────

for (const renewalMode of ["AUTO", "MANUAL", "NONE"] as const) {
  eq(
    `décision ${renewalMode} à 47 jours`,
    decisionLevel({ ...autoContract, renewalMode }, D("2025-11-15")),
    renewalMode === "NONE" ? null : "notice"
  );
  eq(
    `décision ${renewalMode} à 17 jours`,
    decisionLevel({ ...autoContract, renewalMode }, D("2025-12-15")),
    renewalMode === "NONE" ? null : "urgent"
  );
  eq(
    `décision ${renewalMode} à 214 jours`,
    decisionLevel({ ...autoContract, renewalMode }, D("2025-06-01")),
    null
  );
}

for (const status of ["DRAFT", "ACTIVE", "SUSPENDED", "EXPIRED", "TERMINATED"] as const) {
  eq(
    `décision depuis l'état ${status}`,
    decisionLevel({ ...autoContract, status }, D("2025-11-15")),
    status === "ACTIVE" || status === "SUSPENDED" ? "notice" : null
  );
}

eq(
  "décision : échu exclu",
  decisionLevel(manualContract, D("2026-02-01")),
  null
);
check(
  "requiresDecision résume decisionLevel",
  requiresDecision(autoContract, D("2025-11-15")) &&
    !requiresDecision(autoContract, D("2025-06-01")) &&
    !requiresDecision(noneContract, D("2025-11-15"))
);

// ─── 7. Cohérence des dates et des transitions saisies ─────

check(
  "fin avant début refusée",
  datesRefusal({ startsAt: D("2026-06-01"), endsAt: D("2026-01-01"), noticeDays: 60 }) !== null
);
check(
  "fin égale au début refusée",
  datesRefusal({ startsAt: D("2026-01-01"), endsAt: D("2026-01-01"), noticeDays: 0 }) !== null
);
check(
  "préavis négatif refusé",
  datesRefusal({ startsAt: D("2026-01-01"), endsAt: D("2027-01-01"), noticeDays: -1 }) !== null
);
check(
  "préavis égal au terme refusé",
  datesRefusal({ startsAt: D("2026-01-01"), endsAt: D("2026-03-01"), noticeDays: 59 }) !== null
);
eq(
  "préavis plus court que le terme accepté",
  datesRefusal({ startsAt: D("2026-01-01"), endsAt: D("2026-03-01"), noticeDays: 58 }),
  null
);
eq(
  "préavis nul accepté",
  datesRefusal({ startsAt: D("2026-01-01"), endsAt: D("2026-03-01"), noticeDays: 0 }),
  null
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
check(
  "renouvellement à la même date refusé",
  renewalRefusal({ currentEndsAt: D("2027-01-01"), newEndsAt: D("2027-01-01") }) !== null
);
eq(
  "renouvellement vers l'avant accepté",
  renewalRefusal({ currentEndsAt: D("2027-01-01"), newEndsAt: D("2028-01-01") }),
  null
);

check(
  "résiliation d'un contrat déjà résilié refusée",
  terminationRefusal({ status: "TERMINATED", reason: "Client parti" }) !== null
);
check(
  "résiliation sans motif refusée",
  terminationRefusal({ status: "ACTIVE", reason: "  " }) !== null
);
check(
  "résiliation sans motif (undefined) refusée",
  terminationRefusal({ status: "DRAFT", reason: undefined }) !== null
);
eq(
  "résiliation motivée acceptée",
  terminationRefusal({ status: "ACTIVE", reason: "Client parti" }),
  null
);

// ─── 8. Palier effectif et barème ──────────────────────────

eq(
  "contrat actif gouverne",
  effectiveSlaTier({ slaTier: "PREMIUM", status: "ACTIVE" }, "BASIC"),
  "PREMIUM"
);
eq(
  "contrat suspendu ne gouverne pas",
  effectiveSlaTier({ slaTier: "PREMIUM", status: "SUSPENDED" }, "BASIC"),
  "BASIC"
);
eq(
  "brouillon ne gouverne pas",
  effectiveSlaTier({ slaTier: "PREMIUM", status: "DRAFT" }, "BASIC"),
  "BASIC"
);
eq(
  "contrat résilié ne gouverne pas",
  effectiveSlaTier({ slaTier: "PREMIUM", status: "TERMINATED" }, "BASIC"),
  "BASIC"
);
eq(
  "aucun contrat → repli immeuble",
  effectiveSlaTier(null, "STANDARD"),
  "STANDARD"
);
eq(
  "aucun contrat (undefined) → repli immeuble",
  effectiveSlaTier(undefined, "STANDARD"),
  "STANDARD"
);

eq("BASIC", SLA_COMMITMENTS.BASIC, {
  responseHours: 48,
  interventionHours: 120,
});
eq("STANDARD", SLA_COMMITMENTS.STANDARD, {
  responseHours: 24,
  interventionHours: 72,
});
eq("PREMIUM", SLA_COMMITMENTS.PREMIUM, {
  responseHours: 8,
  interventionHours: 48,
});
eq("ENTERPRISE", SLA_COMMITMENTS.ENTERPRISE, {
  responseHours: 4,
  interventionHours: 24,
});

eq("préavis par défaut 60 j", DEFAULT_NOTICE_DAYS, 60);
eq("seuil de préavis 60 j", EXPIRY_NOTICE_DAYS, 60);
eq("seuil d'urgence 30 j", EXPIRY_URGENT_DAYS, 30);

// ─── 9. Journal des révisions ─────────────────────────────

eq("création", revisionSummary("CREATED", {}, {}), "Contrat créé.");
eq(
  "changement de palier",
  revisionSummary("TIER_CHANGED", { slaTier: "STANDARD" }, { slaTier: "PREMIUM" }),
  "Palier : STANDARD → PREMIUM"
);
eq(
  "changement de dates",
  revisionSummary("DATES_CHANGED", { endsAt: D("2027-01-01") }, { endsAt: D("2028-01-01") }),
  "Fin : 2027-01-01 → 2028-01-01"
);
eq(
  "changement d'état",
  revisionSummary("STATUS_CHANGED", { status: "ACTIVE" }, { status: "SUSPENDED" }),
  "État : ACTIVE → SUSPENDED"
);
eq(
  "changement de renouvellement",
  revisionSummary("RENEWAL_CHANGED", { renewalMode: "AUTO" }, { renewalMode: "MANUAL" }),
  "Renouvellement : AUTO → MANUAL"
);
eq(
  "changement d'immeubles",
  revisionSummary("BUILDINGS_CHANGED", { buildings: 2 }, { buildings: 3 }),
  "Immeubles : 2 → 3"
);
eq(
  "changement des délais",
  revisionSummary(
    "COMMITMENT_CHANGED",
    { responseHours: 24, interventionHours: 72 },
    { responseHours: 8, interventionHours: 48 }
  ),
  "Prise en charge : 24 → 8 · Intervention : 72 → 48"
);
eq(
  "reconduction tacite",
  revisionSummary(
    "TACIT_RENEWAL",
    { endsAt: D("2026-01-01") },
    { endsAt: D("2027-01-01") }
  ),
  "Fin : 2026-01-01 → 2027-01-01"
);
eq(
  "champ inconnu rendu sous son nom technique",
  revisionSummary("STATUS_CHANGED", { inconnu: "a" }, { inconnu: "b" }),
  "inconnu : a → b"
);
eq(
  "valeur nulle rendue en tiret",
  revisionSummary(
    "STATUS_CHANGED",
    { terminationReason: null },
    { terminationReason: "Client parti" }
  ),
  "Motif de résiliation : — → Client parti"
);
eq(
  "booléen rendu en oui/non",
  revisionSummary("STATUS_CHANGED", { drapeau: false }, { drapeau: true }),
  "drapeau : non → oui"
);
eq(
  "valeur absente rendue en tiret",
  revisionSummary("STATUS_CHANGED", { note: undefined }, { note: "x" }),
  "note : — → x"
);
eq(
  "aucun changement",
  revisionSummary("STATUS_CHANGED", { a: 1 }, { a: 1 }),
  "Aucun champ modifié."
);
eq(
  "deux dates identiques ne produisent pas de ligne",
  revisionSummary(
    "DATES_CHANGED",
    { endsAt: D("2027-01-01") },
    { endsAt: D("2027-01-01") }
  ),
  "Aucun champ modifié."
);

// ─── 10. Couverture d'un immeuble ─────────────────────────

function coverage(
  id: string,
  buildingIds: readonly string[],
  overrides: Partial<CoverageContract> = {}
): CoverageContract {
  return {
    id,
    reference: `CT-2026-${id}`,
    slaTier: "STANDARD",
    status: "ACTIVE",
    effectiveStatus: "ACTIVE",
    startsAt: D("2026-01-01").toISOString(),
    endsAt: D("2027-01-01").toISOString(),
    effectiveEndsAt: D("2027-01-01").toISOString(),
    renewalMode: "AUTO",
    noticeDays: 60,
    responseHours: 24,
    interventionHours: 72,
    buildings: buildingIds.map((buildingId) => ({
      id: buildingId,
      name: `Immeuble ${buildingId}`,
      city: "Alger",
    })),
    expiry: { level: "none", days: 300, message: null },
    ...overrides,
  };
}

eq(
  "aucun contrat ne couvre l'immeuble",
  contractForBuilding([coverage("a", ["bld_1"])], "bld_2"),
  null
);
eq(
  "le contrat de l'immeuble est retenu",
  contractForBuilding([coverage("a", ["bld_1"]), coverage("b", ["bld_2"])], "bld_2")?.id,
  "b"
);
eq(
  "un contrat multi-immeubles couvre chacun d'eux",
  contractForBuilding([coverage("a", ["bld_1", "bld_2"])], "bld_2")?.id,
  "a"
);
eq(
  "un contrat en vigueur l'emporte sur un suspendu",
  contractForBuilding(
    [
      coverage("suspendu", ["bld_1"], { effectiveStatus: "SUSPENDED", status: "SUSPENDED" }),
      coverage("actif", ["bld_1"]),
    ],
    "bld_1"
  )?.id,
  "actif"
);
eq(
  "le contrat le plus récent l'emporte à état égal",
  contractForBuilding(
    [
      coverage("ancien", ["bld_1"], { startsAt: D("2025-01-01").toISOString() }),
      coverage("recent", ["bld_1"], { startsAt: D("2026-01-01").toISOString() }),
    ],
    "bld_1"
  )?.id,
  "recent"
);

const coverageInput = [
  coverage("a", ["bld_1"]),
  coverage("b", ["bld_1"]),
];
const orderBefore = coverageInput.map((contract) => contract.id).join(",");
contractForBuilding(coverageInput, "bld_1");
eq(
  "le choix ne réordonne pas le tableau d'entrée",
  coverageInput.map((contract) => contract.id).join(","),
  orderBefore
);

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
