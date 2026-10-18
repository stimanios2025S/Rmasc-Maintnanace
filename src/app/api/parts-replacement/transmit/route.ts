/**
 * Maintenance RMASC – la transmission des demandes au magasin central.
 *
 * POST /api/parts-replacement/transmit
 *
 * CE QUE CETTE ROUTE AJOUTE
 * Une demande de pièce naissait dans notre application et s'y terminait : le
 * bureau validait, commandait, et marquait posée. Le magasin central, lui, est
 * la seconde application — celle qui tient le stock, les bons de sortie et les
 * fournisseurs. Jusqu'ici, le besoin y arrivait par téléphone, c'est-à-dire pas.
 *
 * Cette route est le seul point de passage entre les deux.
 *
 * ELLE NE SE CONTENTE PAS D'ENVOYER : ELLE ENREGISTRE L'ENVOI
 * Un envoi peut échouer — le magasin central redémarre, le réseau tombe. Le
 * résultat est donc écrit sur la demande dans les deux cas : la référence quand
 * cela réussit, le refus quand cela échoue. Une transmission qui ne laisserait
 * pas de trace ferait recommander la pièce, ou l'oublier complètement.
 *
 * UNE TRANSMISSION RÉUSSIE FAIT AVANCER LA DEMANDE
 * Le magasin central est celui qui passe la commande. Le passage à `ORDERED`
 * appartient donc à cette route, et pas à un clic séparé : sinon les deux
 * applications diraient des choses différentes de la même pièce.
 *
 * ELLE REFUSE D'ÊTRE LE CHEMIN DE DÉMONSTRATION
 * Une écriture vers une autre application est un effet réel. Servir une fixture
 * à sa place ferait croire à une transmission qui n'a pas eu lieu, et le
 * magasinier attendrait une pièce que personne n'a commandée. Sans configuration
 * réelle, la route le dit et n'envoie rien.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import {
  badRequest,
  handleRouteError,
  jsonOk,
  notFound,
  readJson,
} from "@/lib/api/http";
import {
  MANAGEMENT_ROLES,
  buildingScopeFor,
  requireRole,
} from "@/lib/api/guard";
import {
  STATUS_AFTER_TRANSMISSION,
  transmissionRefusal,
} from "@/lib/stock/eligibility";
import {
  buildStockDemande,
  stockConfigRefusal,
  transmitDemande,
} from "@/lib/stock/client";
import { transitionRefusal } from "@/lib/parts/status";

export const dynamic = "force-dynamic";

/**
 * `node:crypto` entre dans ce chemin par `lib/stock/client.ts`. Le runtime Node
 * est donc déclaré explicitement plutôt que laissé au défaut : une route qui
 * dépend de `node:` et qui se retrouve sur le runtime edge échoue à l'exécution,
 * pas à la construction.
 */
export const runtime = "nodejs";

/**
 * Une borne, parce que chaque identifiant est un appel réseau sortant.
 * Transmettre cent demandes en un clic tiendrait le magasin central occupé
 * plusieurs minutes et la requête ouverte d'autant.
 */
const MAX_BATCH = 25;

const TransmitSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            /**
             * Le code d'article du catalogue du magasin. Obligatoire : le stock
             * refuse une ligne sans lui (422, constaté sur un échange réel).
             * Le choisir est le travail du chef de service technique — notre
             * application n'a pas de catalogue pour le déduire.
             */
            codeRef: z
              .string()
              .trim()
              .min(1, "Choisissez l'article du magasin central"),
          })
          .strict()
      )
      .min(1, "Sélectionnez au moins une demande")
      .max(MAX_BATCH, `Au plus ${MAX_BATCH} demandes par envoi`),
  })
  .strict();

/**
 * Ce qu'une demande montre pour être transmise, et rien de plus.
 *
 * Le contexte du bon est joint ici alors qu'il ne l'est pas dans le panneau :
 * le magasin central ne connaît ni nos bons ni nos immeubles, et une demande
 * sans site ni appareil serait intraitable pour celui qui la prépare.
 */
const TRANSMIT_SELECT = {
  id: true,
  number: true,
  status: true,
  urgency: true,
  quantity: true,
  replacementPartName: true,
  replacementPartReference: true,
  faultyPartName: true,
  notes: true,
  stockReference: true,
  stockCodeRef: true,
  stockSentAt: true,
  requestedBy: { select: { name: true } },
  workOrder: {
    select: {
      orderNumber: true,
      elevator: {
        select: {
          elevatorCode: true,
          building: { select: { name: true, city: true } },
        },
      },
    },
  },
} as const;

interface Outcome {
  id: string;
  number: string;
  ok: boolean;
  /** « envoyée », « refusée », « ignorée » — ce que l'écran affiche par ligne. */
  outcome: "sent" | "failed" | "skipped";
  reference?: string | null;
  error?: string;
}

/**
 * GET /api/parts-replacement/transmit
 *
 * L'état de la liaison, pour que l'écran puisse le dire **avant** qu'on clique.
 * Une interface qui n'offre un bouton que pour le refuser ensuite apprend à
 * l'utilisateur à ne plus s'y fier.
 *
 * Elle ne dit rien de plus : ni l'adresse du magasin central, ni sa clé. Ce sont
 * des secrets d'exploitation, et un écran n'a pas à les afficher.
 */
export async function GET() {
  try {
    await requireRole(...MANAGEMENT_ROLES);
    const refusal = stockConfigRefusal();
    return jsonOk({ configured: refusal === null, refusal });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireRole(...MANAGEMENT_ROLES);
    const parsed = TransmitSchema.parse(await readJson(request));

    /**
     * La configuration est vérifiée avant toute lecture : inutile de charger
     * vingt-cinq demandes pour découvrir qu'aucune ne peut partir.
     */
    const configRefusal = stockConfigRefusal();
    if (configRefusal) throw badRequest(configRefusal);

    /**
     * Une entrée par demande, dédupliquée par identifiant.
     *
     * Le code d'article est porté par l'entrée et non par la demande : il est
     * choisi au moment de transmettre, dans le catalogue du magasin, et deux
     * demandes n'appellent presque jamais le même article.
     */
    const items = [
      ...new Map(parsed.items.map((item) => [item.id, item])).values(),
    ];
    const ids = items.map((item) => item.id);
    const codeRefById = new Map(items.map((item) => [item.id, item.codeRef]));

    const rows = await prisma.partRequirement.findMany({
      where: {
        id: { in: ids },
        ...scopeFor(session),
      },
      select: TRANSMIT_SELECT,
      orderBy: { createdAt: "asc" },
    });

    if (rows.length === 0) {
      throw notFound("Aucune demande de pièce ne correspond à cette sélection.");
    }

    const results: Outcome[] = [];

    for (const row of rows) {
      /** Vide si l'écran ne l'a pas fourni — le schéma l'interdit déjà. */
      const codeRef = codeRefById.get(row.id) ?? "";
      const refusal = transmissionRefusal(row);

      if (refusal) {
        results.push({
          id: row.id,
          number: row.number,
          ok: false,
          outcome: "skipped",
          error: refusal,
        });
        continue;
      }

      const payload = buildStockDemande({
        requirementNumber: row.number,
        urgency: row.urgency,
        quantity: row.quantity,
        replacementPartName: row.replacementPartName,
        replacementPartReference: row.replacementPartReference,
        faultyPartName: row.faultyPartName,
        notes: row.notes,
        elevatorCode: row.workOrder.elevator.elevatorCode,
        buildingName: row.workOrder.elevator.building.name,
        buildingCity: row.workOrder.elevator.building.city,
        workOrderNumber: row.workOrder.orderNumber,
        requestedByName: row.requestedBy?.name ?? null,
        stockCodeRef: codeRef,
      });

      /**
       * Envoi séquentiel, et non en parallèle : le magasin central valide
       * chaque dépôt dans sa propre transaction, et vingt-cinq écritures
       * simultanées sur sa table de demandes n'apportent rien qu'un peu
       * d'attente en moins contre un risque de verrouillage.
       */
      const result = await transmitDemande(payload);
      const now = new Date();

      if (!result.ok) {
        /**
         * L'échec est enregistré, l'état n'est pas touché. Une demande qui n'a
         * pas atteint le magasin n'est pas une demande commandée, et la marquer
         * `ORDERED` ferait croire à une commande qui n'existe pas.
         */
        await prisma.partRequirement.update({
          where: { id: row.id },
          data: {
            stockSendError: result.error,
            stockCodeRef: codeRef,
            stockSentAt: now,
            stockSentById: session.user.id ?? null,
          },
        });

        results.push({
          id: row.id,
          number: row.number,
          ok: false,
          outcome: "failed",
          error: result.error,
        });
        continue;
      }

      const target = STATUS_AFTER_TRANSMISSION;
      const statusChange = transitionRefusal(row.status, target);

      await prisma.partRequirement.update({
        where: { id: row.id },
        data: {
          stockDemandeId: result.demandeId,
          stockReference: result.reference,
          stockCodeRef: codeRef,
          stockSentAt: now,
          stockSentById: session.user.id ?? null,
          stockSendError: null,
          /**
           * `transitionRefusal` garde l'écriture : si un état futur rendait ce
           * passage illégal, la transmission serait tout de même enregistrée —
           * la pièce est bien commandée là-bas — mais l'état ne bougerait pas
           * plutôt que d'être forcé par une route qui contourne sa propre règle.
           */
          ...(statusChange
            ? {}
            : {
                status: target,
                statusChangedAt: now,
                statusChangedById: session.user.id ?? null,
              }),
        },
      });

      results.push({
        id: row.id,
        number: row.number,
        ok: true,
        outcome: "sent",
        reference: result.reference,
      });
    }

    const sent = results.filter((r) => r.outcome === "sent").length;
    const failed = results.filter((r) => r.outcome === "failed").length;
    const skipped = results.filter((r) => r.outcome === "skipped").length;

    return jsonOk({
      results,
      sent,
      failed,
      skipped,
      /**
       * La demande n'a pas d'identifiant unique par sélection : l'écran relit la
       * liste complète après l'envoi. Un registre partiel rendu ici serait une
       * seconde source de vérité pour les mêmes lignes.
       */
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Le périmètre, repris tel quel de la route des demandes.
 *
 * Transmettre engage une dépense auprès d'une autre application : un filtre de
 * confort ne peut pas élargir un droit, et la règle est la même que partout
 * ailleurs dans le dépôt.
 */
function scopeFor(
  session: Awaited<ReturnType<typeof requireRole>>
): { workOrder: { elevator: { building: ReturnType<typeof buildingScopeFor> } } } {
  return { workOrder: { elevator: { building: buildingScopeFor(session) } } };
}
