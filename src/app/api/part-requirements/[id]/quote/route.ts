/**
 * Transformer une demande de pièce en devis.
 *
 * LE CHAÎNON QUI MANQUAIT
 * Le technicien signale une pièce, le bureau valide la demande — puis il
 * fallait ressaisir l'immeuble, l'appareil et le besoin dans le formulaire de
 * devis, et la demande de pièce restait une ligne isolée. Cette route fait le
 * passage en une écriture : le devis naît avec le bon immeuble, le bon appareil
 * et le bon besoin, et le technicien affecté est prévenu.
 *
 * OÙ VIT LE LIEN AVEC LA DEMANDE
 * Le schéma n'a pas de clé étrangère `Quote.partRequirementId`, et en ajouter
 * une serait une migration pour une information qui tient dans une note. La
 * référence `[DP-…]` est donc écrite dans les notes internes du devis — assez
 * pour retrouver l'origine, assez pour ne pas créer deux fois la même offre.
 *
 * CE QUE LA ROUTE NE FAIT PAS
 * Elle ne chiffre pas le devis. Le bureau ouvre la fiche, saisit les lignes et
 * envoie l'offre : un montant calculé ici serait un tarif inventé.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { conflict, handleRouteError, notFound } from "@/lib/api/http";
import { MANAGEMENT_ROLES, requireRole } from "@/lib/api/guard";
import { createQuote } from "@/lib/quotes/service";
import { notify, notifyRoles } from "@/lib/notifications/service";
import { OPS_ROLES } from "@/types";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";

export const dynamic = "force-dynamic";

const QUOTABLE_STATUSES = ["PENDING", "APPROVED", "ORDERED"] as const;

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireRole(...MANAGEMENT_ROLES);

    const part = await prisma.partRequirement.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        number: true,
        status: true,
        quantity: true,
        replacementPartName: true,
        replacementPartReference: true,
        notes: true,
        createdAt: true,
        workOrder: {
          select: {
            id: true,
            orderNumber: true,
            assignedToId: true,
            elevator: {
              select: {
                id: true,
                elevatorCode: true,
                building: {
                  select: {
                    id: true,
                    name: true,
                    ownerId: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!part) throw notFound(`Demande de pièce introuvable : ${params.id}`);

    if (!QUOTABLE_STATUSES.includes(part.status as (typeof QUOTABLE_STATUSES)[number])) {
      throw conflict(
        part.status === "FULFILLED"
          ? "Cette pièce est déjà posée : le devis ne peut plus être créé depuis la demande."
          : "Cette demande a été refusée : aucun devis ne peut en être tiré."
      );
    }

    // Idempotence : un double clic ne doit pas produire deux offres.
    const marker = `[${part.number}]`;
    const existing = await prisma.quote.findFirst({
      where: { notes: { contains: marker } },
      select: { id: true, number: true, status: true },
    });

    if (existing) {
      return NextResponse.json({
        data: {
          quoteId: existing.id,
          number: existing.number,
          status: existing.status,
          alreadyExists: true,
        },
      });
    }

    const building = part.workOrder.elevator.building;
    const reference = part.replacementPartReference?.trim();

    /**
     * Le besoin est la phrase que le client lira.
     *
     * Elle ne reprend pas les observations du technicien : celles-ci sont
     * internes, et un devis n'a pas à exposer le diagnostic de terrain. Elles
     * vont dans `notes`, qui ne quitte pas le bureau.
     */
    const need =
      `Remplacement de la pièce « ${part.replacementPartName} »` +
      `${reference ? ` (réf. ${reference})` : ""} sur l'appareil ` +
      `${part.workOrder.elevator.elevatorCode}, immeuble ${building.name}. ` +
      `Quantité : ${part.quantity}. ` +
      `Demande de pièce ${part.number} du ` +
      `${part.createdAt.toLocaleDateString("fr-FR")}.`;

    const internalNotes =
      `Devis créé depuis la demande de pièce ${marker} — intervention ` +
      `${part.workOrder.orderNumber}.` +
      (part.notes ? `\nObservation du technicien : ${part.notes}` : "");

    const quote = await createQuote({
      // Le titulaire du dossier est le propriétaire de l'immeuble : c'est lui
      // qui verra l'offre dans son portail. Un immeuble sans compte client
      // produit un devis sans destinataire, consultable par le bureau seulement.
      clientId: building.ownerId,
      requestedById: session.user.id,
      buildingId: building.id,
      elevatorId: part.workOrder.elevator.id,
      need,
      notes: internalNotes,
    });

    /**
     * L'équipe technique est prévenue dans l'application, pas par un courriel
     * séparé : le technicien n'a pas de compte de messagerie d'entreprise, et
     * la cloche est le canal qui existe déjà.
     *
     * Un échec de notification ne défait pas le devis — `notify` ne lève
     * jamais, et une offre sans notification vaut mieux qu'une offre perdue.
     */
    const quoteNotification = {
      title: `Devis ${quote.number} — pièce demandée`,
      message:
        `Le bureau a ouvert le devis ${quote.number} pour ` +
        `« ${part.replacementPartName} » sur l'intervention ` +
        `${part.workOrder.orderNumber}.`,
      // Rangé avec les bons : le technicien le retrouve là où il suit son
      // intervention, et le type existant évite d'élargir l'union pour un
      // seul message.
      type: "work_order" as const,
      linkUrl: `/bons-de-travail/${part.workOrder.id}`,
    };

    if (part.workOrder.assignedToId) {
      await notify({
        userId: part.workOrder.assignedToId,
        ...quoteNotification,
      });
    } else {
      // Aucun technicien affecté : le devis concerne l'équipe entière, et
      // l'oublier jusqu'à l'affectation reviendrait à le transmettre à
      // personne.
      await notifyRoles([...OPS_ROLES], quoteNotification);
    }

    return NextResponse.json(
      {
        data: {
          quoteId: quote.id,
          number: quote.number,
          status: quote.status,
          alreadyExists: false,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    /**
     * Mode démonstration : l'offre est annoncée, pas écrite.
     *
     * Même règle que les signalements : sans PostgreSQL et avec
     * `DEMO_DATA="true"`, la route rend un numéro de démonstration et le dit.
     * Le devis n'existe alors dans aucune fiche — le lien vers la fiche est
     * donc absent, voir `src/app/(dashboard)/administration/pieces/page.tsx`.
     */
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("POST /api/part-requirements/[id]/quote");
      return NextResponse.json(
        {
          data: {
            quoteId: null,
            number: `DEV-DEMO/${String(Date.now()).slice(-4)}`,
            status: "REQUESTED",
            alreadyExists: false,
          },
          demo: true,
        },
        { status: 201 }
      );
    }
    return handleRouteError(error);
  }
}
