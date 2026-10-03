/**
 * Maintenance RMASC – Alerts API
 *
 * GET    /api/alerts             – List alerts (filterable)
 * PATCH  /api/alerts?id=xxx      – Acknowledge / resolve one alert
 * PATCH  /api/alerts             – Acknowledge / resolve several (`ids` in the body)
 *
 * QUI PEUT ACQUITTER
 * La lecture est ouverte à tout le monde, techniciens compris, et au client
 * pour son propre parc. L'écriture est réservée aux rôles de gestion.
 *
 * Le partage est délibéré. Voir une alerte est un fait : une machine signale
 * une surchauffe, le technicien qui monte dans la gaine doit pouvoir le lire.
 * *Acquitter* est un acte d'engagement — « quelqu'un prend cette alerte en
 * charge » — et *résoudre* affirme que le problème est réglé. Ces deux-là
 * engagent l'entreprise, et c'est au bureau de les porter.
 *
 * `acknowledgedBy` conserve qui a signé : la colonne et sa relation existaient
 * depuis le début sans jamais être remplies.
 *
 * POURQUOI LE MODE MASSE EXISTE
 * Il n'y avait aucun moyen d'acquitter plus d'une alerte à la fois, et un
 * écran qui demande de cliquer vingt fois pour vider une file de vingt n'est
 * pas un écran qu'on utilise. L'action de masse envoie donc *la liste des
 * identifiants affichés* plutôt qu'un « toutes » : le serveur ne décide jamais
 * à la place de l'appelant de ce qui était visible à l'écran au moment du clic.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { z } from "zod";
import {
  badRequest,
  handleRouteError,
  notFound,
  parseBooleanParam,
  parseEnumParam,
  parsePagination,
  readJson,
} from "@/lib/api/http";
import {
  buildingScopeFor,
  MANAGEMENT_ROLES,
  OPS_ROLES,
  requireRole,
} from "@/lib/api/guard";
import { ALERT_SEVERITIES } from "@/types";
import type { Prisma } from "@prisma/client";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoAlerts } from "@/lib/demo/responses";

/** Combien d'alertes une action de masse peut porter d'un coup. */
const MAX_BULK_IDS = 200;

const UpdateAlertSchema = z
  .object({
    acknowledged: z.boolean().optional(),
    resolved: z.boolean().optional(),
    /**
     * Mode masse : les alertes à traiter d'un seul geste.
     *
     * Borné à `MAX_BULK_IDS` — un tableau non borné dans un corps de requête
     * est une invitation à faire écrire une clause `IN` de taille arbitraire,
     * et l'écran ne peut de toute façon pas en afficher davantage.
     */
    ids: z.array(z.string().min(1)).min(1).max(MAX_BULK_IDS).optional(),
  })
  .strict()
  .refine(
    (value) => value.acknowledged !== undefined || value.resolved !== undefined,
    { message: "Précisez `acknowledged` ou `resolved` : sans l'un des deux, la requête ne demanderait rien." }
  );

export async function GET(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");

    const { searchParams } = new URL(request.url);
    const { page, limit, skip } = parsePagination(searchParams, {
      maxLimit: 200,
    });

    // Staff see the whole fleet, as before. A BUILDING_OWNER is confined to
    // its own portfolio: without this the sidebar badge counted and the list
    // rendered every other customer's faults. Note this deliberately does not
    // add `elevator.isActive`, so an alert that is still open on a
    // decommissioned unit keeps surfacing to staff.
    const where: Prisma.AlertWhereInput =
      session.user.role === "BUILDING_OWNER"
        ? { elevator: { building: buildingScopeFor(session) } }
        : {};

    const elevatorId = searchParams.get("elevatorId");
    if (elevatorId) where.elevatorId = elevatorId;

    const severity = parseEnumParam(searchParams, "severity", ALERT_SEVERITIES);
    if (severity) where.severity = severity;

    const acknowledged = parseBooleanParam(searchParams, "acknowledged");
    if (acknowledged !== undefined) where.isAcknowledged = acknowledged;

    const resolved = parseBooleanParam(searchParams, "resolved");
    if (resolved !== undefined) {
      where.resolvedAt = resolved ? { not: null } : null;
    }

    const [alerts, total] = await Promise.all([
      prisma.alert.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip,
        include: {
          elevator: {
            select: {
              id: true,
              elevatorCode: true,
              status: true,
              building: { select: { name: true } },
            },
          },
          /**
           * Qui a acquitté, et quand.
           *
           * Sans cette relation la liste affichait « Acquittée » sans dire par
           * qui — or c'est précisément la question qu'on pose à une file
           * d'alertes : « quelqu'un s'en est-il occupé, et qui ? ». La colonne
           * existe depuis le début ; elle n'était simplement jamais lue.
           */
          acknowledgedByUser: { select: { id: true, name: true } },
        },
      }),
      prisma.alert.count({ where }),
    ]);

    return NextResponse.json({
      data: alerts,
      // `total` is kept at the top level for the sidebar's unread badge,
      // which reads `json.total` directly.
      total,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/alerts");
      // The filters were parsed inside the `try`, so `catch` cannot see them.
      // Re-reading the query string is safe: `parseEnumParam`/`parseBooleanParam`
      // already validated these values on the way in, or we would be handling a
      // 400 here rather than a connection failure.
      const { searchParams } = new URL(request.url);
      const { limit, skip } = parsePagination(searchParams, { maxLimit: 200 });
      return NextResponse.json(
        demoAlerts({
          elevatorId: searchParams.get("elevatorId"),
          severity: searchParams.get("severity"),
          acknowledged: parseBooleanParam(searchParams, "acknowledged") ?? null,
          resolved: parseBooleanParam(searchParams, "resolved") ?? null,
          limit,
          skip,
        })
      );
    }
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    // Les rôles de gestion seuls — voir la note en tête de fichier. Le
    // technicien garde la lecture : il n'est pas privé de l'information, il ne
    // signe simplement pas l'engagement au nom de l'entreprise.
    const session = await requireRole(...MANAGEMENT_ROLES);

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    const parsed = UpdateAlertSchema.parse(await readJson(request));

    if (id && parsed.ids) {
      throw badRequest(
        "Choisissez l'un ou l'autre : `?id=` dans l'adresse pour une alerte, " +
          "ou `ids` dans le corps pour plusieurs. Les deux à la fois ne disent pas quelle cible viser."
      );
    }

    const data: Record<string, unknown> = {};

    if (parsed.acknowledged !== undefined) {
      data.isAcknowledged = parsed.acknowledged;
      data.acknowledgedAt = parsed.acknowledged ? new Date() : null;
      // Record who acknowledged it. The column and the `acknowledgedByUser`
      // relation existed but were never populated, so there was no way to
      // answer "who signed off on this alert?".
      data.acknowledgedBy = parsed.acknowledged ? session.user.id : null;
    }

    if (parsed.resolved !== undefined) {
      data.resolvedAt = parsed.resolved ? new Date() : null;
    }

    // ── Une seule alerte ────────────────────────────────────
    if (id) {
      const existing = await prisma.alert.findUnique({
        where: { id },
        select: { id: true },
      });
      // Un identifiant inconnu est une 404 ici, et un simple « rien à faire »
      // en mode masse : voir la note sur `updateMany` ci-dessous.
      if (!existing) throw notFound(`Alerte introuvable : ${id}`);

      const alert = await prisma.alert.update({
        where: { id },
        data,
        include: {
          elevator: { select: { elevatorCode: true } },
          acknowledgedByUser: { select: { id: true, name: true } },
        },
      });

      return NextResponse.json({ data: alert, updated: 1 });
    }

    // ── Plusieurs alertes ───────────────────────────────────
    if (parsed.ids) {
      /**
       * `updateMany`, et le compte est rendu plutôt que supposé.
       *
       * Un identifiant qui n'existe plus — une alerte supprimée entre
       * l'affichage et le clic — est ignoré au lieu de faire échouer le lot
       * entier. C'est le bon comportement ici : la file était juste à l'écran,
       * et refuser les dix-neuf autres à cause d'une disparue serait une
       * punition pour une course. Le nombre réellement écrit est donc renvoyé,
       * et l'écran l'annonce — jamais « 20 alertes acquittées » quand dix-huit
       * l'ont été.
       */
      const result = await prisma.alert.updateMany({
        where: { id: { in: parsed.ids } },
        data,
      });

      return NextResponse.json({ data: null, updated: result.count });
    }

    throw badRequest(
      "Précisez la cible : `?id=` dans l'adresse pour une alerte, ou `ids` dans le corps pour plusieurs."
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
