/**
 * Maintenance RMASC – un contrat, sa fiche et ses transitions.
 *
 * GET   /api/contracts/[id]  – la fiche complète, historique compris
 * PATCH /api/contracts/[id]  – modifier, renouveler, suspendre, résilier
 *
 * LA RÈGLE N'EST PAS ÉCRITE ICI
 * `transitionRefusal` décide de ce qui est permis, et l'écran appelle la même
 * fonction pour décider quels boutons offrir. Une règle écrite deux fois finit
 * par diverger, et le bouton qui échoue est ce que l'utilisateur voit de la
 * divergence.
 *
 * CHAQUE CHANGEMENT ÉCRIT UNE RÉVISION
 * Une mise à jour qui ne laisserait pas de trace rendrait l'historique muet au
 * moment précis où on le consulte : « qui a changé le palier, et quand ? ». Le
 * journal est écrit dans la même transaction que le changement — un journal qui
 * peut manquer une écriture réussie ne sert à rien.
 *
 * LES DATES SE CORRIGENT, LES RENOUVELLEMENTS SE VÉRIFIENT
 * Déplacer une date de fin vers le passé est légitime quand c'est une
 * correction. Ce ne l'est pas quand c'est un renouvellement : un renouvellement
 * vers le passé créerait une période déjà échue, que la reconduction tacite
 * repousserait indéfiniment sans qu'aucune date ne progresse. La distinction est
 * faite ci-dessous.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import {
  badRequest,
  handleRouteError,
  notFound,
  readJson,
} from "@/lib/api/http";
import { MANAGEMENT_ROLES, requireRole } from "@/lib/api/guard";
import {
  datesRefusal,
  effectiveEndsAt,
  effectiveStatus,
  expiryAlert,
  renewalRefusal,
  revisionSummary,
  terminationRefusal,
  transitionRefusal,
} from "@/lib/contracts/status";
import {
  BILLING_CYCLES,
  CONTRACT_RENEWAL_MODES,
  CONTRACT_STATUSES,
  SLA_TIERS,
} from "@/types";
import type {
  ContractRenewalMode,
  ContractRevisionKind,
  ContractStatus,
} from "@/types";
import type { RevisionValue } from "@/lib/contracts/status";

export const dynamic = "force-dynamic";

// ─── Schéma de mise à jour ──────────────────────────────────

const UpdateContractSchema = z
  .object({
    status: z.enum(CONTRACT_STATUSES).optional(),
    slaTier: z.enum(SLA_TIERS).optional(),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
    renewalMode: z.enum(CONTRACT_RENEWAL_MODES).optional(),
    noticeDays: z.number().int().min(0).max(3650).optional(),
    billingCycle: z.enum(BILLING_CYCLES).optional(),
    amount: z.number().nonnegative().optional(),
    currency: z.string().trim().length(3).optional(),
    responseHours: z.number().int().positive().optional(),
    interventionHours: z.number().int().positive().optional(),
    buildingIds: z
      .array(z.string().trim().min(1))
      .min(1, "Un contrat couvre au moins un immeuble")
      .optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    /** Obligatoire avec `status: "TERMINATED"`, refusé sans lui. */
    terminationReason: z.string().trim().max(500).optional(),
  })
  .strict();

// ─── Projections ────────────────────────────────────────────

const CONTRACT_DETAIL_SELECT = {
  id: true,
  reference: true,
  year: true,
  sequence: true,
  status: true,
  slaTier: true,
  startsAt: true,
  endsAt: true,
  signedAt: true,
  renewalMode: true,
  noticeDays: true,
  billingCycle: true,
  amount: true,
  currency: true,
  responseHours: true,
  interventionHours: true,
  terminatedAt: true,
  terminationReason: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  client: { select: { id: true, name: true, email: true, phone: true } },
  terminatedBy: { select: { id: true, name: true } },
  buildings: {
    select: { building: { select: { id: true, name: true, city: true } } },
  },
  revisions: {
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      kind: true,
      summary: true,
      before: true,
      after: true,
      createdAt: true,
      changedBy: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.ContractSelect;

type ContractDetailRow = Prisma.ContractGetPayload<{
  select: typeof CONTRACT_DETAIL_SELECT;
}>;

function decorateDetail(row: ContractDetailRow, now: Date) {
  const dated = {
    status: row.status as ContractStatus,
    renewalMode: row.renewalMode as ContractRenewalMode,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
  };

  return {
    ...row,
    amount: row.amount.toString(),
    effectiveStatus: effectiveStatus(dated, now),
    effectiveEndsAt: effectiveEndsAt(dated, now),
    expiry: expiryAlert(dated, now),
    buildings: row.buildings.map((link) => link.building),
  };
}

// ─── GET ────────────────────────────────────────────────────

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireRole(...MANAGEMENT_ROLES);

    const row = await prisma.contract.findUnique({
      where: { id: params.id },
      select: CONTRACT_DETAIL_SELECT,
    });
    if (!row) throw notFound(`Contrat introuvable : ${params.id}`);

    return NextResponse.json({ data: decorateDetail(row, new Date()) });
  } catch (error) {
    return handleRouteError(error);
  }
}

// ─── PATCH ──────────────────────────────────────────────────

interface PendingRevision {
  kind: ContractRevisionKind;
  summary: string;
  before: Record<string, RevisionValue>;
  after: Record<string, RevisionValue>;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireRole(...MANAGEMENT_ROLES);
    const body = UpdateContractSchema.parse(await readJson(request));
    const now = new Date();

    const existing = await prisma.contract.findUnique({
      where: { id: params.id },
      select: {
        id: true,
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
        terminationReason: true,
        buildings: { select: { buildingId: true } },
      },
    });
    if (!existing) throw notFound(`Contrat introuvable : ${params.id}`);

    /**
     * `Unchecked` : la mise à jour écrit la clé étrangère `terminatedById`
     * directement. La variante vérifiée n'expose que la relation
     * `terminatedBy: { connect: … }`, ce qui obligerait à distinguer le cas
     * « connecté » du cas « nul » pour une colonne qui accepte les deux.
     */
    const data: Prisma.ContractUncheckedUpdateInput = {};
    const revisions: PendingRevision[] = [];

    // ─── 1. La transition d'état ────────────────────────────
    const targetStatus = body.status;
    const statusChanged =
      targetStatus !== undefined && targetStatus !== existing.status;

    if (targetStatus !== undefined) {
      const refusal = transitionRefusal(
        existing.status as ContractStatus,
        targetStatus
      );
      if (refusal) throw badRequest(refusal);
    }

    /**
     * Un renouvellement est une activation depuis un état échu. Il doit fournir
     * une nouvelle date de fin, et cette date doit avancer.
     */
    const isRenewal =
      targetStatus === "ACTIVE" &&
      (existing.status === "EXPIRED" ||
        effectiveStatus(
          {
            status: existing.status as ContractStatus,
            renewalMode: existing.renewalMode as ContractRenewalMode,
            startsAt: existing.startsAt,
            endsAt: existing.endsAt,
          },
          now
        ) === "EXPIRED");

    if (isRenewal) {
      if (!body.endsAt) {
        throw badRequest(
          "Un renouvellement doit fournir une nouvelle date de fin."
        );
      }
      const renewalRefusalMessage = renewalRefusal({
        currentEndsAt: existing.endsAt,
        newEndsAt: body.endsAt,
      });
      if (renewalRefusalMessage) throw badRequest(renewalRefusalMessage);
    }

    if (targetStatus === "TERMINATED" && existing.status !== "TERMINATED") {
      const refusal = terminationRefusal({
        status: existing.status as ContractStatus,
        reason: body.terminationReason,
      });
      if (refusal) throw badRequest(refusal);

      data.terminatedAt = now;
      data.terminatedById = session.user.id ?? null;
      data.terminationReason = body.terminationReason!.trim();
    }

    /** La signature date l'entrée en vigueur, et ne se rejoue pas. */
    if (targetStatus === "ACTIVE" && existing.status === "DRAFT") {
      data.signedAt = now;
    }

    if (statusChanged) {
      data.status = targetStatus;
      revisions.push({
        kind: "STATUS_CHANGED",
        summary: revisionSummary(
          "STATUS_CHANGED",
          { status: existing.status },
          { status: targetStatus }
        ),
        before: { status: existing.status },
        after: { status: targetStatus },
      });
    }

    // ─── 2. Les dates ───────────────────────────────────────
    const startsAt = body.startsAt ?? existing.startsAt;
    const endsAt = body.endsAt ?? existing.endsAt;
    const noticeDays = body.noticeDays ?? existing.noticeDays;

    if (
      body.startsAt !== undefined ||
      body.endsAt !== undefined ||
      body.noticeDays !== undefined
    ) {
      const refusal = datesRefusal({ startsAt, endsAt, noticeDays });
      if (refusal) throw badRequest(refusal);

      data.startsAt = startsAt;
      data.endsAt = endsAt;
      data.noticeDays = noticeDays;

      revisions.push({
        kind: "DATES_CHANGED",
        summary: revisionSummary(
          "DATES_CHANGED",
          {
            startsAt: existing.startsAt,
            endsAt: existing.endsAt,
            noticeDays: existing.noticeDays,
          },
          { startsAt, endsAt, noticeDays }
        ),
        before: {
          startsAt: existing.startsAt,
          endsAt: existing.endsAt,
          noticeDays: existing.noticeDays,
        },
        after: { startsAt, endsAt, noticeDays },
      });
    }

    // ─── 3. Le palier ───────────────────────────────────────
    if (body.slaTier !== undefined && body.slaTier !== existing.slaTier) {
      data.slaTier = body.slaTier;
      revisions.push({
        kind: "TIER_CHANGED",
        summary: revisionSummary(
          "TIER_CHANGED",
          { slaTier: existing.slaTier },
          { slaTier: body.slaTier }
        ),
        before: { slaTier: existing.slaTier },
        after: { slaTier: body.slaTier },
      });
    }

    // ─── 4. Le renouvellement ───────────────────────────────
    if (
      (body.renewalMode !== undefined &&
        body.renewalMode !== existing.renewalMode) ||
      (body.noticeDays !== undefined &&
        body.noticeDays !== existing.noticeDays)
    ) {
      // `noticeDays` est déjà journalisé avec les dates quand il change seul
      // avec elles ; ici on ne capture que le changement de mode, pour ne pas
      // écrire deux lignes pour le même préavis.
      if (
        body.renewalMode !== undefined &&
        body.renewalMode !== existing.renewalMode
      ) {
        data.renewalMode = body.renewalMode;
        revisions.push({
          kind: "RENEWAL_CHANGED",
          summary: revisionSummary(
            "RENEWAL_CHANGED",
            { renewalMode: existing.renewalMode },
            { renewalMode: body.renewalMode }
          ),
          before: { renewalMode: existing.renewalMode },
          after: { renewalMode: body.renewalMode },
        });
      }
    }

    // ─── 5. Les délais promis ───────────────────────────────
    if (
      (body.responseHours !== undefined &&
        body.responseHours !== existing.responseHours) ||
      (body.interventionHours !== undefined &&
        body.interventionHours !== existing.interventionHours)
    ) {
      const responseHours = body.responseHours ?? existing.responseHours;
      const interventionHours =
        body.interventionHours ?? existing.interventionHours;

      if (responseHours > interventionHours) {
        throw badRequest(
          "La prise en charge ne peut pas être plus longue que l'intervention."
        );
      }

      data.responseHours = responseHours;
      data.interventionHours = interventionHours;

      revisions.push({
        kind: "COMMITMENT_CHANGED",
        summary: revisionSummary(
          "COMMITMENT_CHANGED",
          {
            responseHours: existing.responseHours,
            interventionHours: existing.interventionHours,
          },
          { responseHours, interventionHours }
        ),
        before: {
          responseHours: existing.responseHours,
          interventionHours: existing.interventionHours,
        },
        after: { responseHours, interventionHours },
      });
    }

    // ─── 6. Facturation et notes ────────────────────────────
    if (body.billingCycle !== undefined) data.billingCycle = body.billingCycle;
    if (body.amount !== undefined) {
      data.amount = new Prisma.Decimal(body.amount);
    }
    if (body.currency !== undefined) data.currency = body.currency.toUpperCase();
    if (body.notes !== undefined) data.notes = body.notes;

    // ─── 7. Les immeubles ───────────────────────────────────
    let buildingIds: string[] | null = null;

    if (body.buildingIds !== undefined) {
      buildingIds = [...new Set(body.buildingIds)];

      if (isRenewal) {
        throw badRequest(
          "Un renouvellement ne modifie pas les immeubles couverts. " +
            "Modifiez-les séparément, après le renouvellement."
        );
      }

      const buildings = await prisma.building.findMany({
        where: { id: { in: buildingIds } },
        select: { id: true, name: true, ownerId: true, owner: { select: { id: true } } },
      });

      if (buildings.length !== buildingIds.length) {
        const found = new Set(buildings.map((b) => b.id));
        throw badRequest(
          `Immeuble(s) introuvable(s) : ${buildingIds
            .filter((id) => !found.has(id))
            .join(", ")}`
        );
      }

      const contractClient = await prisma.contract.findUnique({
        where: { id: params.id },
        select: { clientId: true },
      });
      const foreign = buildings.filter(
        (b) => b.ownerId !== contractClient?.clientId
      );
      if (foreign.length > 0) {
        throw badRequest(
          `Ces immeubles n'appartiennent pas au titulaire du contrat : ` +
            foreign.map((b) => b.name).join(", ")
        );
      }

      const conflict = await prisma.contract.findFirst({
        where: {
          id: { not: params.id },
          status: "ACTIVE",
          OR: [{ renewalMode: "AUTO" }, { endsAt: { gt: now } }],
          buildings: { some: { buildingId: { in: buildingIds } } },
        },
        select: { reference: true },
      });
      if (conflict) {
        throw badRequest(
          `Ces immeubles sont déjà couverts par le contrat ${conflict.reference}.`
        );
      }

      const before = existing.buildings.map((b) => b.buildingId).sort();
      const after = [...buildingIds].sort();

      if (before.join("|") !== after.join("|")) {
        revisions.push({
          kind: "BUILDINGS_CHANGED",
          summary: revisionSummary(
            "BUILDINGS_CHANGED",
            { buildings: before.length },
            { buildings: after.length }
          ),
          before: { buildings: before.length },
          after: { buildings: after.length },
        });
      } else {
        buildingIds = null;
      }
    }

    // ─── 8. Écriture, et journal, dans une seule transaction ─
    const updated = await prisma.$transaction(async (tx) => {
      if (buildingIds) {
        await tx.contractBuilding.deleteMany({
          where: { contractId: params.id },
        });
        await tx.contractBuilding.createMany({
          data: buildingIds.map((buildingId) => ({
            contractId: params.id,
            buildingId,
          })),
        });
      }

      if (Object.keys(data).length > 0) {
        await tx.contract.update({ where: { id: params.id }, data });
      }

      if (revisions.length > 0) {
        await tx.contractRevision.createMany({
          data: revisions.map((revision) => ({
            contractId: params.id,
            kind: revision.kind,
            summary: revision.summary,
            before: revision.before as Prisma.InputJsonValue,
            after: revision.after as Prisma.InputJsonValue,
            changedById: session.user.id ?? null,
          })),
        });
      }

      return tx.contract.findUnique({
        where: { id: params.id },
        select: CONTRACT_DETAIL_SELECT,
      });
    });

    if (!updated) throw notFound(`Contrat introuvable : ${params.id}`);

    return NextResponse.json({ data: decorateDetail(updated, new Date()) });
  } catch (error) {
    return handleRouteError(error);
  }
}
