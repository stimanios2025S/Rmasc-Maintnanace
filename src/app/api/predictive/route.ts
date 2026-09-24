/**
 * ElevatorPulse – Predictive AI API
 *
 * POST /api/predictive             – Run prediction for one elevator
 * POST /api/predictive {batch:true}– Run predictions for the whole fleet
 * GET  /api/predictive?elevatorId= – Latest scores
 *
 * Running an analysis mutates `Elevator.overallHealth` and `PredictiveScore`
 * and can raise work orders, so both verbs are restricted to management
 * roles. Previously any authenticated user — including a building owner —
 * could trigger an unbounded fleet-wide analysis.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { z } from "zod";
import {
  badRequest,
  handleRouteError,
  notFound,
  parseEnumParam,
  readJson,
} from "@/lib/api/http";
import {
  buildingScopeFor,
  MANAGEMENT_ROLES,
  OPS_ROLES,
  requireRole,
} from "@/lib/api/guard";
import type { Prisma } from "@prisma/client";
import {
  analyzeElevator,
  generatePredictiveWorkOrders,
} from "@/lib/ai/predictive-engine";
import { PREDICTIVE_RISK_LEVELS } from "@/types";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoPredictiveScores } from "@/lib/demo/responses";

const PredictRequestSchema = z
  .object({
    elevatorId: z.string().min(1).optional(),
    batch: z.boolean().optional(),
    /** When true, skip auto-creating work orders for at-risk components. */
    dryRun: z.boolean().optional(),
  })
  .strict();

/** Upper bound on a single batch run, to keep the request bounded. */
const MAX_BATCH_SIZE = 500;

// ─── POST: run analysis ─────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    await requireRole(...MANAGEMENT_ROLES);
    const body = PredictRequestSchema.parse(await readJson(request));

    if (body.batch) {
      const elevators = await prisma.elevator.findMany({
        where: { isActive: true },
        select: { id: true, elevatorCode: true },
        take: MAX_BATCH_SIZE,
      });

      // Sequential on purpose: each analysis writes predictive scores and
      // the elevator's health, so running them concurrently would contend on
      // the same rows.
      const results: Array<Record<string, unknown>> = [];
      for (const elevator of elevators) {
        try {
          const analysis = await analyzeElevator(elevator.id);
          const generated = body.dryRun
            ? { created: [], escalated: [] }
            : await generatePredictiveWorkOrders(analysis);
          results.push({
            elevatorCode: analysis.elevatorCode,
            overallHealth: analysis.overallHealth,
            overallRisk: analysis.overallRisk,
            componentsCount: analysis.components.length,
            worseningCount: analysis.components.filter(
              (c) => c.riskTrend === "worsening"
            ).length,
            workOrdersGenerated: generated.created.length,
            workOrdersEscalated: generated.escalated.length,
          });
        } catch (err) {
          console.error(
            `[predictive] analysis failed for ${elevator.elevatorCode}:`,
            err
          );
          results.push({
            elevatorCode: elevator.elevatorCode,
            error: (err as Error).message,
          });
        }
      }

      const failed = results.filter((r) => "error" in r).length;
      return NextResponse.json({
        success: failed === 0,
        analyzed: results.length,
        failed,
        results,
      });
    }

    if (!body.elevatorId) {
      throw badRequest("elevatorId (chaîne) est requis, ou passez batch: true");
    }

    const exists = await prisma.elevator.findUnique({
      where: { id: body.elevatorId },
      select: { id: true },
    });
    if (!exists) throw notFound(`Ascenseur introuvable : ${body.elevatorId}`);

    const analysis = await analyzeElevator(body.elevatorId);
    const generated = body.dryRun
      ? { created: [], escalated: [] }
      : await generatePredictiveWorkOrders(analysis);

    return NextResponse.json({
      success: true,
      analysis,
      workOrdersGenerated: generated.created.length,
      workOrderIds: generated.created,
      workOrdersEscalated: generated.escalated.length,
      escalatedWorkOrderIds: generated.escalated,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

// ─── GET: latest scores ─────────────────────────────────────

const RISK_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
const riskRank = (level: string) => RISK_ORDER.indexOf(level as never);

export async function GET(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");

    const { searchParams } = new URL(request.url);
    const elevatorId = searchParams.get("elevatorId");
    const riskLevel = parseEnumParam(
      searchParams,
      "riskLevel",
      PREDICTIVE_RISK_LEVELS
    );

    // Staff see the whole fleet; a BUILDING_OWNER only its own portfolio.
    // `?elevatorId=` is not a capability — it was previously enough to read
    // any unit's component-level failure predictions.
    const ownerScope: Prisma.PredictiveScoreWhereInput =
      session.user.role === "BUILDING_OWNER"
        ? { elevator: { building: buildingScopeFor(session) } }
        : {};

    if (elevatorId) {
      const scores = await prisma.predictiveScore.findMany({
        where: {
          ...ownerScope,
          elevatorId,
          ...(riskLevel ? { riskLevel } : {}),
        },
        orderBy: [{ riskScore: "desc" }],
        include: {
          component: { select: { id: true, name: true, componentType: true } },
        },
      });
      return NextResponse.json({ data: scores });
    }

    // One row per (elevatorId, componentType) is stored, so a naive
    // `distinct: ["elevatorId"]` returned an arbitrary component's score and
    // labelled it "the latest score for the elevator". Instead, report the
    // worst-scoring component per elevator, which is what a fleet overview
    // actually needs.
    const all = await prisma.predictiveScore.findMany({
      where: { ...ownerScope, ...(riskLevel ? { riskLevel } : {}) },
      orderBy: { riskScore: "desc" },
      include: {
        elevator: {
          select: {
            id: true,
            elevatorCode: true,
            status: true,
            overallHealth: true,
            building: { select: { name: true } },
          },
        },
      },
    });

    const worstPerElevator = new Map<string, (typeof all)[number]>();
    for (const score of all) {
      if (!worstPerElevator.has(score.elevatorId)) {
        // `all` is sorted worst-first, so the first row seen wins.
        worstPerElevator.set(score.elevatorId, score);
      }
    }

    const data = [...worstPerElevator.values()].sort(
      (a, b) => riskRank(b.riskLevel) - riskRank(a.riskLevel)
    );

    return NextResponse.json({ data });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/predictive");
      const { searchParams } = new URL(request.url);
      return NextResponse.json({
        data: demoPredictiveScores({
          elevatorId: searchParams.get("elevatorId"),
          riskLevel: searchParams.get("riskLevel"),
        }),
      });
    }
    return handleRouteError(error);
  }
}
