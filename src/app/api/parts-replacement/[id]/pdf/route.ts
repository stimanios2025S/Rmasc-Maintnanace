/**
 * Maintenance RMASC – la fiche de remplacement de pièces, en PDF.
 *
 * GET /api/parts-replacement/:id/pdf – le document, prêt à imprimer
 *
 * POURQUOI ELLE EST UN PDF ET NON UNE PAGE IMPRIMABLE
 * Le rapport d'inspection est une page HTML imprimable parce qu'il porte des
 * photos, des signatures dessinées et des notes longues — ce que le navigateur
 * compose mieux que pdfkit, et ce qu'un technicien remplit à l'écran.
 *
 * Cette fiche-là est un document court, engendré, que personne ne remplit :
 * elle naît complète de la demande et part avec la pièce. Un PDF produit côté
 * serveur en fait un fichier qu'on joint à un courriel de commande, qu'on
 * imprime au bureau et qu'on retrouve identique des deux côtés — ce qu'une page
 * HTML ne garantit pas.
 *
 * ELLE EST INTERNE
 * Contrairement au PDF d'une facture, aucun compte client n'y a accès. Elle
 * porte un diagnostic technique et l'état d'une dépense interne : rien de ce
 * qu'un propriétaire d'immeuble a à lire, et rien qu'il ait demandé.
 *
 * UN SEUL CHEMIN DE COMPOSITION, POUR LES DEUX SOURCES
 * La ligne vient de la base ou, en développement, du jeu de démonstration. Les
 * deux traversent `toSheet`, et c'est délibéré : une seconde mise en page pour
 * la démonstration produirait un document qu'on croit avoir vérifié alors qu'on
 * n'a regardé que l'autre.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError, notFound } from "@/lib/api/http";
import { OPS_ROLES, buildingScopeFor, requireRole } from "@/lib/api/guard";
import {
  partSheetFileName,
  renderPartRequirementPdf,
} from "@/lib/parts/pdf";
import type { PartSheetDocument } from "@/lib/parts/pdf";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoPartRequirementById } from "@/lib/demo/responses";
import type { Prisma } from "@prisma/client";

type Params = { params: { id: string } };

/** pdfkit lit ses polices et le tampon sur le disque : jamais dans l'edge. */
export const runtime = "nodejs";

/** Où et sur quoi porte la demande — les champs que la fiche nomme. */
interface Junction {
  orderNumber: string;
  orderTitle: string;
  elevatorCode: string;
  elevatorBrand: string | null;
  elevatorModel: string | null;
  buildingName: string;
  buildingAddress: string;
  buildingCity: string;
}

/** La demande elle-même, sans ses jointures. */
interface Requirement {
  number: string;
  status: string;
  urgency: string;
  quantity: number;
  requestedAt: Date;
  faultyPartName: string;
  faultyPartReference: string | null;
  replacementPartName: string;
  replacementPartReference: string | null;
  notes: string | null;
  statusChangedAt: Date | null;
  fulfilledAt: Date | null;
  requestedBy: { name: string | null } | null;
  statusChangedBy: { name: string | null } | null;
}

function toSheet(row: Requirement, junction: Junction): PartSheetDocument {
  return {
    number: row.number,
    status: row.status,
    urgency: row.urgency,
    requestedAt: row.requestedAt,
    quantity: row.quantity,

    faultyPartName: row.faultyPartName,
    faultyPartReference: row.faultyPartReference,
    replacementPartName: row.replacementPartName,
    replacementPartReference: row.replacementPartReference,
    notes: row.notes,

    // Le nom du demandeur est facultatif des deux côtés : la relation est
    // `SetNull`, et un compte supprimé ne doit pas empêcher la fiche de
    // s'imprimer. La fiche dit alors « Compte supprimé », ce qui est la vérité.
    requestedByName: row.requestedBy?.name ?? null,
    decidedByName: row.statusChangedBy?.name ?? null,
    decidedAt: row.statusChangedAt,
    fulfilledAt: row.fulfilledAt,

    ...junction,
  };
}

/**
 * La réponse binaire, dans un seul endroit.
 *
 * Le nom du fichier, le type et le `no-store` sont décidés une fois : deux
 * constructions d'en-tête finiraient par ne plus dire la même chose, et c'est
 * exactement le genre d'écart qu'on ne remarque qu'en comparant deux
 * téléchargements.
 */
function pdfResponse(pdf: Buffer, reference: string): NextResponse {
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${partSheetFileName(
        reference
      )}"`,
      "Content-Length": String(pdf.byteLength),
      // Une fiche interne ne se met pas en cache : ni par un proxy
      // d'entreprise, ni par l'historique partagé d'un poste de bureau.
      "Cache-Control": "private, no-store",
    },
  });
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireRole(...OPS_ROLES);

    /**
     * Le cloisonnement, posé dans le `where` plutôt que vérifié après coup.
     *
     * `findFirst` avec ce filtre rend `null` pour la demande d'un collègue, ce
     * qui est déjà la 404 à servir — et qui n'apprend pas à l'appelant que
     * l'identifiant existe. Même règle que la route de liste, exprimée une
     * seconde fois parce qu'ici il n'y a pas de `where` à partager.
     */
    const scope: Prisma.PartRequirementWhereInput =
      session.user.role === "FIELD_TECHNICIAN"
        ? { workOrder: { assignedToId: session.user.id } }
        : { workOrder: { elevator: { building: buildingScopeFor(session) } } };

    const row = await prisma.partRequirement.findFirst({
      where: { id: params.id, ...scope },
      select: {
        number: true,
        status: true,
        urgency: true,
        quantity: true,
        createdAt: true,
        faultyPartName: true,
        faultyPartReference: true,
        replacementPartName: true,
        replacementPartReference: true,
        notes: true,
        statusChangedAt: true,
        fulfilledAt: true,
        requestedBy: { select: { name: true } },
        statusChangedBy: { select: { name: true } },
        workOrder: {
          select: {
            orderNumber: true,
            title: true,
            elevator: {
              select: {
                elevatorCode: true,
                brand: true,
                model: true,
                building: { select: { name: true, address: true, city: true } },
              },
            },
          },
        },
      },
    });

    if (!row) throw notFound(`Demande de pièce introuvable : ${params.id}`);

    const { workOrder } = row;
    const sheet = toSheet(
      { ...row, requestedAt: row.createdAt },
      {
        orderNumber: workOrder.orderNumber,
        orderTitle: workOrder.title,
        elevatorCode: workOrder.elevator.elevatorCode,
        elevatorBrand: workOrder.elevator.brand,
        elevatorModel: workOrder.elevator.model,
        buildingName: workOrder.elevator.building.name,
        buildingAddress: workOrder.elevator.building.address,
        buildingCity: workOrder.elevator.building.city,
      }
    );

    return pdfResponse(await renderPartRequirementPdf(sheet), row.number);
  } catch (error) {
    /**
     * Repli de démonstration, engagé seulement quand `DEMO_DATA="true"` *et* que
     * la panne est une panne de connexion — `shouldServeDemoData` fait les deux
     * vérifications et refuse en production.
     *
     * Il n'est pas là pour faire joli : sans lui, le générateur PDF n'est
     * exerçable nulle part sur une machine sans base de données, c'est-à-dire
     * précisément là où une erreur de mise en page ne se voit pas. Une facture
     * n'a pas ce repli et ne peut pas l'avoir — un numéro de pièce comptable
     * inventé serait un faux document —, mais une fiche interne dont la fixture
     * existe déjà n'a pas ce problème.
     */
    if (shouldServeDemoData(error)) {
      const row = demoPartRequirementById(params.id);
      if (!row) {
        return handleRouteError(
          notFound(`Demande de pièce introuvable : ${params.id}`)
        );
      }

      warnDemoFallbackOnce("GET /api/parts-replacement/[id]/pdf");
      const sheet = toSheet(
        { ...row, requestedAt: row.createdAt },
        {
          orderNumber: row.orderNumber,
          orderTitle: row.orderTitle,
          elevatorCode: row.elevatorCode,
          elevatorBrand: row.elevatorBrand,
          elevatorModel: row.elevatorModel,
          buildingName: row.buildingName,
          buildingAddress: row.buildingAddress,
          buildingCity: row.buildingCity,
        }
      );

      return pdfResponse(await renderPartRequirementPdf(sheet), row.number);
    }

    return handleRouteError(error);
  }
}
