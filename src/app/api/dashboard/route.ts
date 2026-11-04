/**
 * Maintenance RMASC – Dashboard Overview API
 *
 * GET /api/dashboard – Fleet KPIs, status breakdown, building health and
 *                      recent alerts, scoped to the caller's access.
 *
 * A BUILDING_OWNER sees only the buildings they own. Previously the endpoint
 * had no authorisation at all beyond the middleware gate and returned the
 * entire fleet to every role, including other owners' buildings.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError } from "@/lib/api/http";
import { requireRole } from "@/lib/api/guard";
import type { Prisma } from "@prisma/client";
import { effectiveStatus } from "@/lib/contracts/status";
import {
  evaluateThreshold,
  loadThresholds,
  payloadThresholds,
} from "@/lib/iot/thresholds";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoDashboard } from "@/lib/demo/responses";

// Reads the session and the database on every request; it must never be
// statically prerendered at build time.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    /**
     * Vue de bureau : les agrégats couvrent tout le parc. Un technicien est
     * redirigé hors de `/tableau-de-bord` par le middleware ; cette garde ferme
     * l'appel direct à la route.
     */
    const session = await requireRole(
      "ADMIN",
      "MAINTENANCE_MANAGER",
      "BUILDING_OWNER"
    );

    // Scope every query in this handler through one filter.
    const buildingScope: Prisma.BuildingWhereInput =
      session.user.role === "BUILDING_OWNER"
        ? { isActive: true, ownerId: session.user.id }
        : { isActive: true };

    const elevatorScope: Prisma.ElevatorWhereInput = {
      isActive: true,
      building: buildingScope,
    };
    const workOrderScope: Prisma.WorkOrderWhereInput = {
      elevator: { building: buildingScope },
    };

    const [
      totalBuildings,
      elevators,
      openWorkOrders,
      emergencyWorkOrders,
      recentAlerts,
      recentWorkOrders,
      contracts,
      snapshotRows,
      blockedCriticalParts,
    ] = await Promise.all([
        prisma.building.count({ where: buildingScope }),
        prisma.elevator.findMany({
          where: elevatorScope,
          select: {
            id: true,
            status: true,
            overallHealth: true,
            // Lu pour la charge de cabine : la surcharge se juge par rapport à
            // la capacité nominale de l'appareil, pas contre un seuil absolu.
            maxPayloadKg: true,
          },
        }),
        prisma.workOrder.count({
          where: {
            ...workOrderScope,
            status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS", "ON_HOLD"] },
          },
        }),
        prisma.workOrder.count({
          where: {
            ...workOrderScope,
            priority: { in: ["EMERGENCY", "CRITICAL"] },
            status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS", "ON_HOLD"] },
          },
        }),
        prisma.alert.findMany({
          where: { resolvedAt: null, elevator: elevatorScope },
          orderBy: { createdAt: "desc" },
          take: 8,
          include: { elevator: { select: { elevatorCode: true } } },
        }),
        /**
         * Les dernières interventions, pour la vue client.
         *
         * Le client n'a pas accès au tableau des bons de travail — c'est
         * précisément ce que le nettoyage de navigation lui retire — donc la
         * seule façon pour lui de voir ce qui a été fait chez lui est de le lui
         * montrer ici. C'est la même portée de requête que les compteurs
         * ci-dessus : un propriétaire ne voit que ses immeubles.
         *
         * Trié sur `createdAt` et non sur `completedAt` : une intervention
         * ouverte il y a deux jours et une visite terminée ce matin sont deux
         * nouvelles, et trier sur la date d'achèvement ferait disparaître la
         * première de la liste avant qu'elle ne soit close.
         */
        prisma.workOrder.findMany({
          where: workOrderScope,
          orderBy: { createdAt: "desc" },
          take: 6,
          select: {
            id: true,
            orderNumber: true,
            title: true,
            type: true,
            status: true,
            createdAt: true,
            scheduledDate: true,
            completedAt: true,
            elevator: { select: { elevatorCode: true } },
          },
        }),
        /**
         * Les contrats en cours, pour le compteur « immeubles sous contrat ».
         *
         * `effectiveStatus` est appliqué plus bas plutôt qu'en base : un
         * contrat `ACTIVE` dont la date est passée ne couvre plus rien, et un
         * filtre SQL sur le seul statut annoncerait un immeuble couvert que la
         * page des contrats déclare échu. La règle est celle de
         * `src/lib/contracts/status.ts`, la même que lit le badge de couverture.
         */
        prisma.contract.findMany({
          where: {
            status: { in: ["ACTIVE", "SUSPENDED"] },
            buildings: { some: { building: buildingScope } },
          },
          select: {
            status: true,
            renewalMode: true,
            startsAt: true,
            endsAt: true,
            buildings: { select: { buildingId: true } },
          },
        }),
        /**
         * Le dernier relevé de chaque appareil, pour le centre de télémétrie.
         *
         * `TelemetrySnapshot` porte exactement une ligne par appareil — c'est
         * sa clé unique — donc pas de fenêtre glissante ni de doublons : le
         * panneau lit l'état courant, l'historique reste dans le graphique.
         */
        prisma.telemetrySnapshot.findMany({
          where: { elevator: elevatorScope },
          select: {
            elevatorId: true,
            lastUpdated: true,
            motorVibrationMmS: true,
            motorTemperatureC: true,
            cabinLoadKg: true,
            elevator: {
              select: {
                elevatorCode: true,
                status: true,
                maxPayloadKg: true,
                building: { select: { name: true } },
              },
            },
          },
        }),
        /**
         * Les interventions prioritaires bloquées par une pièce.
         *
         * Une urgence rouge qui attend une pièce n'est pas visible sur le
         * tableau : elle a un technicien, un statut normal, et pourtant elle
         * n'avancera pas. C'est la seule alerte de ce panneau qui ne se déduit
         * d'aucun compteur, et c'est pourquoi elle a sa propre requête.
         */
        prisma.workOrder.count({
          where: {
            ...workOrderScope,
            priority: { in: ["EMERGENCY", "CRITICAL"] },
            status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS", "ON_HOLD"] },
            partRequirements: {
              some: { status: { in: ["PENDING_STOCK_CHECK", "ORDER_REQUIRED"] } },
            },
          },
        }),
      ]);

    const countByStatus = (status: string) =>
      elevators.filter((e) => e.status === status).length;

    const avgHealth =
      elevators.length > 0
        ? Math.round(
            (elevators.reduce((sum, e) => sum + e.overallHealth, 0) /
              elevators.length) *
              10
          ) / 10
        : 0;

    /**
     * Combien d'immeubles sont réellement couverts aujourd'hui.
     *
     * Distinct des brouillons et des contrats échus : c'est la question que
     * pose la carte « Parc global », et y répondre par le nombre d'immeubles
     * existants serait un chiffre qui ne veut rien dire pour un dispatcheur.
     */
    const now = new Date();
    const coveredBuildings = new Set<string>();
    for (const contract of contracts) {
      if (effectiveStatus(contract, now) !== "ACTIVE") continue;
      for (const link of contract.buildings) coveredBuildings.add(link.buildingId);
    }
    const buildingsUnderContract = coveredBuildings.size;

    const buildings = await prisma.building.findMany({
      where: buildingScope,
      select: {
        id: true,
        name: true,
        elevators: {
          where: { isActive: true },
          select: { overallHealth: true },
        },
      },
      orderBy: { name: "asc" },
    });

    const buildingHealth = buildings.map((b) => ({
      id: b.id,
      name: b.name,
      elevators: b.elevators.length,
      health:
        b.elevators.length > 0
          ? Math.round(
              b.elevators.reduce((sum, e) => sum + e.overallHealth, 0) /
                b.elevators.length
            )
          : 0,
    }));

    // Real telemetry for the chart on the overview screen.
    //
    // The screen previously rendered client-side sine waves under a green
    // "LIVE" badge and the caption "Real-time sensor data streams". The series
    // is now the genuine readings from whichever elevator reported most
    // recently, and the caller is told which unit it is looking at and when it
    // last reported, so a stale feed cannot masquerade as live.
    const latestReading = await prisma.telemetryStream.findFirst({
      where: { elevator: elevatorScope },
      orderBy: { timestamp: "desc" },
      select: {
        elevatorId: true,
        timestamp: true,
        elevator: { select: { elevatorCode: true } },
      },
    });

    let telemetryFeed: {
      elevatorId: string;
      elevatorCode: string;
      lastReadingAt: Date;
      points: {
        timestamp: Date;
        motorVibrationMmS: number | null;
        motorTemperatureC: number | null;
        cabinLoadKg: number | null;
      }[];
    } | null = null;

    if (latestReading) {
      const recent = await prisma.telemetryStream.findMany({
        where: { elevatorId: latestReading.elevatorId },
        orderBy: { timestamp: "desc" },
        take: 30,
        select: {
          timestamp: true,
          motorVibrationMmS: true,
          motorTemperatureC: true,
          cabinLoadKg: true,
        },
      });

      telemetryFeed = {
        elevatorId: latestReading.elevatorId,
        elevatorCode: latestReading.elevator.elevatorCode,
        lastReadingAt: latestReading.timestamp,
        // Oldest first so the chart reads left-to-right in time order.
        points: recent.reverse(),
      };
    }

    /**
     * L'état courant des capteurs, appareil par appareil.
     *
     * Les seuils sont ceux que l'exploitant a réglés (`ThresholdRule`), lus
     * par le même module que l'ingestion — un panneau qui afficherait un
     * voyant vert sur une valeur que l'ingestion vient d'alerter serait pire
     * que pas de panneau du tout. La charge de cabine fait exception et se
     * juge contre la capacité nominale de chaque machine, comme à l'ingestion.
     */
    const thresholds = await loadThresholds();
    const sensorSnapshot = snapshotRows
      .map((row) => {
        const candidates = [
          {
            definition: thresholds.get("motor_temperature_c") ?? null,
            value: row.motorTemperatureC,
          },
          {
            definition: thresholds.get("motor_vibration_mm_s") ?? null,
            value: row.motorVibrationMmS,
          },
          {
            definition: payloadThresholds(row.elevator.maxPayloadKg),
            value: row.cabinLoadKg,
          },
        ];

        const readings = candidates.flatMap(({ definition, value }) => {
          if (!definition || value === null) return [];
          const breach = evaluateThreshold(definition, value);
          return [
            {
              metricName: definition.metricName,
              title: definition.title,
              unit: definition.unit,
              value,
              level:
                breach === null
                  ? "ok"
                  : breach.severity === "CRITICAL"
                    ? "critical"
                    : "warning",
            },
          ];
        });

        return {
          elevatorId: row.elevatorId,
          elevatorCode: row.elevator.elevatorCode,
          buildingName: row.elevator.building.name,
          status: row.elevator.status,
          lastUpdated: row.lastUpdated,
          readings,
        };
      })
      .sort((a, b) => a.elevatorCode.localeCompare(b.elevatorCode));

    return NextResponse.json({
      data: {
        telemetryFeed,
        sensorSnapshot,
        stats: {
          totalBuildings,
          buildingsUnderContract,
          totalElevators: elevators.length,
          operationalCount: countByStatus("OPERATIONAL"),
          serviceRequiredCount: countByStatus("SERVICE_REQUIRED"),
          anomalyCount: countByStatus("ANOMALY_DETECTED"),
          criticalCount: countByStatus("CRITICAL_SHUTDOWN"),
          offlineCount: countByStatus("OFFLINE"),
          openWorkOrders,
          emergencyWorkOrders,
          /** Urgences bloquées par une pièce manquante (stock ou commande). */
          blockedCriticalParts,
          avgHealth,
        },
        statusBreakdown: [
          { name: "En service", value: countByStatus("OPERATIONAL"), color: "#22c55e" },
          { name: "Entretien requis", value: countByStatus("SERVICE_REQUIRED"), color: "#eab308" },
          { name: "Anomalie", value: countByStatus("ANOMALY_DETECTED"), color: "#f97316" },
          { name: "Arrêt critique", value: countByStatus("CRITICAL_SHUTDOWN"), color: "#ef4444" },
          { name: "Hors ligne", value: countByStatus("OFFLINE"), color: "#6b7280" },
        ],
        buildingHealth,
        recentAlerts: recentAlerts.map((a) => ({
          id: a.id,
          elevator: a.elevator.elevatorCode,
          message: a.message,
          severity: a.severity,
          createdAt: a.createdAt,
          acknowledged: a.isAcknowledged,
        })),
        recentWorkOrders: recentWorkOrders.map((w) => ({
          id: w.id,
          orderNumber: w.orderNumber,
          title: w.title,
          type: w.type,
          status: w.status,
          elevator: w.elevator.elevatorCode,
          createdAt: w.createdAt,
          scheduledDate: w.scheduledDate,
          completedAt: w.completedAt,
        })),
      },
    });
  } catch (error) {
    // Development convenience: with no PostgreSQL running, serve the fixture
    // so the dashboard renders. Real data is unaffected — this branch is only
    // reached when the query itself could not connect. See src/lib/demo/mode.ts.
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/dashboard");
      return NextResponse.json({ data: demoDashboard() });
    }
    return handleRouteError(error);
  }
}
