/**
 * Émission d'une facture pour un bon de travail clos.
 *
 * POURQUOI L'ÉMISSION NE VIT PAS DANS LA TRANSACTION DU BON
 * Le réflexe serait de créer la facture dans le même `update` que la clôture,
 * pour que les deux soient vrais ensemble. C'est irréalisable ici, et pour une
 * raison précise : la séquence des numéros se calcule en lisant le plus grand
 * numéro de l'année, et sous PostgreSQL une violation de contrainte **avorte la
 * transaction courante**. Deux clôtures simultanées calculeraient le même
 * numéro ; celle qui perd ne pourrait pas réessayer — sa transaction serait déjà
 * morte, et avec elle la clôture du bon, la libération du technicien et tout ce
 * qui l'accompagne. Un administrateur verrait « la validation a échoué » sur une
 * validation qui n'a, en réalité, qu'un problème de numéro.
 *
 * L'émission se fait donc après, dans sa propre transaction, avec une boucle de
 * réessai : une collision n'annule qu'une tentative d'écriture de facture, et la
 * tentative suivante relit le plus grand numéro avant de repartir.
 *
 * LA CONTREPARTIE, ET ELLE EST ASSUMÉE
 * Si l'émission échoue pour de bon — base injoignable, disque plein — le bon
 * reste clos sans facture. C'est un état visible : la fiche du bon affiche
 * « aucune facture émise » et propose de l'émettre. Cette fonction est
 * idempotente, donc ce bouton ne peut pas produire de doublon : elle renvoie la
 * facture existante si le bon est déjà facturé.
 *
 * Elle sert aussi de rattrapage pour les bons facturables déjà clos avant que
 * cette fonctionnalité n'existe.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

/** `FA-2026-0042`. Le préfixe et la largeur sont ce qui rend le numéro lisible. */
export function formatInvoiceNumber(year: number, sequence: number): string {
  return `FA-${year}-${String(sequence).padStart(4, "0")}`;
}

/** Le bon et tout ce que la facture doit figer. */
const ISSUABLE_INCLUDE = {
  elevator: {
    select: {
      elevatorCode: true,
      building: {
        select: {
          name: true,
          address: true,
          city: true,
          contactPerson: true,
          contactPhone: true,
          owner: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              address: true,
            },
          },
        },
      },
    },
  },
} as const;

export type IssuedInvoice = { id: string; number: string };

/**
 * Émet la facture d'un bon, ou renvoie celle qui existe déjà.
 *
 * Renvoie `null` quand il n'y a rien à facturer : le bon n'est pas marqué
 * facturable, ou il l'est sans montant. Les deux sont des états réels — la
 * seconde est un rapport que le bureau n'a pas complété — et aucun des deux ne
 * justifie d'écrire une ligne à zéro dinar, qui serait une facture réclamant
 * rien.
 */
export async function issueInvoiceForWorkOrder(
  workOrderId: string,
  issuedById: string | null
): Promise<IssuedInvoice | null> {
  const workOrder = await prisma.workOrder.findUnique({
    where: { id: workOrderId },
    select: {
      id: true,
      orderNumber: true,
      title: true,
      type: true,
      status: true,
      completedAt: true,
      notes: true,
      partsReplaced: true,
      isBillable: true,
      invoiceAmount: true,
      elevator: ISSUABLE_INCLUDE.elevator,
    },
  });
  if (!workOrder) return null;

  // Déjà facturé : on renvoie l'existante plutôt que d'en créer une seconde.
  // C'est ce qui rend la fonction sûre à appeler deux fois — au moment de la
  // validation, puis depuis le bouton de rattrapage.
  const existing = await prisma.invoice.findUnique({
    where: { workOrderId },
    select: { id: true, number: true },
  });
  if (existing) return existing;

  if (!workOrder.isBillable || workOrder.invoiceAmount === null) return null;

  const building = workOrder.elevator.building;
  // Le client facturé est le propriétaire du site. À défaut — un immeuble sans
  // compte client, ce qui arrive quand un site a été saisi avant l'ouverture du
  // dossier — la facture est adressée au contact sur site, qui est la personne
  // à qui on l'a toujours remise. Le compte client reste alors nul, et la
  // facture n'apparaît dans aucun portail : c'est exact, personne ne peut la
  // consulter en ligne.
  const owner = building.owner;

  const year = new Date().getFullYear();

  /**
   * Trois tentatives, et trois seulement.
   *
   * Une collision de numéro est un événement de concurrence : deux factures
   * émises dans la même milliseconde. Elle se résout en relisant. Une quatrième
   * tentative ne résoudrait rien de plus et masquerait un problème réel — une
   * base qui refuse toute écriture — derrière ce qui ressemblerait à de la
   * malchance répétée.
   */
  for (let attempt = 0; attempt < 3; attempt++) {
    const last = await prisma.invoice.findFirst({
      where: { year },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const sequence = (last?.sequence ?? 0) + 1;

    try {
      const invoice = await prisma.invoice.create({
        data: {
          number: formatInvoiceNumber(year, sequence),
          year,
          sequence,
          workOrderId: workOrder.id,
          clientId: owner?.id ?? null,
          issuedById,

          clientName: owner?.name ?? building.contactPerson,
          clientAddress: owner?.address ?? null,
          clientEmail: owner?.email ?? null,
          clientPhone: owner?.phone ?? building.contactPhone ?? null,

          buildingName: building.name,
          buildingAddress: building.address,
          buildingCity: building.city,
          elevatorCode: workOrder.elevator.elevatorCode,

          orderNumber: workOrder.orderNumber,
          orderTitle: workOrder.title,
          orderType: workOrder.type,
          completedAt: workOrder.completedAt,

          reportNotes: workOrder.notes,
          // `Prisma.JsonNull` et non `null` : sur une colonne Json nullable,
          // `null` en écriture signifie « ne touche pas » dans certains chemins
          // de Prisma. La valeur explicite évite d'hériter du comportement.
          partsReplaced: workOrder.partsReplaced ?? Prisma.JsonNull,

          amount: workOrder.invoiceAmount,
          currency: "DZD",
        },
        select: { id: true, number: true },
      });

      return invoice;
    } catch (error) {
      const code = (error as { code?: string }).code;
      const isSequenceCollision = code === "P2002";
      if (!isSequenceCollision || attempt === 2) throw error;
      console.warn(
        `[invoices] collision de numéro pour l'année ${year}, nouvelle tentative`
      );
    }
  }

  // Inatteignable : la boucle renvoie ou relance. Gardé pour que le type de
  // retour ne dépende pas d'une analyse que le compilateur doit deviner.
  return null;
}
