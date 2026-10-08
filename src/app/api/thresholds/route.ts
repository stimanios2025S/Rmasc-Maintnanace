/**
 * Maintenance RMASC – Réglage des seuils d'alerte
 *
 * GET    /api/thresholds             – les six grandeurs, leurs bornes en vigueur
 *                                      et celles par défaut
 * PATCH  /api/thresholds             – poser ou modifier les bornes d'une grandeur
 * DELETE /api/thresholds?metricName= – retirer la personnalisation, revenir au défaut
 *
 * POURQUOI CETTE ROUTE EXISTE
 * `ThresholdRule` était lu à chaque ingestion télémetrique, et rien dans
 * l'application ne permettait d'en écrire une : les seuils étaient ceux du
 * seed, et ils y seraient restés. Toutes les alertes du parc se déclenchaient
 * donc sur des valeurs que personne ne pouvait corriger — le seul mécanisme de
 * surveillance de l'application était figé à sa valeur d'installation.
 *
 * ELLE INVALIDE LE CACHE, ET C'EST INDISPENSABLE
 * `loadThresholds` garde les règles trente secondes en mémoire. Sans appel à
 * `invalidateThresholdCache`, un exploitant corrige un seuil et continue de
 * recevoir les alertes de l'ancien pendant une demi-minute — le temps exact
 * qu'il faut pour conclure que le réglage n'a pas marché. La fonction était
 * exportée depuis le début et n'était appelée nulle part.
 *
 * LA LECTURE EST OUVERTE AUX TECHNICIENS, L'ÉCRITURE NON
 * Voir les seuils appliqués est une information de terrain : un technicien qui
 * reçoit une alerte de vibration doit pouvoir lire à partir de quoi elle s'est
 * déclenchée. Les *changer*, c'est décider à partir de quand une machine est
 * signalée — et c'est le responsable maintenance qui connaît les tolérances.
 *
 * SUPPRIMER, C'EST REVENIR AU DÉFAUT — ET NON ARRÊTER LA SURVEILLANCE
 * `loadThresholds` fusionne désormais les valeurs par défaut avec les lignes de
 * la table, par grandeur. Retirer une ligne rend donc la valeur d'origine à
 * cette grandeur-là, sans jamais la laisser sans surveillance. Ce n'était pas
 * le cas avant : la table remplaçait l'ensemble des défauts, et une seule ligne
 * écrite suffisait à éteindre en silence les cinq autres grandeurs.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  badRequest,
  handleRouteError,
  jsonOk,
  readJson,
} from "@/lib/api/http";
import { MANAGEMENT_ROLES, OPS_ROLES, requireRole } from "@/lib/api/guard";
import {
  DERIVED_METRIC,
  EDITABLE_METRIC_NAMES,
  TELEMETRY_METRICS,
  boundsViolation,
} from "@/lib/iot/metric-catalogue";
import { invalidateThresholdCache } from "@/lib/iot/thresholds";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoThresholds } from "@/lib/demo/responses";

export const dynamic = "force-dynamic";

/**
 * Les quatre bornes sont requises, mais nullables.
 *
 * `null` veut dire « pas de borne de ce côté », et c'est une intention qu'il
 * faut pouvoir exprimer. Les rendre facultatives aurait confondu deux choses :
 * « laissez cette borne telle qu'elle est » et « retirez cette borne ». Un
 * formulaire envoie toujours les quatre, donc exiger les quatre ne coûte rien
 * et supprime l'ambiguïté.
 */
const UpdateThresholdSchema = z
  .object({
    metricName: z.string().min(1),
    warningMin: z.number().finite().nullable(),
    warningMax: z.number().finite().nullable(),
    criticalMin: z.number().finite().nullable(),
    criticalMax: z.number().finite().nullable(),
  })
  .strict();

/**
 * Refuse une grandeur qui ne se règle pas ici, en disant pourquoi.
 *
 * Le cas de `cabin_load_kg` mérite sa propre phrase : une ligne écrite pour
 * cette grandeur serait ignorée à l'ingestion, et le commentaire d'origine du
 * module raconte précisément que quiconque l'éditait voyait le changement ne
 * rien faire, en silence. Un refus explicite vaut mieux qu'un champ sans effet.
 */
function assertEditable(metricName: string): void {
  if (metricName === DERIVED_METRIC.metricName) {
    throw badRequest(
      `Les seuils de « ${DERIVED_METRIC.title} » ne se règlent pas ici : ils ` +
        "sont recalculés pour chaque appareil à partir de sa charge maximale, " +
        "et une valeur saisie ici serait ignorée. Modifiez la charge maximale " +
        "de l'appareil concerné."
    );
  }

  if (!EDITABLE_METRIC_NAMES.includes(metricName)) {
    throw badRequest(
      `Grandeur inconnue : « ${metricName} ». Les grandeurs réglables sont : ` +
        EDITABLE_METRIC_NAMES.join(", ") +
        "."
    );
  }
}

// ─── GET ────────────────────────────────────────────────────

export async function GET() {
  try {
    await requireRole(...OPS_ROLES);

    const [rows, capacities] = await Promise.all([
      prisma.thresholdRule.findMany({
        where: { isActive: true },
        select: {
          id: true,
          metricName: true,
          warningMin: true,
          warningMax: true,
          criticalMin: true,
          criticalMax: true,
        },
      }),
      /**
       * Les charges maximales présentes dans le parc.
       *
       * La seule façon honnête de montrer les seuils de surcharge : ils
       * n'existent pas au niveau du parc, ils se recalculent par machine. En
       * rendre une valeur unique laisserait croire à un réglage global qui
       * n'existe pas.
       */
      prisma.elevator.findMany({
        where: { isActive: true },
        select: { maxPayloadKg: true },
        distinct: ["maxPayloadKg"],
        orderBy: { maxPayloadKg: "asc" },
      }),
    ]);

    const byMetric = new Map(rows.map((row) => [row.metricName, row]));

    const metrics = TELEMETRY_METRICS.map((metric) => {
      const row = byMetric.get(metric.metricName);
      const custom = row
        ? {
            warningMin: row.warningMin,
            warningMax: row.warningMax,
            criticalMin: row.criticalMin,
            criticalMax: row.criticalMax,
          }
        : null;

      return {
        metricName: metric.metricName,
        title: metric.title,
        unit: metric.unit,
        description: metric.description,
        defaults: metric.defaults,
        custom,
        // Ce qui s'applique réellement, une fois la fusion faite. Rendu par le
        // serveur plutôt que recalculé à l'écran : la règle de priorité doit
        // vivre à un seul endroit.
        effective: custom ?? metric.defaults,
        isCustom: custom !== null,
      };
    });

    return jsonOk({
      metrics,
      derived: DERIVED_METRIC,
      payloadCapacitiesKg: capacities.map((row) => row.maxPayloadKg),
    });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/thresholds");
      return jsonOk(demoThresholds());
    }
    return handleRouteError(error);
  }
}

// ─── PATCH ──────────────────────────────────────────────────

export async function PATCH(request: NextRequest) {
  try {
    await requireRole(...MANAGEMENT_ROLES);
    const parsed = UpdateThresholdSchema.parse(await readJson(request));

    assertEditable(parsed.metricName);

    const bounds = {
      warningMin: parsed.warningMin,
      warningMax: parsed.warningMax,
      criticalMin: parsed.criticalMin,
      criticalMax: parsed.criticalMax,
    };

    const violation = boundsViolation(bounds);
    if (violation) throw badRequest(violation);

    const saved = await prisma.thresholdRule.upsert({
      where: { metricName: parsed.metricName },
      create: {
        metricName: parsed.metricName,
        ...bounds,
        isActive: true,
      },
      update: {
        ...bounds,
        // Réécrire une règle la réactive : une ligne désactivée à la main en
        // base ne doit pas rester silencieusement inactive après avoir été
        // réglée depuis cet écran, ce qui donnerait un réglage sans effet.
        isActive: true,
      },
      select: {
        id: true,
        metricName: true,
        warningMin: true,
        warningMax: true,
        criticalMin: true,
        criticalMax: true,
      },
    });

    // Sans cet appel, l'ancien seuil reste en vigueur jusqu'à trente secondes.
    invalidateThresholdCache();

    return jsonOk({ rule: saved });
  } catch (error) {
    return handleRouteError(error);
  }
}

// ─── DELETE ─────────────────────────────────────────────────

export async function DELETE(request: NextRequest) {
  try {
    await requireRole(...MANAGEMENT_ROLES);

    const metricName = request.nextUrl.searchParams.get("metricName");
    if (!metricName) {
      throw badRequest("Précisez la grandeur à réinitialiser : `?metricName=`.");
    }

    assertEditable(metricName);

    // `deleteMany` et non `delete` : retirer une personnalisation qui n'existe
    // pas est un succès, pas une erreur. L'écran n'a pas à distinguer « je l'ai
    // remise par défaut » de « elle y était déjà ».
    const removed = await prisma.thresholdRule.deleteMany({ where: { metricName } });

    invalidateThresholdCache();

    return jsonOk({ metricName, removed: removed.count });
  } catch (error) {
    return handleRouteError(error);
  }
}
