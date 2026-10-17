/**
 * Maintenance RMASC – les contrats de maintenance.
 *
 * GET  /api/contracts   – le registre, filtrable
 * POST /api/contracts   – créer un contrat en brouillon
 *
 * POURQUOI LES CONTRATS SONT RÉSERVÉS AUX RÔLES DE GESTION
 * Un contrat est un engagement financier et une promesse de délai. Il ne
 * s'ouvre pas depuis le terrain, et il ne se lit pas depuis un portail client
 * tant que la livraison 5 ne l'a pas prévu. La route demande donc
 * `MANAGEMENT_ROLES`, comme les factures et les devis.
 *
 * POURQUOI LA CRÉATION DONNE UN BROUILLON
 * Une création n'est pas une signature. `DRAFT` est le seul état qu'un POST
 * produise, et l'activation passe par `PATCH` — c'est la même séparation que
 * pour un devis demandé mais pas envoyé. Un contrat créé directement `ACTIVE`
 * couvrirait des immeubles avant que quiconque ait relu les dates.
 *
 * L'ÉTAT EFFECTIF EST CALCULÉ, PAS STOCKÉ
 * Une ligne peut porter `ACTIVE` alors que sa date de fin est passée : la
 * reconduction tacite se calcule (`effectiveEndsAt`), et l'échéance aussi. La
 * route renvoie donc `effectiveStatus` et une alerte d'échéance, pour que le
 * registre n'ait pas à refaire le calcul — et surtout pour qu'il ne le refasse
 * pas autrement.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import {
  badRequest,
  handleRouteError,
  jsonOk,
  notFound,
  parseEnumParam,
  readJson,
} from "@/lib/api/http";
import { MANAGEMENT_ROLES, requireRole } from "@/lib/api/guard";
import {
  SLA_COMMITMENTS,
  datesRefusal,
  effectiveEndsAt,
  effectiveStatus,
  expiryAlert,
  revisionSummary,
} from "@/lib/contracts/status";
import {
  BILLING_CYCLES,
  CONTRACT_RENEWAL_MODES,
  CONTRACT_STATUSES,
  SLA_TIERS,
} from "@/types";
import type { ContractRenewalMode, ContractStatus, SLATier } from "@/types";

export const dynamic = "force-dynamic";

// ─── Numérotation ───────────────────────────────────────────

/**
 * `CT-2026-0001`.
 *
 * Séquence et non suffixe aléatoire, contrairement aux bons et aux demandes de
 * pièce : un contrat se conclut au bureau, une fois, et son numéro est cité dans
 * les courriers et les factures. Une séquence est ce qu'un classeur attend.
 */
function formatContractReference(year: number, sequence: number): string {
  return `CT-${year}-${String(sequence).padStart(4, "0")}`;
}

// ─── Schémas ────────────────────────────────────────────────

const CreateContractSchema = z
  .object({
    clientId: z.string().trim().min(1, "Le client est obligatoire"),
    slaTier: z.enum(SLA_TIERS),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    renewalMode: z.enum(CONTRACT_RENEWAL_MODES).default("AUTO"),
    noticeDays: z.number().int().min(0).max(3650).default(60),
    billingCycle: z.enum(BILLING_CYCLES).default("ANNUALLY"),
    amount: z.number().nonnegative("Le montant ne peut pas être négatif"),
    currency: z.string().trim().length(3).default("DZD"),
    /**
     * Les délais promis. Facultatifs : quand ils sont omis, le barème du palier
     * les fournit. Les fournir, c'est écrire une clause négociée.
     */
    responseHours: z.number().int().positive().optional(),
    interventionHours: z.number().int().positive().optional(),
    /** Les immeubles couverts — un sous-ensemble du parc du client. */
    buildingIds: z
      .array(z.string().trim().min(1))
      .min(1, "Un contrat couvre au moins un immeuble"),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

// ─── Projections ────────────────────────────────────────────

const CONTRACT_LIST_SELECT = {
  id: true,
  reference: true,
  status: true,
  slaTier: true,
  startsAt: true,
  endsAt: true,
  renewalMode: true,
  noticeDays: true,
  billingCycle: true,
  amount: true,
  currency: true,
  responseHours: true,
  interventionHours: true,
  createdAt: true,
  client: { select: { id: true, name: true, email: true } },
  buildings: {
    select: {
      building: { select: { id: true, name: true, city: true } },
    },
  },
} satisfies Prisma.ContractSelect;

type ContractListRow = Prisma.ContractGetPayload<{
  select: typeof CONTRACT_LIST_SELECT;
}>;

/**
 * Ce qu'un registre ajoute à une ligne, et qui n'est pas en base.
 *
 * `effectiveStatus` et l'alerte sont calculés ici une fois. Les laisser au
 * client, c'est accepter que deux écrans les calculent différemment — le défaut
 * que la règle pure existe pour éviter.
 */
function decorate(row: ContractListRow, now: Date) {
  const dated = {
    status: row.status as ContractStatus,
    renewalMode: row.renewalMode as ContractRenewalMode,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
  };

  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    effectiveStatus: effectiveStatus(dated, now),
    slaTier: row.slaTier,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    effectiveEndsAt: effectiveEndsAt(dated, now),
    renewalMode: row.renewalMode,
    noticeDays: row.noticeDays,
    billingCycle: row.billingCycle,
    amount: row.amount.toString(),
    currency: row.currency,
    responseHours: row.responseHours,
    interventionHours: row.interventionHours,
    createdAt: row.createdAt,
    client: row.client,
    buildings: row.buildings.map((link) => link.building),
    expiry: expiryAlert(dated, now),
  };
}

export async function GET(request: NextRequest) {
  try {
    await requireRole(...MANAGEMENT_ROLES);

    const { searchParams } = request.nextUrl;
    const status = parseEnumParam(searchParams, "status", CONTRACT_STATUSES);
    const slaTier = parseEnumParam(searchParams, "slaTier", SLA_TIERS);
    const clientId = searchParams.get("clientId") || undefined;
    const buildingId = searchParams.get("buildingId") || undefined;

    const where: Prisma.ContractWhereInput = {
      ...(status ? { status } : {}),
      ...(slaTier ? { slaTier } : {}),
      ...(clientId ? { clientId } : {}),
      ...(buildingId ? { buildings: { some: { buildingId } } } : {}),
    };

    const rows = await prisma.contract.findMany({
      where,
      select: CONTRACT_LIST_SELECT,
      /**
       * Les contrats en vigueur d'abord, puis par échéance : c'est la question
       * que pose un registre — « qu'est-ce qui est vivant, et qu'est-ce qui
       * arrive à terme ? ». Trier par date de création mettrait en tête les
       * brouillons les plus récents, qui sont précisément ce qu'on ne cherche
       * pas en ouvrant l'écran.
       */
      orderBy: [{ status: "asc" }, { endsAt: "asc" }],
    });

    const now = new Date();
    return NextResponse.json({
      data: rows.map((row) => decorate(row, now)),
      total: rows.length,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Vérifie qu'aucun autre contrat actif ne couvre déjà ces immeubles.
 *
 * CE N'EST PAS UNE GARANTIE, C'EST UN CONTRÔLE
 * PostgreSQL ne peut pas exprimer « au plus un contrat actif par immeuble » sans
 * un index partiel, et Prisma ne sait pas le déclarer. Deux activations
 * concurrentes peuvent donc passer toutes les deux. Le contrôle attrape le cas
 * réel — un bureau qui réactive l'ancien contrat avant de résilier le nouveau —
 * et le dit clairement ; il ne remplace pas une contrainte de base.
 *
 * LES CONTRATS ÉCHUS PAR LA DATE NE BLOQUENT PAS
 * Une ligne encore marquée `ACTIVE` dont la date est passée et qui n'est pas
 * reconduite tacitement n'est plus en vigueur : la traiter comme un conflit
 * empêcherait de reprendre un site que personne ne couvre plus.
 */
async function activeContractConflict(
  buildingIds: string[],
  excludeContractId?: string
) {
  if (buildingIds.length === 0) return null;

  const now = new Date();
  return prisma.contract.findFirst({
    where: {
      status: "ACTIVE",
      ...(excludeContractId ? { id: { not: excludeContractId } } : {}),
      OR: [{ renewalMode: "AUTO" }, { endsAt: { gt: now } }],
      buildings: { some: { buildingId: { in: buildingIds } } },
    },
    select: {
      reference: true,
      buildings: {
        where: { buildingId: { in: buildingIds } },
        select: { building: { select: { name: true } } },
      },
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireRole(...MANAGEMENT_ROLES);
    const body = CreateContractSchema.parse(await readJson(request));

    // ─── Cohérence des dates ────────────────────────────────
    const dateRefusal = datesRefusal({
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      noticeDays: body.noticeDays,
    });
    if (dateRefusal) throw badRequest(dateRefusal);

    // ─── Le titulaire ───────────────────────────────────────
    const client = await prisma.user.findUnique({
      where: { id: body.clientId },
      select: { id: true, name: true, role: true },
    });
    if (!client) throw notFound(`Client introuvable : ${body.clientId}`);
    if (client.role !== "BUILDING_OWNER") {
      throw badRequest(
        "Un contrat se conclut avec un compte client, pas avec un compte du personnel."
      );
    }

    // ─── Les immeubles couverts ─────────────────────────────
    //
    // Deux contrôles, et le second compte autant que le premier : un immeuble
    // qui existe mais appartient à un autre client serait couvert par un
    // contrat qui ne le concerne pas — et l'écran du mauvais client
    // l'afficherait.
    const buildingIds = [...new Set(body.buildingIds)];
    const buildings = await prisma.building.findMany({
      where: { id: { in: buildingIds } },
      select: { id: true, name: true, ownerId: true },
    });

    if (buildings.length !== buildingIds.length) {
      const found = new Set(buildings.map((b) => b.id));
      const missing = buildingIds.filter((id) => !found.has(id));
      throw badRequest(`Immeuble(s) introuvable(s) : ${missing.join(", ")}`);
    }

    const foreign = buildings.filter((b) => b.ownerId !== client.id);
    if (foreign.length > 0) {
      throw badRequest(
        `Ces immeubles n'appartiennent pas à ${client.name} : ` +
          foreign.map((b) => b.name).join(", ")
      );
    }

    const conflict = await activeContractConflict(buildingIds);
    if (conflict) {
      throw badRequest(
        `Ces immeubles sont déjà couverts par le contrat ${conflict.reference} : ` +
          conflict.buildings.map((b) => b.building.name).join(", ")
      );
    }

    // ─── Les délais promis ──────────────────────────────────
    //
    // Le barème du palier fournit les valeurs par défaut ; une valeur fournie
    // l'emporte, parce qu'un contrat négocié peut promettre mieux.
    const commitment = SLA_COMMITMENTS[body.slaTier as SLATier];
    const responseHours = body.responseHours ?? commitment.responseHours;
    const interventionHours =
      body.interventionHours ?? commitment.interventionHours;

    // ─── Écriture ───────────────────────────────────────────
    const year = new Date().getFullYear();

    /**
     * Trois tentatives sur collision de numéro, comme les factures : c'est un
     * événement de concurrence, pas une panne, et une quatrième tentative
     * masquerait un vrai refus d'écriture derrière ce qui ressemblerait à de la
     * malchance.
     */
    for (let attempt = 0; attempt < 3; attempt++) {
      const last = await prisma.contract.findFirst({
        where: { year },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      const sequence = (last?.sequence ?? 0) + 1;
      const reference = formatContractReference(year, sequence);

      try {
        const created = await prisma.contract.create({
          data: {
            reference,
            year,
            sequence,
            clientId: client.id,
            slaTier: body.slaTier,
            status: "DRAFT",
            startsAt: body.startsAt,
            endsAt: body.endsAt,
            renewalMode: body.renewalMode,
            noticeDays: body.noticeDays,
            billingCycle: body.billingCycle,
            amount: new Prisma.Decimal(body.amount),
            currency: body.currency.toUpperCase(),
            responseHours,
            interventionHours,
            notes: body.notes ?? null,
            buildings: {
              create: buildingIds.map((buildingId) => ({ buildingId })),
            },
            revisions: {
              create: {
                kind: "CREATED",
                summary: revisionSummary("CREATED", {}, {}),
                changedById: session.user.id ?? null,
              },
            },
          },
          select: CONTRACT_LIST_SELECT,
        });

        return NextResponse.json(
          { data: decorate(created, new Date()) },
          { status: 201 }
        );
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "P2002" || attempt === 2) throw error;
        console.warn("[contracts] collision de référence, nouvelle tentative");
      }
    }

    // Inatteignable : la boucle renvoie ou relance.
    throw badRequest("Le contrat n'a pas pu être enregistré.");
  } catch (error) {
    return handleRouteError(error);
  }
}
