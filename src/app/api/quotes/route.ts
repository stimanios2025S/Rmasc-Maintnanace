/**
 * Maintenance RMASC – les devis.
 *
 * GET   /api/quotes      – le registre, filtré selon qui demande
 * POST  /api/quotes      – ouvrir une demande de devis
 * PATCH /api/quotes      – chiffrer, et poser l'état
 *
 * POURQUOI CETTE ROUTE EXISTE
 * Le formulaire For: APP/DA/04/14 existe dans l'entreprise et n'existait nulle
 * part dans le produit. Un client qui voulait un devis pour un remplacement
 * d'organe lourd le demandait par téléphone ; le bureau le rédigeait à la main,
 * le numérotait dans un classeur, et rien ne permettait de savoir plus tard
 * quelles offres avaient été acceptées.
 *
 * LA SÉPARATION DES LECTURES
 * Un administrateur ou un responsable voit tous les devis ; un compte client ne
 * voit que les siens. Comme pour les factures, ce n'est pas un confort : un
 * devis porte un besoin décrit, une adresse et un prix. Une liste non filtrée
 * aurait envoyé à chaque client les projets de tous les autres.
 *
 * LES TECHNICIENS EN SONT EXCLUS
 * Un devis est une pièce commerciale : le relevé de ce que l'entreprise propose
 * et à quel prix. Un technicien de terrain n'a rien à y faire, et l'y laisser
 * ouvrirait la politique tarifaire à quiconque possède un compte de terrain.
 * C'est la règle déjà appliquée à `/api/invoices`.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  badRequest,
  forbidden,
  handleRouteError,
  jsonOk,
  notFound,
  parseEnumParam,
  parsePagination,
  readJson,
} from "@/lib/api/http";
import { MANAGEMENT_ROLES, buildingScopeFor, requireRole } from "@/lib/api/guard";
import { createQuote } from "@/lib/quotes/service";
import { computeQuoteTotals } from "@/lib/quotes/totals";
import { quoteTransitionRefusal } from "@/lib/quotes/status";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoQuotes, demoQuoteById } from "@/lib/demo/responses";
import { QUOTE_STATUSES } from "@/types";
import type { QuoteStatus } from "@/types";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

/**
 * Ce qu'une ligne du registre affiche.
 *
 * `lines` n'y est que pour ses quantités et ses prix unitaires : les montants
 * ne sont pas stockés, donc le registre doit pouvoir les recalculer. Rendre les
 * désignations dans une liste serait du poids pour rien — la fiche les montre.
 */
const LIST_SELECT = {
  id: true,
  number: true,
  status: true,
  createdAt: true,
  sentAt: true,
  decidedAt: true,
  validityDays: true,
  need: true,
  buildingId: true,
  elevatorId: true,
  clientId: true,
  client: { select: { id: true, name: true } },
  building: { select: { id: true, name: true, city: true } },
  elevator: { select: { id: true, elevatorCode: true } },
  lines: { select: { quantity: true, unitPrice: true } },
} satisfies Prisma.QuoteSelect;

type QuoteListRow = Prisma.QuoteGetPayload<{ select: typeof LIST_SELECT }>;

/**
 * Une ligne de registre, augmentée de ses totaux.
 *
 * Les totaux sont calculés ici plutôt qu'à l'écran, et c'est délibéré : le
 * registre affiche parfois vingt lignes, et vingt recalculs dans le navigateur
 * sur des `Decimal` reçus en chaînes finiraient par diverger de ce que le PDF
 * imprime. Un seul calcul, côté serveur, pour tout le monde.
 */
function withTotals(row: QuoteListRow) {
  const totals = computeQuoteTotals(
    row.lines.map((line) => ({
      quantity: Number(line.quantity.toString()),
      unitPrice: Number(line.unitPrice.toString()),
    }))
  );
  const { lines: _lines, ...rest } = row;
  return { ...rest, totals, lineCount: row.lines.length };
}

export async function GET(request: NextRequest) {
  try {
    const session = await requireRole(...MANAGEMENT_ROLES, "BUILDING_OWNER");
    const { searchParams } = request.nextUrl;
    const { page, limit, skip } = parsePagination(searchParams);

    const status = parseEnumParam(searchParams, "status", QUOTE_STATUSES);
    const id = searchParams.get("id") || undefined;
    const buildingId = searchParams.get("buildingId") || undefined;
    const clientId = searchParams.get("clientId") || undefined;

    const where: Prisma.QuoteWhereInput = {
      ...(id ? { id } : {}),
      ...(status ? { status } : {}),
      ...(buildingId ? { buildingId } : {}),
      ...(clientId ? { clientId } : {}),
      // Le périmètre client est posé en dernier et écrase : un client qui
      // ajoute `?clientId=<un autre>` obtient ses propres devis.
      ...(session.user.role === "BUILDING_OWNER"
        ? { clientId: session.user.id }
        : {}),
    };

    if (id) {
      const one = await prisma.quote.findFirst({
        where,
        select: {
          ...LIST_SELECT,
          notes: true,
          lines: {
            select: {
              id: true,
              position: true,
              reference: true,
              designation: true,
              quantity: true,
              unitPrice: true,
              unit: true,
            },
            orderBy: { position: "asc" },
          },
        },
      });
      if (!one) throw notFound(`Devis introuvable : ${id}`);
      return jsonOk(withTotals(one));
    }

    const [rows, total] = await Promise.all([
      prisma.quote.findMany({
        where,
        select: LIST_SELECT,
        // Le plus récent d'abord : un devis est une pièce datée, et c'est celui
        // qu'on vient d'ouvrir qu'on cherche.
        orderBy: { createdAt: "desc" },
        take: limit,
        skip,
      }),
      prisma.quote.count({ where }),
    ]);

    return NextResponse.json({
      data: rows.map(withTotals),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/quotes");
      const { searchParams } = request.nextUrl;
      const id = searchParams.get("id");
      if (id) {
        const one = demoQuoteById(id);
        return one
          ? NextResponse.json({ data: one })
          : handleRouteError(notFound(`Devis introuvable : ${id}`));
      }
      return NextResponse.json(
        demoQuotes({ status: searchParams.get("status") || undefined })
      );
    }
    return handleRouteError(error);
  }
}

const CreateQuoteSchema = z
  .object({
    buildingId: z.string().trim().min(1, "L'immeuble est obligatoire"),
    elevatorId: z.string().trim().min(1).optional(),
    /**
     * Le besoin, tel que le client le décrit.
     *
     * Longueur minimale de dix caractères : « devis » n'est pas une demande, et
     * une phrase de trois mots n'aide personne à chiffrer. Le plafond est celui
     * des autres textes libres du produit.
     */
    need: z
      .string()
      .trim()
      .min(10, "Décrivez le besoin en quelques mots")
      .max(4000),
    validityDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  try {
    const session = await requireRole(...MANAGEMENT_ROLES, "BUILDING_OWNER");
    const body = CreateQuoteSchema.parse(await readJson(request));

    /**
     * L'immeuble doit être dans le périmètre du demandeur.
     *
     * `buildingScopeFor` rend `{ isActive: true, ownerId: <le client> }` pour un
     * compte client et tout le parc actif pour un rôle de gestion. La lecture
     * qui suit échoue donc pour un client qui viserait l'immeuble d'un autre —
     * et c'est le seul contrôle dont cette route a besoin, puisqu'il porte à la
     * fois l'existence et le droit.
     */
    const building = await prisma.building.findFirst({
      where: { id: body.buildingId, ...buildingScopeFor(session) },
      select: { id: true },
    });
    if (!building) {
      throw notFound(`Immeuble introuvable : ${body.buildingId}`);
    }

    /**
     * L'appareil, s'il est précisé, doit appartenir à cet immeuble.
     *
     * Sans cette vérification, une demande pourrait désigner une machine d'un
     * autre site : le devis serait rattaché à un immeuble et viserait un
     * appareil d'ailleurs, ce qui n'a aucun sens et ne se verrait qu'à la visite.
     */
    if (body.elevatorId) {
      const unit = await prisma.elevator.findFirst({
        where: { id: body.elevatorId, buildingId: building.id },
        select: { id: true },
      });
      if (!unit) {
        throw badRequest(
          "L'appareil indiqué n'appartient pas à cet immeuble."
        );
      }
    }

    /**
     * Le demandeur enregistré est le compte qui appelle, jamais un champ du
     * corps. Un client ne signe pas une demande au nom d'un autre, et le bureau
     * qui saisit pour un client se nomme lui-même — c'est la vérité de qui est
     * au clavier.
     */
    const created = await createQuote({
      clientId:
        session.user.role === "BUILDING_OWNER"
          ? session.user.id
          : (session.user.id ?? null),
      requestedById: session.user.id ?? null,
      buildingId: building.id,
      elevatorId: body.elevatorId ?? null,
      need: body.need,
      validityDays: body.validityDays,
    });

    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Une ligne de devis, telle que le bureau la saisit.
 *
 * Les montants sont facultatifs à la lecture — une ligne à moitié tapée doit
 * pouvoir être enregistrée — mais une quantité négative est refusée : un devis
 * se corrige par une ligne, pas par un montant en dessous de zéro.
 */
const LineSchema = z
  .object({
    reference: z.string().trim().max(100).optional(),
    designation: z.string().trim().min(1).max(300),
    quantity: z.number().finite().nonnegative(),
    unit: z.string().trim().max(20).optional(),
    unitPrice: z.number().finite().nonnegative(),
  })
  .strict();

const PatchQuoteSchema = z
  .object({
    id: z.string().trim().min(1, "Le devis est obligatoire"),
    /** Les lignes de remplacement, dans l'ordre. Absent = on n'y touche pas. */
    lines: z.array(LineSchema).max(50).optional(),
    notes: z.string().trim().max(4000).optional(),
    status: z.enum(QUOTE_STATUSES).optional(),
  })
  .strict();

/**
 * Chiffre un devis, et pose son état.
 *
 * LES DEUX DANS UNE SEULE REQUÊTE, ET C'EST DÉLIBÉRÉ
 * Le geste du bureau est « je saisis mes lignes et je remets l'offre ». Deux
 * requêtes laisseraient un état intermédiaire où les lignes sont écrites et
 * l'offre non remise — c'est-à-dire exactement ce que la règle refuse, un devis
 * chiffré que personne n'a envoyé et que rien ne distingue d'un brouillon.
 *
 * L'ordre compte : les lignes sont posées **avant** que la transition ne soit
 * jugée, sinon `SENT` serait évalué sur les anciennes lignes et refuserait un
 * devis que le bureau vient de remplir.
 */
export async function PATCH(request: NextRequest) {
  try {
    const session = await requireRole(...MANAGEMENT_ROLES);
    const parsed = PatchQuoteSchema.parse(await readJson(request));

    const existing = await prisma.quote.findUnique({
      where: { id: parsed.id },
      select: {
        id: true,
        number: true,
        status: true,
        lines: { select: { designation: true, quantity: true, unitPrice: true } },
      },
    });
    if (!existing) throw notFound(`Devis introuvable : ${parsed.id}`);

    /**
     * On ne corrige pas une offre remise.
     *
     * Le client a un papier entre les mains. Modifier les lignes en base
     * rendrait ce papier faux sans que personne ne le sache — et c'est
     * précisément ce qu'un devis ne peut pas permettre. Pour reprendre une offre
     * envoyée, on la refuse puis on rouvre la demande.
     */
    if (parsed.lines !== undefined && existing.status !== "REQUESTED") {
      throw forbidden(
        `Le devis ${existing.number} a été remis au client : ses lignes ne se ` +
          "modifient plus. Refusez-le, puis rouvrez la demande pour le reprendre."
      );
    }

    if (parsed.lines !== undefined) {
      await prisma.$transaction([
        prisma.quoteLine.deleteMany({ where: { quoteId: existing.id } }),
        prisma.quoteLine.createMany({
          data: parsed.lines.map((line, index) => ({
            quoteId: existing.id,
            position: index + 1,
            reference: line.reference,
            designation: line.designation,
            quantity: line.quantity,
            unit: line.unit,
            unitPrice: line.unitPrice,
          })),
        }),
      ]);
    }

    const linesAfter =
      parsed.lines !== undefined
        ? parsed.lines
        : existing.lines.map((line) => ({
            designation: line.designation,
            quantity: Number(line.quantity.toString()),
            unitPrice: Number(line.unitPrice.toString()),
          }));

    const now = new Date();
    let nextStatus: QuoteStatus = existing.status;

    if (parsed.status !== undefined && parsed.status !== existing.status) {
      const refusal = quoteTransitionRefusal(
        existing.status,
        parsed.status,
        linesAfter
      );
      if (refusal) throw badRequest(refusal);
      nextStatus = parsed.status;
    }

    const updated = await prisma.quote.update({
      where: { id: existing.id },
      data: {
        ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
        status: nextStatus,
        /**
         * Les horodatages sont posés au moment où l'état est atteint, et pas
         * réécrits ensuite : `sentAt` ne bouge pas quand le client répond, sans
         * quoi la durée de validité de trente jours se remettrait à courir à
         * chaque décision.
         */
        ...(nextStatus === "SENT" && existing.status !== "SENT"
          ? { sentAt: now, pricedAt: now }
          : {}),
        ...(nextStatus === "ACCEPTED" || nextStatus === "REFUSED"
          ? { decidedAt: now, decidedById: session.user.id ?? null }
          : {}),
        ...(nextStatus === "REQUESTED" ? { sentAt: null, decidedAt: null } : {}),
      },
      select: {
        ...LIST_SELECT,
        notes: true,
        lines: {
          select: {
            id: true,
            position: true,
            reference: true,
            designation: true,
            quantity: true,
            unitPrice: true,
            unit: true,
          },
          orderBy: { position: "asc" },
        },
      },
    });

    return jsonOk(withTotals(updated));
  } catch (error) {
    return handleRouteError(error);
  }
}
