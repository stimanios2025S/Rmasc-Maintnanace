/**
 * ElevatorPulse – Predictive AI Engine
 *
 * Calculates Remaining Useful Life (RUL) and Predictive Risk Scores
 * for elevator components using statistical degradation models.
 *
 * In production, this would call a Python FastAPI + Scikit-learn service.
 * This TypeScript implementation provides the same mathematical foundation.
 */

import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";
import type {
  RULResult,
  PredictiveAnalysis,
  PredictiveRiskLevel,
} from "@/types";
import {
  createWorkOrderWithUniqueNumber,
  getSystemCreatorId,
  OPEN_WORK_ORDER_STATUSES,
} from "@/lib/work-orders/service";
import { notify, notifyRoles } from "@/lib/notifications/service";
import { enumLabel } from "@/lib/ui/enum-labels";
import { MANAGEMENT_ROLES } from "@/types";
import type { WorkOrderPriority } from "@/types";

/** Stamped onto every persisted score so results are traceable to a model. */
export const MODEL_VERSION = "ts-degradation-v1.1";

// ─── Component Degradation Model Parameters ─────────────────

interface DegradationModel {
  baseLifeHours: number;       // Expected total life in operating hours
  vibrationFactor: number;     // Sensitivity to vibration (mm/s per unit wear)
  temperatureFactor: number;   // Sensitivity to temperature deviation
  cycleFactor: number;         // Sensitivity to door cycles
  warningThreshold: number;    // RUL% that triggers WARNING
  criticalThreshold: number;   // RUL% that triggers CRITICAL
}

const DEGRADATION_MODELS: Record<string, DegradationModel> = {
  TRACTION_MOTOR: {
    baseLifeHours: 60000,
    vibrationFactor: 0.15,
    temperatureFactor: 0.12,
    cycleFactor: 0.0,
    warningThreshold: 30,
    criticalThreshold: 10,
  },
  STEEL_ROPES: {
    baseLifeHours: 50000,
    vibrationFactor: 0.08,
    temperatureFactor: 0.05,
    cycleFactor: 0.10,
    warningThreshold: 25,
    criticalThreshold: 8,
  },
  DOOR_OPERATOR: {
    baseLifeHours: 40000,
    vibrationFactor: 0.05,
    temperatureFactor: 0.03,
    cycleFactor: 0.20,
    warningThreshold: 20,
    criticalThreshold: 5,
  },
  BRAKE_ASSEMBLY: {
    baseLifeHours: 45000,
    vibrationFactor: 0.10,
    temperatureFactor: 0.08,
    cycleFactor: 0.12,
    warningThreshold: 25,
    criticalThreshold: 8,
  },
  GUIDE_SHOES: {
    baseLifeHours: 35000,
    vibrationFactor: 0.18,
    temperatureFactor: 0.04,
    cycleFactor: 0.06,
    warningThreshold: 22,
    criticalThreshold: 7,
  },
  CONTROLLER_BOARD: {
    baseLifeHours: 80000,
    vibrationFactor: 0.03,
    temperatureFactor: 0.15,
    cycleFactor: 0.0,
    warningThreshold: 20,
    criticalThreshold: 5,
  },
};

// ─── Core RUL Calculation Algorithm ─────────────────────────

/**
 * Calculates Remaining Useful Life using a modified exponential
 * degradation model with multi-factor acceleration.
 *
 * Formula:
 *   RUL% = max(0, 100 - (effectiveWear / baseLifeHours) * 100)
 *
 * Where effectiveWear accounts for:
 *   - Time-based aging (currentLifeHours)
 *   - Vibration acceleration (vibration excess * factor * hours)
 *   - Thermal acceleration (temp excess * factor * hours)
 *   - Cycle acceleration (cycle count * factor)
 */
function calculateRUL(
  componentType: string,
  currentLifeHours: number,
  avgVibration: number,
  avgTemperature: number,
  totalDoorCycles: number,
  /** Per-component rated life; falls back to the table default when absent. */
  ratedLifeHours?: number | null,
  /**
   * Share of the recent telemetry window in which the driving metrics were
   * actually reported, in [0, 1]. Scales the confidence down when the score
   * rests on little or no sensor data.
   */
  telemetryCoverage = 1,
): {
  rulPercent: number;
  riskScore: number;
  predictedFailureDate: Date | null;
  confidence: number;
} {
  const tableModel = DEGRADATION_MODELS[componentType] ?? {
    baseLifeHours: 50000,
    vibrationFactor: 0.10,
    temperatureFactor: 0.08,
    cycleFactor: 0.10,
    warningThreshold: 25,
    criticalThreshold: 8,
  };

  // A component's own nameplate life wins over the generic table value: the
  // seed and the registration flow both record `expectedLifeHours`, and a
  // 40,000-hour door operator was being scored against the table's figure
  // rather than the life it was actually installed with.
  const model =
    ratedLifeHours && ratedLifeHours > 0
      ? { ...tableModel, baseLifeHours: ratedLifeHours }
      : tableModel;

  // Normal operating baselines
  const baselineVibration = 2.5;  // mm/s RMS normal
  const baselineTemperature = 65; // °C normal operating

  // Excess wear from abnormal conditions
  const vibrationExcess = Math.max(0, avgVibration - baselineVibration);
  const temperatureExcess = Math.max(0, avgTemperature - baselineTemperature);

  // Effective wear = time + accelerated degradation
  const timeWear = currentLifeHours;
  const vibrationWear =
    vibrationExcess * model.vibrationFactor * currentLifeHours;
  const thermalWear =
    temperatureExcess * model.temperatureFactor * currentLifeHours;
  const cycleWear = totalDoorCycles * model.cycleFactor * 0.001; // normalize

  const effectiveWear =
    timeWear + vibrationWear + thermalWear + cycleWear;

  // RUL percentage (0-100)
  const rulPercent = Math.max(
    0,
    Math.min(100, 100 - (effectiveWear / model.baseLifeHours) * 100)
  );

  // Risk score: inverse of RUL with severity amplification
  let riskScore = 100 - rulPercent;
  if (vibrationExcess > 3.0) riskScore = Math.min(100, riskScore + 15);
  if (temperatureExcess > 20) riskScore = Math.min(100, riskScore + 10);
  riskScore = Math.max(0, Math.min(100, riskScore));

  // Predicted failure date
  const remainingHours = model.baseLifeHours - effectiveWear;
  const avgHoursPerDay = 10; // assume ~10 operating hours/day
  const daysUntilFailure =
    remainingHours > 0 ? remainingHours / avgHoursPerDay : 0;
  const predictedFailureDate =
    daysUntilFailure > 0
      ? new Date(Date.now() + daysUntilFailure * 24 * 60 * 60 * 1000)
      : new Date(); // already failed

  // Confidence based on data quality. Two independent limits: how far into
  // its rated life the component is (a nearly-new part is a weaker basis for
  // a prediction), and how much of the telemetry window actually carried the
  // metrics this score is built from. A score computed from no readings at
  // all lands at 0.4× the lifetime term rather than reporting high certainty.
  const coverageFactor = 0.4 + 0.6 * Math.max(0, Math.min(1, telemetryCoverage));
  const confidence =
    Math.min(0.95, 0.5 + currentLifeHours / model.baseLifeHours) *
    coverageFactor;

  return { rulPercent, riskScore, predictedFailureDate, confidence };
}

function classifyRisk(
  rulPercent: number,
  riskScore: number
): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  if (rulPercent <= 10 || riskScore >= 90) return "CRITICAL";
  if (rulPercent <= 25 || riskScore >= 70) return "HIGH";
  if (rulPercent <= 50 || riskScore >= 45) return "MEDIUM";
  return "LOW";
}

// ─── Trend detection ────────────────────────────────────────

const RISK_RANK: Record<string, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/**
 * How much the risk *score* must climb, at an unchanged level, before it
 * counts as worsening. Ten points of a 100-point scale is roughly the gap
 * between two adjacent bands, so it is a change of substance rather than of
 * rounding — the model is statistical and small moves between runs mean
 * nothing.
 */
const RISK_SCORE_DRIFT = 10;

/**
 * Compares this analysis with the last one for the same component.
 *
 * A level change is the headline; a large move within a level is worth
 * reporting too, because a component sitting at 89/100 CRITICAL and one at
 * 99/100 CRITICAL are not the same problem, and only the second is about to
 * fail.
 */
function classifyTrend(
  previous: { riskLevel: string; riskScore: number } | undefined,
  riskLevel: string,
  riskScore: number
): "new" | "improving" | "stable" | "worsening" {
  if (!previous) return "new";

  const was = RISK_RANK[previous.riskLevel] ?? 0;
  const now = RISK_RANK[riskLevel] ?? 0;

  if (now > was) return "worsening";
  if (now < was) return "improving";
  return riskScore - previous.riskScore >= RISK_SCORE_DRIFT
    ? "worsening"
    : "stable";
}

function generateRecommendations(
  componentType: string,
  riskLevel: string,
  rulPercent: number,
  avgVibration: number,
  avgTemperature: number
): string[] {
  const recs: string[] = [];

  // The human-readable component name, in French, from the one label table the
  // whole interface reads (`src/lib/ui/enum-labels.ts`). Lower-cased because it
  // sits mid-sentence, inside « » so a French reader sees it as a term rather
  // than as a word that disagrees with the sentence around it.
  const part = componentLabelFor(componentType).toLowerCase();

  // One decimal, French decimal comma — these strings are shown on the
  // elevator screen and copied into work orders.
  const rul = rulPercent.toLocaleString("fr-FR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

  if (riskLevel === "CRITICAL") {
    recs.push(`URGENT : planifier sans délai l'inspection du composant « ${part} »`);
    recs.push(
      "Préparer les pièces de rechange et ouvrir une fenêtre de maintenance d'urgence"
    );
  }

  if (riskLevel === "HIGH") {
    recs.push(
      `Planifier le remplacement préventif du composant « ${part} » sous deux semaines`
    );
    recs.push("Passer à un contrôle quotidien de la télémétrie");
  }

  if (avgVibration > 4.0) {
    recs.push("Vibrations élevées — vérifier les boulons de fixation et l'alignement");
  }

  if (avgTemperature > 80) {
    recs.push(
      "Température en hausse — inspecter le système de refroidissement et de ventilation"
    );
  }

  if (rulPercent < 50 && rulPercent > 10) {
    recs.push(
      `Composant à ${rul} % de durée de vie utile restante — prévoir le remplacement au prochain cycle de maintenance`
    );
  }

  if (recs.length === 0) {
    recs.push(
      "Composant dans les paramètres normaux — poursuivre la surveillance de routine"
    );
  }

  return recs;
}

// ─── Public Analysis Functions ──────────────────────────────

export async function analyzeElevator(
  elevatorId: string
): Promise<PredictiveAnalysis> {
  const elevator = await prisma.elevator.findUniqueOrThrow({
    where: { id: elevatorId },
    include: {
      // Active components only. This previously pulled every component,
      // including retired ones, which had three consequences: a
      // replaced-and-deactivated part kept being scored, kept dragging the
      // elevator's mean `overallHealth` down, and kept raising HIGH/CRITICAL
      // predictive work orders for a part that is no longer installed —
      // while the components tab (which filters on `isActive`) showed no such
      // part. Deactivating a component could not stop any of it.
      components: { where: { isActive: true } },
      telemetryStreams: {
        orderBy: { timestamp: "desc" },
        take: 100, // Last 100 telemetry readings
      },
    },
  });

  // ── Sensor averages ───────────────────────────────────────
  //
  // Average only the readings that were actually reported.
  //
  // The previous version substituted the *normal* baseline for every absent
  // sample (`t.motorVibrationMmS ?? 2.5`), which made a missing sensor look
  // like a healthy one. The failure mode was not mild: with 99 absent
  // readings and one genuine spike to 9.0 mm/s, the mean came out at 2.565
  // and the excess-wear term rounded to zero — a real vibration fault
  // averaged away by the silence around it. It also meant a unit reporting
  // no telemetry at all scored as perfectly healthy.
  //
  // With no readings for a metric there is no evidence of excess wear, so the
  // baseline stands — but that is now an explicit "unknown", not a
  // per-sample fabrication, and it costs confidence below.
  const telemetry = elevator.telemetryStreams;

  const avgOf = (values: Array<number | null>, baseline: number): number => {
    const reported = values.filter((v): v is number => v !== null);
    return reported.length > 0
      ? reported.reduce((s, v) => s + v, 0) / reported.length
      : baseline;
  };

  const avgVibration = avgOf(
    telemetry.map((t) => t.motorVibrationMmS),
    2.5
  );
  const avgTemperature = avgOf(
    telemetry.map((t) => t.motorTemperatureC),
    65
  );

  /**
   * Share of the recent window in which each metric was actually reported,
   * in [0, 1]. Drives the confidence penalty below.
   */
  const coverageOf = (values: Array<number | null>): number =>
    values.length > 0
      ? values.filter((v) => v !== null).length / values.length
      : 0;

  const coverage =
    (coverageOf(telemetry.map((t) => t.motorVibrationMmS)) +
      coverageOf(telemetry.map((t) => t.motorTemperatureC))) /
    2;

  /**
   * The previous analysis, read *before* anything below overwrites it.
   *
   * `analyzeElevator` upserts `PredictiveScore` in the same run, so by the time
   * this function returns, the prior figures are gone. Reading them here is the
   * only chance to know whether a component improved, held, or got worse —
   * which is what `generatePredictiveWorkOrders` needs in order to notice that
   * an already-open order covers a part that has since deteriorated.
   */
  const priorScores = await prisma.predictiveScore.findMany({
    where: { elevatorId: elevator.id },
    select: { componentType: true, riskLevel: true, riskScore: true },
  });
  const priorByType = new Map(
    priorScores.map((s) => [s.componentType, { riskLevel: s.riskLevel, riskScore: s.riskScore }])
  );

  const componentAnalyses: RULResult[] = [];
  const writes: Prisma.PrismaPromise<unknown>[] = [];

  for (const component of elevator.components) {
    const result = calculateRUL(
      component.componentType,
      component.currentLifeHours,
      avgVibration,
      avgTemperature,
      elevator.doorCycleCount,
      component.expectedLifeHours,
      coverage
    );

    const riskLevel = classifyRisk(result.rulPercent, result.riskScore);
    const recommendations = generateRecommendations(
      component.componentType,
      riskLevel,
      result.rulPercent,
      avgVibration,
      avgTemperature
    );

    const rulPercent = Math.round(result.rulPercent * 10) / 10;

    const prior = priorByType.get(component.componentType);
    const riskTrend = classifyTrend(prior, riskLevel, result.riskScore);

    // A worsening component's advice changes: "monitor daily" is the wrong
    // instruction for a part that just fell another band. The line is prepended
    // so it reads before the standing recommendations rather than after them.
    if (riskTrend === "worsening" && prior) {
      recommendations.unshift(
        `Dégradation : le risque est passé de ${prior.riskLevel} à ${riskLevel} ` +
          `depuis la dernière analyse (score ${Math.round(prior.riskScore)} → ${Math.round(result.riskScore)}). ` +
          "Traiter le bon de travail existant en priorité plutôt que d'attendre le prochain cycle."
      );
    }

    componentAnalyses.push({
      componentId: component.id,
      componentType: component.componentType,
      remainingUsefulLifePercent: rulPercent,
      riskLevel,
      riskScore: Math.round(result.riskScore * 10) / 10,
      predictedFailureDate: result.predictedFailureDate,
      confidence: Math.round(result.confidence * 100) / 100,
      recommendations,
      previousRiskLevel: (prior?.riskLevel as PredictiveRiskLevel) ?? null,
      riskTrend,
    });

    // Persist the predictive score (uses the @@unique([elevatorId, componentType]) key)
    const scoreFeatures = {
      avgVibration,
      avgTemperature,
      currentLifeHours: component.currentLifeHours,
      doorCycleCount: elevator.doorCycleCount,
    };
    writes.push(
      prisma.predictiveScore.upsert({
        where: {
          elevatorId_componentType: {
            elevatorId: elevator.id,
            componentType: component.componentType,
          },
        },
        create: {
          elevatorId: elevator.id,
          componentId: component.id,
          componentType: component.componentType,
          riskLevel,
          riskScore: result.riskScore,
          remainingUsefulLifePercent: result.rulPercent,
          predictedFailureDate: result.predictedFailureDate,
          confidence: result.confidence,
          modelVersion: MODEL_VERSION,
          recommendations,
          features: scoreFeatures,
        },
        update: {
          componentId: component.id,
          riskLevel,
          riskScore: result.riskScore,
          remainingUsefulLifePercent: result.rulPercent,
          predictedFailureDate: result.predictedFailureDate,
          confidence: result.confidence,
          recommendations,
          features: scoreFeatures,
        },
      })
    );

    // Keep the component row in step with the analysis. Only the seed script
    // ever wrote `ElevatorComponent.remainingUsefulLife`, so once an analysis
    // ran, the RUL tab (which reads predictive scores) and the Components tab
    // and radar chart (which read the component rows) showed two different
    // remaining-life figures for the same part.
    writes.push(
      prisma.elevatorComponent.update({
        where: { id: component.id },
        data: { remainingUsefulLife: rulPercent },
      })
    );
  }

  // Overall health is the mean of component RULs
  const overallHealth =
    componentAnalyses.length > 0
      ? componentAnalyses.reduce((s, c) => s + c.remainingUsefulLifePercent, 0) /
        componentAnalyses.length
      : 100;
  const roundedHealth = Math.round(overallHealth * 10) / 10;

  // Overall risk is the worst component risk
  const riskPriority = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  const overallRisk = componentAnalyses.reduce(
    (worst, c) =>
      riskPriority.indexOf(c.riskLevel) < riskPriority.indexOf(worst)
        ? c.riskLevel
        : worst,
    "LOW" as string
  ) as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

  writes.push(
    prisma.elevator.update({
      where: { id: elevatorId },
      data: { overallHealth: roundedHealth },
    })
  );

  // One transaction for the whole analysis: a partial write would leave the
  // fleet's health figures disagreeing with each other.
  await prisma.$transaction(writes);

  return {
    elevatorId: elevator.id,
    elevatorCode: elevator.elevatorCode,
    overallHealth: roundedHealth,
    overallRisk,
    components: componentAnalyses,
    analyzedAt: new Date(),
  };
}

/**
 * Work-order priority required for each risk level the engine raises on.
 *
 * Typed as the schema's enum rather than `string`: this value is written
 * straight into `WorkOrder.priority`, and a typo here would only surface as a
 * Prisma write error at three in the morning, on the one elevator that
 * mattered.
 */
const PRIORITY_FOR_RISK: Record<string, WorkOrderPriority> = {
  CRITICAL: "EMERGENCY",
  HIGH: "HIGH",
};

const PRIORITY_RANK: Record<string, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  EMERGENCY: 3,
  CRITICAL: 4,
};

/** `TRACTION_MOTOR` -> "Moteur de traction". */
function componentLabelFor(componentType: string): string {
  return enumLabel(componentType);
}

/**
 * The spelling `componentLabelFor` used before the French pass.
 *
 * Kept for one purpose only: recognising work orders raised back when the title
 * template was English. Those titles are rows in the database and did not
 * change when this file did, so the fallback lookup below has to know both
 * spellings or it will fail to find the order it raised and raise a duplicate.
 */
function legacyComponentLabelFor(componentType: string): string {
  return componentType.replace(/_/g, " ");
}

/**
 * The title a predictive work order is raised under.
 *
 * Written once and used both to create the order and to find it again on the
 * next run, so the two can never drift into two different strings.
 */
function predictiveOrderTitle(
  componentType: string,
  riskLevel: string
): string {
  return `Préventif : ${componentLabelFor(componentType)} — risque ${riskLevel}`;
}

function descriptionFor(component: RULResult): string {
  return [
    `L'analyse prédictive a détecté un risque ${component.riskLevel} sur le composant « ${componentLabelFor(component.componentType).toLowerCase()} ».`,
    `Durée de vie utile restante : ${component.remainingUsefulLifePercent} %. Score de risque : ${component.riskScore}/100.`,
    ...(component.previousRiskLevel && component.riskTrend === "worsening"
      ? [
          "",
          `Ce composant s'est dégradé depuis la dernière analyse ` +
            `(${component.previousRiskLevel} → ${component.riskLevel}).`,
        ]
      : []),
    "",
    "Recommandations :",
    ...component.recommendations.map((r) => `• ${r}`),
  ].join("\n");
}

/**
 * Schedules a first visit a week ahead of failure — the point of the prediction
 * is to arrive before it, not after.
 */
function scheduledFor(component: RULResult): Date | null {
  return component.predictedFailureDate
    ? new Date(new Date(component.predictedFailureDate).getTime() - 7 * 24 * 60 * 60 * 1000)
    : null;
}

/**
 * The lead time an escalation books ahead of the predicted failure, in days.
 *
 * Ratified: three days, not zero and not the seven `scheduledFor` uses.
 *
 * The reasoning is the one that produced the zero: an escalation happens
 * because a component that was already judged worth a visit has deteriorated
 * anyway, so the earlier forecast was optimistic — each run that finds it worse
 * has dragged the failure date closer. A *fixed* seven-day lead in that
 * situation lets the visit drift along behind a failure that keeps moving up to
 * meet it, which is how a "preventive" order ends up being a repair.
 *
 * Three days is the middle answer. It still lands the technician before the
 * part fails — the whole point of a prediction — while staying short enough
 * that a failure date which moves again next run has not been padded with a
 * week of slack the component may not have. The buffer is subtracted from
 * *each* newly predicted date, so re-running the engine on a still-worsening
 * component moves the visit again rather than pinning it.
 */
const ESCALATION_SAFETY_BUFFER_DAYS = 3;

/**
 * The date an *escalation* pins the order to: the newly predicted failure date,
 * less the safety buffer.
 *
 * Deliberately different from `scheduledFor`'s fixed week. See the constant
 * above for why the two differ and why neither is zero.
 */
function escalationTargetDate(component: RULResult): Date | null {
  if (!component.predictedFailureDate) return null;

  const failureDate = new Date(component.predictedFailureDate);
  return new Date(
    failureDate.getTime() -
      ESCALATION_SAFETY_BUFFER_DAYS * 24 * 60 * 60 * 1000
  );
}

/** ISO date, the form a technician reads off a job sheet. */
function asDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * The clause that tells the holder what happened to their diary.
 *
 * Written as a sentence rather than a field because it is the one part of the
 * notification the recipient has to act on, and "scheduledDate: 2026-10-04"
 * reads like a database row. When the date has not moved, saying so is better
 * than staying silent — it answers the question the message raises.
 */
function dateSentence(previous: Date | null, next: Date | null): string {
  if (!next) return "Le bon de travail garde sa date actuelle.";
  if (!previous) return `Il est désormais planifié au ${asDate(next)}.`;
  if (previous.getTime() === next.getTime()) {
    return `La date prévue reste inchangée au ${asDate(next)}.`;
  }
  return `Sa date prévue passe du ${asDate(previous)} au ${asDate(next)}.`;
}

/**
 * Raises predictive work orders for HIGH and CRITICAL risk components, and
 * escalates the ones that already had one.
 *
 * De-duplication keys on `componentId` rather than a substring match against
 * the order's title. The previous `title: { contains: "TRACTION MOTOR" }`
 * check conflated component types across elevators, depended on the exact
 * rendered wording of the title, and would have matched any future title that
 * happened to contain the same words.
 *
 * THE GAP THIS CLOSES
 * Skipping a component that already had an open order was right, but it was
 * also the whole story — so a part that was HIGH when the order was raised and
 * is CRITICAL by the next run changed nothing. Its order stayed at HIGH, no
 * notification was sent, and the deterioration was recorded only in a score
 * row nobody watches. For a platform whose purpose is to predict failures
 * before they happen, the fastest-moving failure was the quietest.
 *
 * Now a worsening component with an open order is escalated: the order's
 * priority goes to CRITICAL, its description is refreshed with the new figures,
 * its target date moves to the newly predicted failure date, and the assigned
 * technician is told — in terms of the date, since that is what changes their
 * day. When nobody holds the order, the management roles get it instead.
 *
 * CRITICAL is set flat rather than derived from the new risk level. An
 * escalation means the component moved after it was already judged worth an
 * order; it has earned the top of the scale regardless of which band it landed
 * in, and `PRIORITY_FOR_RISK` still governs the band on creation.
 *
 * The notification fires only when the priority was actually raised (or the
 * order is unassigned), so a component sitting at CRITICAL for a week does not
 * generate a daily ping while still keeping its record current.
 *
 * @returns the ids created, and the ids escalated.
 */
export async function generatePredictiveWorkOrders(
  analysis: PredictiveAnalysis
): Promise<{ created: string[]; escalated: string[] }> {
  const atRisk = analysis.components.filter(
    (c) => c.riskLevel === "HIGH" || c.riskLevel === "CRITICAL"
  );
  if (atRisk.length === 0) return { created: [], escalated: [] };

  const createdById = await getSystemCreatorId();
  if (!createdById) {
    console.warn(
      "[predictive] no active admin/manager to own generated work orders; skipping"
    );
    return { created: [], escalated: [] };
  }

  const componentIds = atRisk
    .map((c) => c.componentId)
    .filter((id): id is string => id !== null);

  const existing = await prisma.workOrder.findMany({
    where: {
      elevatorId: analysis.elevatorId,
      type: "PREDICTIVE",
      status: { in: [...OPEN_WORK_ORDER_STATUSES] },
      OR: [
        ...(componentIds.length > 0 ? [{ componentId: { in: componentIds } }] : []),
        // Components without a tracked row fall back to matching on type.
        //
        // Both spellings are listed. `title` is compared against rows already
        // in the database, and the orders raised before the French pass carry
        // the English wording; matching only the new one would stop recognising
        // them and raise a second order for a component that already has one.
        {
          componentId: null,
          title: {
            in: atRisk.flatMap((c) => [
              predictiveOrderTitle(c.componentType, c.riskLevel),
              `Predictive: ${legacyComponentLabelFor(c.componentType)} — ${c.riskLevel} Risk`,
            ]),
          },
        },
      ],
    },
    select: {
      id: true,
      orderNumber: true,
      componentId: true,
      title: true,
      priority: true,
      assignedToId: true,
      // The escalation explains itself in terms of the date, so the date it
      // moved *from* has to be read before the update overwrites it.
      scheduledDate: true,
    },
  });

  // Indexed by both keys so either lookup is O(1); a component row is matched
  // by its id, an untracked one by the title it was created with.
  const openByComponent = new Map<string, (typeof existing)[number]>();
  const openByTitle = new Map<string, (typeof existing)[number]>();
  for (const order of existing) {
    if (order.componentId) openByComponent.set(order.componentId, order);
    else openByTitle.set(order.title, order);
  }

  const created: string[] = [];
  const escalated: string[] = [];

  for (const component of atRisk) {
    const key = component.componentId ?? null;
    const title = predictiveOrderTitle(
      component.componentType,
      component.riskLevel
    );
    const open = key
      ? openByComponent.get(key)
      : openByTitle.get(title);

    if (!open) {
      const workOrder = await createWorkOrderWithUniqueNumber(
        {
          title,
          description: descriptionFor(component),
          type: "PREDICTIVE",
          priority: PRIORITY_FOR_RISK[component.riskLevel] ?? "HIGH",
          elevatorId: analysis.elevatorId,
          componentId: component.componentId,
          createdById,
          scheduledDate: scheduledFor(component),
        },
        "PRED"
      );

      created.push(workOrder.id);
      continue;
    }

    // An open order already covers this component. Only a deterioration is
    // worth writing about — a stable or improving part is being handled.
    if (component.riskTrend !== "worsening") continue;

    // Flat CRITICAL, not derived from the new band: this component was already
    // judged to need an order and has moved anyway. See the note above.
    const ESCALATED_PRIORITY: WorkOrderPriority = "CRITICAL";
    const wasRaised =
      (PRIORITY_RANK[open.priority] ?? 0) < (PRIORITY_RANK[ESCALATED_PRIORITY] ?? 0);

    const targetDate = escalationTargetDate(component);
    const previousDate = open.scheduledDate;
    const dateMoved =
      targetDate !== null &&
      (previousDate === null ||
        previousDate.getTime() !== targetDate.getTime());

    await prisma.workOrder.update({
      where: { id: open.id },
      data: {
        // The record has to carry the current figures either way: a technician
        // reading it must not be working from last month's numbers.
        description: descriptionFor(component),
        priority: ESCALATED_PRIORITY,
        scheduledDate: targetDate ?? undefined,
      },
    });

    escalated.push(open.id);

    // Nothing changed that the holder would act on. The record is current,
    // which is the point of writing it; a ping saying "still CRITICAL, still
    // the same date" is noise.
    if (!wasRaised && !dateMoved && open.assignedToId) continue;

    const message =
      `Le composant « ${componentLabelFor(component.componentType).toLowerCase()} » de ${analysis.elevatorCode} ` +
      `est passé au niveau de risque ${component.riskLevel} (auparavant ${component.previousRiskLevel ?? "non évalué"}). ` +
      `Durée de vie utile restante : ${component.remainingUsefulLifePercent} %. ` +
      dateSentence(previousDate, targetDate) +
      ` Le bon de travail ${open.orderNumber} couvre cette intervention.`;

    if (open.assignedToId) {
      await notify({
        userId: open.assignedToId,
        title: `Composant en dégradation – ${analysis.elevatorCode}`,
        message,
        type: "work_order",
        linkUrl: "/technicien",
      });
    } else {
      // Nobody is holding it. The people who assign work are the ones who need
      // to know it just became urgent.
      await notifyRoles([...MANAGEMENT_ROLES], {
        title: `Travail urgent non affecté – ${analysis.elevatorCode}`,
        message,
        type: "work_order",
        linkUrl: "/bons-de-travail",
      });
    }
  }

  return { created, escalated };
}
