/**
 * ElevatorPulse – IoT Telemetry Ingestion API
 *
 * POST /api/telemetry  – Ingest a single telemetry reading (token-gated)
 * GET  /api/telemetry  – Latest telemetry (authenticated)
 *
 * Threshold breaches create alerts and, for critical breaches, an emergency
 * work order. Threshold rules come from the database — see
 * `src/lib/iot/thresholds.ts`.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { z } from "zod";
import { handleRouteError, parsePagination, readJson } from "@/lib/api/http";
import { buildingScopeFor, OPS_ROLES, requireRole } from "@/lib/api/guard";
import {
  evaluateThreshold,
  loadThresholds,
  payloadThresholds,
  type ThresholdDefinition,
} from "@/lib/iot/thresholds";
import { raiseEmergencyWorkOrder } from "@/lib/work-orders/service";
import type { Prisma } from "@prisma/client";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoTelemetry } from "@/lib/demo/responses";

// ─── Ingest auth ────────────────────────────────────────────
// When IOT_INGEST_TOKEN is configured, IoT devices must send
// `Authorization: Bearer <token>`. Unset = open (local dev only).

function isIngestAuthorized(request: NextRequest): boolean {
  const expected = process.env.IOT_INGEST_TOKEN;
  if (!expected) return true;

  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;

  const provided = header.slice(prefix.length).trim();
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  // Comparing digests keeps the check constant-time regardless of where the
  // first differing byte falls.
  if (provided.length !== expected.length) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return timingSafeEqual(a, b);
}

// ─── Validation ─────────────────────────────────────────────

const TelemetrySchema = z
  .object({
    elevatorCode: z.string().min(1).max(50),
    timestamp: z.string().datetime().optional(),
    data: z
      .object({
        motorVibrationMmS: z.number().min(0).max(50).optional(),
        motorTemperatureC: z.number().min(-20).max(200).optional(),
        doorCycleCount: z.number().int().min(0).optional(),
        doorSpeedMs: z.number().min(0).max(5).optional(),
        // Upper bound is deliberately loose: cabin load is evaluated against
        // each unit's rated capacity, so a genuinely overloaded reading must
        // not be rejected before it can raise an alert.
        cabinLoadKg: z.number().min(0).max(20000).optional(),
        levelingOffsetMm: z.number().min(-50).max(50).optional(),
        operatingHours: z.number().min(0).optional(),
        brakeActuations: z.number().int().min(0).optional(),
        supplyVoltageV: z.number().min(0).max(600).optional(),
        currentDrawA: z.number().min(0).max(200).optional(),
      })
      .strict(),
  })
  .strict();

type TelemetryData = z.infer<typeof TelemetrySchema>["data"];

/** Maps payload fields onto threshold rule names, in evaluation order. */
const METRIC_FIELDS: ReadonlyArray<{
  field: keyof TelemetryData;
  metricName: string;
}> = [
  { field: "motorVibrationMmS", metricName: "motor_vibration_mm_s" },
  { field: "motorTemperatureC", metricName: "motor_temperature_c" },
  { field: "levelingOffsetMm", metricName: "leveling_offset_mm" },
  { field: "doorSpeedMs", metricName: "door_speed_ms" },
  { field: "cabinLoadKg", metricName: "cabin_load_kg" },
  { field: "supplyVoltageV", metricName: "supply_voltage_v" },
  { field: "currentDrawA", metricName: "current_draw_a" },
];

// ─── POST: Ingest telemetry ─────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    if (!isIngestAuthorized(request)) {
      return NextResponse.json(
        { error: "Non autorisé : un jeton d'ingestion valide est requis" },
        { status: 401 }
      );
    }

    // readJson turns malformed JSON into a 400 instead of a 500.
    const parsed = TelemetrySchema.parse(await readJson(request));

    const elevator = await prisma.elevator.findUnique({
      where: { elevatorCode: parsed.elevatorCode },
      select: {
        id: true,
        elevatorCode: true,
        status: true,
        maxPayloadKg: true,
      },
    });

    if (!elevator) {
      return NextResponse.json(
        { error: `Ascenseur introuvable : ${parsed.elevatorCode}` },
        { status: 404 }
      );
    }

    const timestamp = parsed.timestamp ? new Date(parsed.timestamp) : new Date();
    const data = parsed.data;

    const cumulative: {
      operatingHours?: number;
      doorCycleCount?: number;
      brakeActuations?: number;
    } = {};
    if (data.operatingHours !== undefined) cumulative.operatingHours = data.operatingHours;
    if (data.doorCycleCount !== undefined) cumulative.doorCycleCount = data.doorCycleCount;
    if (data.brakeActuations !== undefined) cumulative.brakeActuations = data.brakeActuations;

    const snapshotFields = {
      motorVibrationMmS: data.motorVibrationMmS,
      motorTemperatureC: data.motorTemperatureC,
      doorCycleCount: data.doorCycleCount,
      doorSpeedMs: data.doorSpeedMs,
      cabinLoadKg: data.cabinLoadKg,
      levelingOffsetMm: data.levelingOffsetMm,
      operatingHours: data.operatingHours,
      brakeActuations: data.brakeActuations,
      supplyVoltageV: data.supplyVoltageV,
      currentDrawA: data.currentDrawA,
    };

    // The stream row, the latest-value snapshot and the elevator's cumulative
    // counters describe one atomic reading — write them together so a partial
    // failure cannot leave the snapshot ahead of the history.
    const stream = await prisma.$transaction(async (tx) => {
      const created = await tx.telemetryStream.create({
        data: { elevatorId: elevator.id, timestamp, ...snapshotFields },
      });

      await tx.telemetrySnapshot.upsert({
        where: { elevatorId: elevator.id },
        create: {
          elevatorId: elevator.id,
          lastUpdated: timestamp,
          ...snapshotFields,
        },
        update: { lastUpdated: timestamp, ...snapshotFields },
      });

      if (Object.keys(cumulative).length > 0) {
        await tx.elevator.update({
          where: { id: elevator.id },
          data: cumulative,
        });
      }

      return created;
    });

    // ── Threshold alerting ──────────────────────────────────
    const thresholds = await loadThresholds();

    type CreatedAlert = {
      id: string;
      severity: string;
      message: string;
      workOrderCreated: boolean;
    };
    const alerts: CreatedAlert[] = [];

    for (const { field, metricName } of METRIC_FIELDS) {
      const value = data[field];
      if (value === undefined) continue;

      // Overload is relative to rated capacity, not a fleet-wide constant.
      const definition: ThresholdDefinition | undefined =
        metricName === "cabin_load_kg"
          ? payloadThresholds(elevator.maxPayloadKg)
          : thresholds.get(metricName);
      if (!definition) continue;

      const breach = evaluateThreshold(definition, value);
      if (!breach) continue;

      const alertTitle = `${definition.title}: ${elevator.elevatorCode}`;

      const alert = await prisma.alert.create({
        data: {
          elevatorId: elevator.id,
          thresholdRuleId: definition.id,
          severity: breach.severity,
          title: alertTitle,
          message: breach.message,
          metricName,
          metricValue: value,
        },
        select: { id: true, severity: true, message: true },
      });

      let workOrderCreated = false;
      if (breach.severity === "CRITICAL") {
        const result = await raiseEmergencyWorkOrder({
          elevatorId: elevator.id,
          elevatorCode: elevator.elevatorCode,
          alertId: alert.id,
          metricName,
          title: `URGENCE : ${alertTitle}`,
          message: breach.message,
          severity: "CRITICAL",
        });
        workOrderCreated = result?.created ?? false;
      }

      alerts.push({
        id: alert.id,
        severity: alert.severity,
        message: alert.message,
        workOrderCreated,
      });
    }

    // ── Reflect the worst breach on the elevator status ─────
    const worst = alerts.some((a) => a.severity === "CRITICAL")
      ? "CRITICAL"
      : alerts.length > 0
        ? "WARNING"
        : null;

    if (worst === "CRITICAL" && elevator.status !== "CRITICAL_SHUTDOWN") {
      await prisma.elevator.update({
        where: { id: elevator.id },
        data: { status: "CRITICAL_SHUTDOWN" },
      });
    } else if (
      worst === "WARNING" &&
      (elevator.status === "OPERATIONAL" || elevator.status === "OFFLINE")
    ) {
      await prisma.elevator.update({
        where: { id: elevator.id },
        data: { status: "SERVICE_REQUIRED" },
      });
    }

    return NextResponse.json({
      success: true,
      streamId: stream.id,
      alertsGenerated: alerts.length,
      workOrdersCreated: alerts.filter((a) => a.workOrderCreated).length,
      alerts,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

// ─── GET: Telemetry history / latest snapshots ──────────────
//
// Authenticated. This endpoint previously sat on the middleware's anonymous
// allow-list because the matcher was written as `pathname.startsWith(
// "/api/telemetry")` — intended to let *devices* POST readings, but it also
// published the whole fleet's telemetry, including building names, to anyone.

export async function GET(request: NextRequest) {
  try {
    // `requireSession()` alone was not enough: it let any authenticated
    // account — including a third-party BUILDING_OWNER — read the fleet's
    // raw sensor history by passing any `elevatorId`, and every unit's latest
    // reading when it passed none.
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");

    const { searchParams } = new URL(request.url);
    const elevatorId = searchParams.get("elevatorId");

    // Annotated rather than inferred: both read branches below use this, and
    // an inferred union would tie the shared value to whichever Prisma model
    // happened to be inferred first.
    const ownerScope: { elevator?: Prisma.ElevatorWhereInput } =
      session.user.role === "BUILDING_OWNER"
        ? { elevator: { building: buildingScopeFor(session) } }
        : {};

    if (elevatorId) {
      const { limit } = parsePagination(searchParams, { maxLimit: 500 });
      const streams = await prisma.telemetryStream.findMany({
        where: { ...ownerScope, elevatorId },
        orderBy: { timestamp: "desc" },
        take: limit,
      });
      return NextResponse.json({ data: streams });
    }

    const snapshots = await prisma.telemetrySnapshot.findMany({
      where: ownerScope,
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
      orderBy: { lastUpdated: "desc" },
    });

    return NextResponse.json({ data: snapshots });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/telemetry");
      const { searchParams } = new URL(request.url);
      const { limit } = parsePagination(searchParams, { maxLimit: 500 });
      return NextResponse.json({
        data: demoTelemetry({
          elevatorId: searchParams.get("elevatorId"),
          limit,
        }),
      });
    }
    return handleRouteError(error);
  }
}
