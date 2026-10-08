/**
 * Maintenance RMASC – factures.
 *
 * GET    /api/invoices              – le registre, filtré selon qui demande
 * POST   /api/invoices              – émettre la facture d'un bon (idempotent)
 * PATCH  /api/invoices              – poser l'état d'une facture (réglée,
 *                                     annulée, ou retour à émise)
 *
 * LA SÉPARATION DES LECTURES
 * Un administrateur ou un responsable voit toutes les factures ; un compte
 * client ne voit que les siennes. La seconde règle n'est pas un confort : une
 * facture porte le nom, l'adresse, l'e-mail et le téléphone d'un client, et le
 * montant de ce qu'il doit. Une liste non filtrée aurait envoyé à chaque client
 * le dossier de tous les autres — le même défaut que `buildingScopeFor` a été
 * écrit pour fermer sur les immeubles.
 *
 * AUCUN REPLI DE DÉMONSTRATION
 * Contrairement aux immeubles et aux ascenseurs, ces routes n'en ont pas. Une
 * facture est un document numéroté et figé : la fabriquer dans une fixture
 * reviendrait à inventer un numéro de pièce comptable, et le PDF devrait ensuite
 * être rendu pour un document qui n'existe pas en base. Les écrans qui les
 * affichent ont besoin d'une vraie base — c'est le comportement qui existe déjà
 * pour l'administration des clients.
 *
 * CE QUI CHANGE AVEC LE REGISTRE
 * La lecture gagne des filtres — statut, client, période, recherche libre —, une
 * facette des clients présents dans le périmètre, le total des montants
 * affichés, et un export CSV qui partage exactement le même `where` que la
 * liste. L'écriture, elle, n'existait pas du tout : `InvoiceStatus` est une
 * colonne nouvelle, et un statut que personne ne peut poser est une colonne
 * morte.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  badRequest,
  conflict,
  handleRouteError,
  jsonOk,
  notFound,
  parseEnumParam,
  parsePagination,
  readJson,
} from "@/lib/api/http";
import { MANAGEMENT_ROLES, requireRole } from "@/lib/api/guard";
import { issueInvoiceForWorkOrder } from "@/lib/invoices/service";
import {
  MAX_EXPORT_ROWS,
  csvDateTime,
  csvFileName,
  csvResponse,
  toCsv,
} from "@/lib/export/csv";
import {
  dateRangeFilter,
  parsePeriod,
  parseSearchTerm,
} from "@/lib/registers/filters";
import { INVOICE_STATUSES } from "@/types";
import type { InvoiceStatus } from "@/types";
import { invoiceStatusLabel } from "@/lib/ui/enum-labels";
import type { AssertNever, InvoiceRegisterRow } from "@/lib/registers/shapes";
import type { CsvColumn } from "@/lib/export/csv";
import type { Prisma } from "@prisma/client";

/** La plus longue période d'un export, en années. Voir la garde du GET. */
const EXPORT_SPAN_YEARS = 10;

/**
 * Ce qu'une facture montre dans une liste.
 *
 * `issuedById` et les adresses n'y sont pas : une ligne de liste affiche un
 * numéro, une date et un montant, et le reste se lit sur la facture. Le statut
 * et son horodatage, eux, y sont — c'est la question que pose un registre.
 */
const INVOICE_LIST_SELECT = {
  id: true,
  number: true,
  issuedAt: true,
  amount: true,
  currency: true,
  orderNumber: true,
  orderTitle: true,
  buildingName: true,
  clientId: true,
  clientName: true,
  workOrderId: true,
  status: true,
  statusChangedAt: true,
} as const;

/**
 * Garde de compilation : la projection rend-elle tout ce que l'écran lit ?
 *
 * `InvoiceRegisterRow` est ce que le registre lit ; le type ci-dessous est ce
 * que `INVOICE_LIST_SELECT` rend. Si l'un porte un champ que l'autre n'a pas, ce
 * type cesse d'être `never` et la compilation échoue — au lieu de laisser
 * l'écran afficher un tiret que personne ne reliera à un oubli dans une
 * projection Prisma.
 *
 * Cette garde compte double ici. Contrairement aux rapports, les factures n'ont
 * **aucun jeu de démonstration** — c'est un choix, une facture est un document
 * numéroté — et il n'y a pas de PostgreSQL sur cette machine : l'écran des
 * factures n'a donc jamais pu être ouvert avec des données. C'est la seule
 * vérification mécanique disponible, et c'est précisément celle qui manquerait
 * le plus, parce qu'un registre vide ressemble à un registre sans factures.
 */
type InvoiceRegisterGap = Exclude<
  keyof InvoiceRegisterRow,
  keyof Prisma.InvoiceGetPayload<{ select: typeof INVOICE_LIST_SELECT }>
>;
type _InvoiceRegisterIsCovered = AssertNever<InvoiceRegisterGap>;

/** Les colonnes du fichier exporté. */
const EXPORT_SELECT = {
  number: true,
  issuedAt: true,
  clientName: true,
  buildingName: true,
  buildingCity: true,
  elevatorCode: true,
  orderNumber: true,
  orderType: true,
  amount: true,
  currency: true,
  status: true,
  statusChangedAt: true,
} as const;

/**
 * Ce qu'une ligne d'export doit porter — décrit par ses champs, pas par Prisma.
 *
 * `amount` est typé par ce qu'on lui demande — savoir s'écrire — plutôt que par
 * `Prisma.Decimal` : c'est la seule opération que l'export en fait, et le type
 * large évite d'attacher le module d'export à la couche base de données.
 */
interface InvoiceExportRow {
  number: string;
  issuedAt: Date;
  clientName: string;
  buildingName: string;
  buildingCity: string;
  elevatorCode: string;
  orderNumber: string;
  orderType: string;
  amount: { toString(): string };
  currency: string;
  status: string;
  statusChangedAt: Date | null;
}

/**
 * L'ordre des colonnes, choisi pour être lu et pour se recouper.
 *
 * Le numéro et la date d'abord — ce qui identifie une pièce. Le montant est
 * écrit comme un nombre exact, sans espace ni « DZD » : c'est ce qui permet à
 * Excel d'en faire la somme, et un registre de factures qu'on ne peut pas
 * additionner ne sert à rien. La devise a sa propre colonne pour la même raison.
 */
const EXPORT_COLUMNS: readonly CsvColumn<InvoiceExportRow>[] = [
  { header: "Numéro", value: (row) => row.number },
  { header: "Émise le", value: (row) => csvDateTime(row.issuedAt) },
  { header: "Client", value: (row) => row.clientName },
  { header: "Immeuble", value: (row) => row.buildingName },
  { header: "Ville", value: (row) => row.buildingCity },
  { header: "Appareil", value: (row) => row.elevatorCode },
  { header: "Bon de travail", value: (row) => row.orderNumber },
  { header: "Type", value: (row) => row.orderType },
  { header: "Montant", value: (row) => row.amount.toString() },
  { header: "Devise", value: (row) => row.currency },
  { header: "Statut", value: (row) => invoiceStatusLabel(row.status) },
  // « Réglée le » serait faux sur une facture annulée, et une colonne ne peut
  // pas changer de titre au milieu d'un fichier. Le titre dit donc ce que la
  // colonne contient vraiment : la date du dernier changement d'état, quel
  // qu'il soit.
  { header: "État modifié le", value: (row) => csvDateTime(row.statusChangedAt) },
];

export async function GET(request: NextRequest) {
  try {
    /**
     * Les rôles de gestion et les clients — les techniciens en sont exclus.
     *
     * Ce point de terminaison est un *relevé* : toutes les factures, avec le nom
     * du client et le montant. Un technicien de terrain n'a aucune raison de le
     * parcourir, et l'y laisser ouvrait la facturation complète de l'entreprise
     * à quiconque possède un compte de terrain. Il reste autorisé sur le PDF
     * d'une facture — un document qu'on atteint depuis un bon de travail qu'il
     * peut déjà ouvrir — mais pas sur la liste de tout le monde.
     */
    const session = await requireRole(...MANAGEMENT_ROLES, "BUILDING_OWNER");
    const { searchParams } = new URL(request.url);
    const { page, limit, skip } = parsePagination(searchParams);

    const workOrderId = searchParams.get("workOrderId");
    const clientId = searchParams.get("clientId");
    const status = parseEnumParam(searchParams, "status", INVOICE_STATUSES);
    const term = parseSearchTerm(searchParams);
    const period = parsePeriod(searchParams);
    const issuedAt = dateRangeFilter(period);

    /**
     * Le périmètre du compte client est posé *en dernier*, et écrase : un client
     * qui ajoute `?clientId=<un autre>` à l'adresse obtient ses propres
     * factures, pas celles du voisin. Le même ordre que le filtre par statut, et
     * pour la même raison — un filtre de confort ne peut pas élargir un droit.
     */
    const where: Prisma.InvoiceWhereInput = {
      ...(workOrderId ? { workOrderId } : {}),
      ...(clientId ? { clientId } : {}),
      ...(status ? { status } : {}),
      ...(issuedAt ? { issuedAt } : {}),
      ...(term
        ? {
            OR: [
              { number: { contains: term, mode: "insensitive" as const } },
              { clientName: { contains: term, mode: "insensitive" as const } },
              { orderNumber: { contains: term, mode: "insensitive" as const } },
              { buildingName: { contains: term, mode: "insensitive" as const } },
              { elevatorCode: { contains: term, mode: "insensitive" as const } },
            ],
          }
        : {}),
      ...(session.user.role === "BUILDING_OWNER"
        ? { clientId: session.user.id }
        : {}),
    };

    // ─── Export ───────────────────────────────────────────────
    //
    // Il partage `where`, et c'est tout l'intérêt : le fichier contient
    // exactement ce que l'écran montre. Un export qui relirait ses propres
    // paramètres finirait par diverger de la liste au premier filtre ajouté à
    // l'un et pas à l'autre.
    if (searchParams.get("format") === "csv") {
      /**
       * Une période est exigée, et bornée.
       *
       * Le registre des rapports exporte ce que le filtre décrit, et un filtre
       * absent y décrit un historique d'inspection — quelques milliers de
       * lignes. Ici, l'export sans filtre décrit *toutes les factures jamais
       * émises*, ce qui n'a pas de plafond naturel : c'est un fichier qui
       * grandit chaque mois, et un export qu'on demande sans y penser.
       *
       * Demander explicitement une période est la seule façon d'être sûr que le
       * fichier correspond à une intention. Le plafond de lignes reste en
       * second rideau, pour une période courte mais dense.
       */
      if (!period.from || !period.toExclusive) {
        throw badRequest(
          "Précisez une période (`?from=` et `?to=`) pour exporter les " +
            "factures : un export sans borne rassemblerait tout l'historique."
        );
      }

      const spanMs = period.toExclusive.getTime() - period.from.getTime();
      const maxSpanMs = EXPORT_SPAN_YEARS * 366 * 24 * 60 * 60 * 1000;
      if (spanMs > maxSpanMs) {
        throw badRequest(
          `La période demandée dépasse ${EXPORT_SPAN_YEARS} ans. ` +
            "Exportez exercice par exercice."
        );
      }

      const exportable = await prisma.invoice.count({ where });
      if (exportable > MAX_EXPORT_ROWS) {
        throw badRequest(
          `L'export est limité à ${MAX_EXPORT_ROWS.toLocaleString("fr-FR")} ` +
            `lignes, et cette période en compte ${exportable.toLocaleString("fr-FR")}. ` +
            "Resserrez la période ou le client."
        );
      }

      const rows = await prisma.invoice.findMany({
        where,
        orderBy: { issuedAt: "desc" },
        select: EXPORT_SELECT,
      });

      return csvResponse(
        csvFileName("registre-factures"),
        toCsv<InvoiceExportRow>(EXPORT_COLUMNS, rows)
      );
    }

    const [invoices, total, clients, aggregate] = await Promise.all([
      prisma.invoice.findMany({
        where,
        select: INVOICE_LIST_SELECT,
        orderBy: { issuedAt: "desc" },
        take: limit,
        skip,
      }),
      prisma.invoice.count({ where }),
      /**
       * Les clients facturés **dans le périmètre**, et non ceux du filtre.
       *
       * Même règle que pour les techniciens du registre des rapports :
       * construite sur `where`, cette liste se réduirait au client qu'on vient
       * de choisir et le sélecteur n'offrirait plus aucun moyen d'en sortir.
       *
       * Une facture sans compte client — un immeuble saisi avant l'ouverture du
       * dossier — n'a pas d'identifiant à offrir, et n'apparaît donc pas ici.
       * Elle reste atteignable par la recherche libre, qui lit le nom figé sur
       * la facture.
       */
      prisma.invoice.findMany({
        where: { ...where, clientId: { not: null } },
        /**
         * `distinct` trié sur la colonne distincte, et non sur le nom.
         *
         * PostgreSQL implémente `DISTINCT ON` en exigeant que le `ORDER BY`
         * commence par les expressions du `DISTINCT` : trier directement par
         * `clientName` produirait une requête que le serveur refuse. L'ordre
         * alphabétique est donc rendu en JavaScript, juste après — sur une liste
         * qui compte un client par ligne, ce qui n'est pas un tri coûteux.
         *
         * Le nom retenu est celui d'une des factures de ce client. C'est le nom
         * figé le jour de l'émission : il peut différer d'une facture ancienne à
         * une récente si le client a changé de raison sociale, et le sélecteur
         * en montre alors un — celui que la base a rendu en premier.
         */
        distinct: ["clientId"],
        orderBy: { clientId: "asc" },
        select: { clientId: true, clientName: true },
      }),
      /**
       * Le total des montants **affichés**, et non de la page.
       *
       * Un registre de factures dont on ne peut pas lire le total oblige à
       * exporter pour l'obtenir — c'est-à-dire à faire à la main ce que
       * l'écran avait sous les yeux. Calculé sur le même `where` que la liste,
       * donc filtré comme elle.
       */
      prisma.invoice.aggregate({ where, _sum: { amount: true } }),
    ]);

    return NextResponse.json({
      data: invoices,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
      clients: clients
        .filter(
          (row): row is { clientId: string; clientName: string } =>
            row.clientId !== null
        )
        .map((row) => ({ id: row.clientId, name: row.clientName }))
        .sort((a, b) => a.name.localeCompare(b.name, "fr")),
      // Rendu en chaîne : un `Decimal` de Prisma n'est pas un nombre JSON, et
      // le laisser sérialiser donne tantôt un nombre, tantôt une chaîne selon la
      // version. L'écran le met en forme avec `formatDzd`, qui accepte les deux.
      totalAmount: aggregate._sum.amount?.toString() ?? null,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

const UpdateInvoiceStatusSchema = z
  .object({
    id: z.string().trim().min(1, "La facture est obligatoire"),
    status: z.enum(INVOICE_STATUSES),
  })
  .strict();

/**
 * Pose l'état d'une facture.
 *
 * RÉSERVÉ AUX RÔLES DE GESTION
 * Marquer une facture réglée affirme qu'une somme est rentrée ; l'annuler
 * affirme qu'elle n'est plus due. Ni l'un ni l'autre ne se délègue à un compte
 * de terrain, et un compte client ne se répond évidemment pas à lui-même.
 *
 * ON NE RÈGLE NI N'ANNULE UNE PIÈCE QUI N'EST PAS DUE
 * Le passage à `PAID` ou à `CANCELLED` n'est accepté que depuis `ISSUED`. Sans
 * cette garde, une facture réglée pourrait être annulée directement, et le
 * registre perdrait la trace du règlement sans qu'aucun avoir ne le remplace —
 * le schéma n'en modélise pas. Pour corriger une facture déjà réglée, on la
 * ramène d'abord à « émise », geste explicite et réversible, puis on décide.
 *
 * Le retour à `ISSUED` est toujours permis : c'est le seul chemin d'erreur, et
 * un état dont on ne peut plus sortir oblige à repasser par la base.
 *
 * IDEMPOTENT
 * Reposer l'état qu'une facture porte déjà réussit et ne réécrit rien : l'écran
 * n'a pas à distinguer « je l'ai marquée réglée » de « elle l'était déjà ».
 */
export async function PATCH(request: NextRequest) {
  try {
    const session = await requireRole(...MANAGEMENT_ROLES);
    const parsed = UpdateInvoiceStatusSchema.parse(await readJson(request));

    const existing = await prisma.invoice.findUnique({
      where: { id: parsed.id },
      select: {
        id: true,
        number: true,
        status: true,
        statusChangedAt: true,
        statusChangedById: true,
      },
    });
    if (!existing) throw notFound(`Facture introuvable : ${parsed.id}`);

    if (existing.status === parsed.status) {
      return jsonOk(existing);
    }

    if (parsed.status !== "ISSUED" && existing.status !== "ISSUED") {
      throw conflict(
        `La facture ${existing.number} est ${invoiceStatusLabel(
          existing.status
        ).toLowerCase()}. Rétablissez-la d'abord à « Émise » avant de la ` +
          (parsed.status === "PAID" ? "marquer réglée." : "annuler.")
      );
    }

    const updated = await prisma.invoice.update({
      where: { id: parsed.id },
      data: {
        status: parsed.status,
        statusChangedAt: new Date(),
        statusChangedById: session.user.id ?? null,
      },
      select: {
        id: true,
        number: true,
        status: true,
        statusChangedAt: true,
        statusChangedById: true,
      },
    });

    return jsonOk(updated);
  } catch (error) {
    return handleRouteError(error);
  }
}

const IssueInvoiceSchema = z
  .object({ workOrderId: z.string().trim().min(1, "Le bon de travail est obligatoire") })
  .strict();

/**
 * Émet la facture d'un bon.
 *
 * Idempotent : rappeler cette route sur un bon déjà facturé renvoie la facture
 * existante. C'est ce qui permet de l'appeler sans risque après une validation —
 * et de l'appeler à nouveau depuis l'écran si la première tentative a échoué.
 *
 * Réservé aux rôles de gestion : émettre une facture est une décision, pas une
 * lecture.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireRole(...MANAGEMENT_ROLES);
    const parsed = IssueInvoiceSchema.parse(await readJson(request));

    const workOrder = await prisma.workOrder.findUnique({
      where: { id: parsed.workOrderId },
      select: {
        id: true,
        status: true,
        isBillable: true,
        invoiceAmount: true,
      },
    });
    if (!workOrder) {
      throw notFound(`Bon de travail introuvable : ${parsed.workOrderId}`);
    }

    /**
     * On refuse d'avancer une facture pour un travail qui n'est pas terminé.
     *
     * Sans cette garde, la route permettrait de facturer un bon encore ouvert ou
     * en attente de validation — c'est-à-dire d'envoyer une facture avant que
     * quiconque ait relu ce qui a été fait.
     */
    if (workOrder.status !== "COMPLETED") {
      throw badRequest(
        "Une facture ne peut être émise que pour un bon de travail clôturé."
      );
    }
    if (!workOrder.isBillable || workOrder.invoiceAmount === null) {
      throw badRequest(
        "Ce bon n'est pas facturable, ou son montant n'a pas été renseigné."
      );
    }

    const invoice = await issueInvoiceForWorkOrder(
      workOrder.id,
      session.user.id ?? null
    );
    if (!invoice) {
      throw badRequest("L'émission de la facture n'a produit aucun document.");
    }

    return jsonOk(invoice, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}
