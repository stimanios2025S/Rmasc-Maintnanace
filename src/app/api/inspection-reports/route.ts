/**
 * Maintenance RMASC – Inspection Reports API
 *
 * GET  /api/inspection-reports?workOrderId=…  – the report for a work order
 * GET  /api/inspection-reports                – recent reports (paginated)
 * POST /api/inspection-reports                – record a completed inspection
 *
 * Why this exists: the field portal rendered an inspection checklist that lived
 * entirely in React state. It was lost on refresh, never reached the database,
 * and yet it gated the "Complete Job" button — so a work order could be closed
 * with no record of what was actually inspected. The `InspectionReport` and
 * `InspectionCheckItem` models were already in the schema and seeded; nothing
 * ever wrote to them. This route closes that gap.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  badRequest,
  conflict,
  forbidden,
  handleRouteError,
  jsonOk,
  notFound,
  parseEnumParam,
  parsePagination,
  readJson,
} from "@/lib/api/http";
import {
  buildingScopeFor,
  OPS_ROLES,
  requireRole,
} from "@/lib/api/guard";
import { generateReportNumber } from "@/lib/ids";
import { notify, notifyMany, notifyRoles } from "@/lib/notifications/service";
import {
  MAX_EXPORT_ROWS,
  csvDateTime,
  csvFileName,
  csvResponse,
  toCsv,
} from "@/lib/export/csv";
import { dateRangeFilter, parsePeriod } from "@/lib/registers/filters";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import {
  demoInspectionReportById,
  demoInspectionReportForWorkOrder,
  demoInspectionReports,
} from "@/lib/demo/responses";
import { INSPECTION_CHECK_RESULTS, MANAGEMENT_ROLES } from "@/types";
import { enumLabel } from "@/lib/ui/enum-labels";
import type {
  AssertNever,
  InspectionReportRegisterRow,
} from "@/lib/registers/shapes";
import type { CsvColumn } from "@/lib/export/csv";
import type { Prisma } from "@prisma/client";

const CheckItemSchema = z.object({
  checkName: z.string().trim().min(1).max(200),
  result: z.enum(INSPECTION_CHECK_RESULTS).default("PASS"),
  description: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
  measuredValue: z.number().finite().optional(),
  unit: z.string().trim().max(20).optional(),
  /**
   * Evidence for this specific check, not for the visit as a whole. A photo
   * attached to the item it documents is worth more than a folder of
   * unattributed site pictures — six months later nobody can tell which
   * machine a loose image came from.
   */
  photoUrl: z.string().trim().url().max(2000).optional(),
});

/**
 * A signature recorded against the finished report.
 *
 * `imageDataUrl` is a canvas capture, capped hard. The cap is not decoration:
 * a signature is stored inside a JSON column on the same row as the report,
 * and a multi-megabyte base64 PNG would bloat every read of that row — the
 * list endpoint selects this column. 200 KB holds a generous stroke path at
 * pad resolution and nothing more.
 */
const SignatureSchema = z
  .object({
    role: z.enum(["TECHNICIAN", "CLIENT", "SUPERVISOR"]),
    name: z.string().trim().min(1).max(200),
    method: z.enum(["DRAWN", "TYPED"]).default("TYPED"),
    signedAt: z.string().datetime().optional(),
    imageDataUrl: z
      .string()
      .trim()
      .max(200_000)
      .regex(
        /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/,
        "L'image de signature doit être une URL de données base64 PNG ou JPEG"
      )
      .optional(),
  })
  .strict();

const CreateReportSchema = z
  .object({
    workOrderId: z.string().min(1),
    title: z.string().trim().min(3).max(200).optional(),
    summary: z.string().trim().max(5000).optional(),
    items: z.array(CheckItemSchema).min(1).max(100),
    signatures: z.array(SignatureSchema).max(4).optional(),
  })
  .strict();

/**
 * Worst result wins, so a single FAIL cannot be averaged away by PASSes.
 * ORDER: FAIL > NEEDS_ATTENTION > PASS; NOT_APPLICABLE is ignored unless
 * every item is NOT_APPLICABLE.
 */
function overallResult(
  items: { result: (typeof INSPECTION_CHECK_RESULTS)[number] }[]
): (typeof INSPECTION_CHECK_RESULTS)[number] {
  if (items.some((i) => i.result === "FAIL")) return "FAIL";
  if (items.some((i) => i.result === "NEEDS_ATTENTION")) return "NEEDS_ATTENTION";
  if (items.every((i) => i.result === "NOT_APPLICABLE")) return "NOT_APPLICABLE";
  return "PASS";
}

/**
 * Ce qu'une ligne du **registre** affiche.
 *
 * Distinct du `select` de la fiche, et c'est nécessaire : le registre montre
 * l'immeuble et le numéro du bon — sans quoi une ligne « Rapport du 3 mars » ne
 * dit pas de quelle machine elle parle — et il ne charge aucun point de
 * contrôle, qui est le contenu de la fiche et non de la liste.
 */
const LIST_SELECT = {
  id: true,
  reportNumber: true,
  title: true,
  overallResult: true,
  submittedAt: true,
  workOrderId: true,
  technician: { select: { id: true, name: true } },
  workOrder: { select: { id: true, orderNumber: true } },
  elevator: {
    select: {
      id: true,
      elevatorCode: true,
      building: { select: { id: true, name: true, city: true } },
    },
  },
} satisfies Prisma.InspectionReportSelect;

/**
 * Garde de compilation : la projection rend-elle tout ce que l'écran lit ?
 *
 * Voir le commentaire jumeau dans `api/invoices/route.ts`. L'écran et la route
 * sont séparés par une frontière HTTP : un champ absent de `LIST_SELECT` ne
 * casse rien, il affiche un tiret. Ce type échoue à la compilation dans ce cas
 * précis.
 */
type ReportRegisterGap = Exclude<
  keyof InspectionReportRegisterRow,
  keyof Prisma.InspectionReportGetPayload<{ select: typeof LIST_SELECT }>
>;
type _ReportRegisterIsCovered = AssertNever<ReportRegisterGap>;

/** Les colonnes de l'export. Plus larges que la liste : une ligne, un dossier. */
const EXPORT_SELECT = {
  reportNumber: true,
  submittedAt: true,
  overallResult: true,
  title: true,
  technician: { select: { name: true } },
  workOrder: { select: { orderNumber: true } },
  elevator: {
    select: {
      elevatorCode: true,
      building: { select: { name: true, city: true } },
    },
  },
} as const;

/**
 * Ce qu'une ligne d'export doit porter — décrit par ses champs, pas par Prisma.
 *
 * La forme est écrite à la main plutôt qu'extraite du client Prisma pour une
 * raison précise : le jeu de démonstration produit les mêmes lignes sans passer
 * par la base, et il doit pouvoir emprunter exactement le même chemin d'export.
 * Un type qui ne décrirait que la sortie de Prisma obligerait à écrire un second
 * export pour le mode démonstration, c'est-à-dire deux fichiers que personne ne
 * comparerait jamais.
 */
interface ReportExportRow {
  reportNumber: string;
  submittedAt: Date;
  overallResult: string;
  title: string;
  technician: { name: string | null };
  workOrder: { orderNumber: string };
  elevator: { elevatorCode: string; building: { name: string; city: string } };
}

/**
 * L'ordre des colonnes du fichier, et il est choisi pour être lu.
 *
 * Ce qui identifie d'abord — le numéro, la date —, puis de quoi on parle, puis
 * qui, puis le verdict. Le titre du rapport est en fin de ligne parce qu'il est
 * long et libre : au milieu, il repousse le résultat hors de l'écran.
 *
 * La conformité est écrite en français, par `enumLabel`, et non en `FAIL`. Un
 * registre s'ouvre pour être lu par un bureau, pas pour être reparsé : la valeur
 * stockée est un contrat avec la base, pas un mot pour un lecteur.
 */
const EXPORT_COLUMNS: readonly CsvColumn<ReportExportRow>[] = [
  { header: "Numéro", value: (row) => row.reportNumber },
  { header: "Transmis le", value: (row) => csvDateTime(row.submittedAt) },
  { header: "Immeuble", value: (row) => row.elevator.building.name },
  { header: "Ville", value: (row) => row.elevator.building.city },
  { header: "Appareil", value: (row) => row.elevator.elevatorCode },
  { header: "Technicien", value: (row) => row.technician.name },
  { header: "Bon de travail", value: (row) => row.workOrder.orderNumber },
  { header: "Titre", value: (row) => row.title },
  { header: "Conformité", value: (row) => enumLabel(row.overallResult) },
];

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const workOrderId = searchParams.get("workOrderId");
  /**
   * The printable view addresses one report directly. Kept as a parameter on
   * this route rather than a `[id]` segment so both lookups share the same
   * scoping and select — a second route would be a second place for the
   * portfolio boundary to drift.
   */
  const reportId = searchParams.get("id");

  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");

    const select = {
      id: true,
      reportNumber: true,
      title: true,
      summary: true,
      overallResult: true,
      submittedAt: true,
      workOrderId: true,
      signatures: true,
      technician: { select: { id: true, name: true } },
      checkItems: {
        select: {
          id: true,
          checkName: true,
          result: true,
          notes: true,
          measuredValue: true,
          unit: true,
          photoUrl: true,
        },
        orderBy: { id: "asc" as const },
      },
    };

    // A BUILDING_OWNER is confined to reports on its own portfolio. The
    // previous rule was "managers and owners see everything", which handed
    // every customer the complete inspection history of every other
    // customer's equipment — every check item, measured value and the
    // technician's free-text notes — both by id and via the list below.
    //
    // Scoped through the report's own `elevatorId` (the unit the inspection
    // documents) rather than through its work order.
    const ownerScope: Prisma.InspectionReportWhereInput =
      session.user.role === "BUILDING_OWNER"
        ? { elevator: { building: buildingScopeFor(session) } }
        : {};

    if (reportId) {
      const report = await prisma.inspectionReport.findFirst({
        // `findFirst` with the scope rather than `findUnique` by id: a report
        // outside the caller's portfolio must read as absent, not as a
        // permission error that confirms the row exists.
        where: {
          id: reportId,
          ...ownerScope,
          ...(session.user.role === "FIELD_TECHNICIAN"
            ? { technicianId: session.user.id }
            : {}),
        },
        select: {
          ...select,
          workOrder: {
            select: {
              id: true,
              orderNumber: true,
              title: true,
              type: true,
              priority: true,
              status: true,
              completedAt: true,
            },
          },
          elevator: {
            select: {
              id: true,
              elevatorCode: true,
              brand: true,
              model: true,
              building: { select: { name: true, address: true, city: true } },
            },
          },
        },
      });

      if (!report) throw notFound(`Rapport d'inspection introuvable : ${reportId}`);
      return jsonOk(report);
    }

    if (workOrderId) {
      const report = await prisma.inspectionReport.findFirst({
        where: {
          ...ownerScope,
          workOrderId,
          // A technician may only read their own reports. The work order is
          // the unit of authorisation.
          ...(session.user.role === "FIELD_TECHNICIAN"
            ? { technicianId: session.user.id }
            : {}),
        },
        orderBy: { submittedAt: "desc" },
        select,
      });

      // Absence is normal — it just means the job has not been signed off yet.
      // `jsonOk` already wraps the payload in `{ data }`.
      return jsonOk(report);
    }

    const { page, limit, skip } = parsePagination(request.nextUrl.searchParams);

    /**
     * Le périmètre du demandeur, et il est posé EN DERNIER dans `where`.
     *
     * C'est le point qui décide de tout : un filtre venu de l'adresse — même
     * `?technicianId=<un collègue>` — est écrasé par cette clause, parce qu'un
     * filtre de confort ne peut pas élargir un droit. Les deux lignes ci-dessous
     * n'expriment qu'une chose : ce que le demandeur a le droit de lire.
     */
    const scope: Prisma.InspectionReportWhereInput =
      session.user.role === "FIELD_TECHNICIAN"
        ? { technicianId: session.user.id }
        : ownerScope;

    /**
     * LES FILTRES DU REGISTRE
     *
     * Une recherche sur quatre critères — période, technicien, immeuble,
     * conformité —, chacun absent par défaut. Aucun n'est requis : un registre
     * s'ouvre sur l'historique entier, et se resserre ensuite.
     *
     * `parseEnumParam` refuse une conformité inconnue au lieu de l'ignorer.
     * `?result=NIMPORTEQUOI` qui rendrait le registre complet donnerait un
     * export qui a l'air filtré et ne l'est pas.
     */
    const result = parseEnumParam(
      searchParams,
      "result",
      INSPECTION_CHECK_RESULTS
    );
    const technicianId = searchParams.get("technicianId") || undefined;
    const buildingId = searchParams.get("buildingId") || undefined;
    const submittedAt = dateRangeFilter(parsePeriod(searchParams));

    const where: Prisma.InspectionReportWhereInput = {
      ...(result ? { overallResult: result } : {}),
      ...(technicianId ? { technicianId } : {}),
      ...(buildingId ? { elevator: { buildingId } } : {}),
      ...(submittedAt ? { submittedAt } : {}),
      ...scope,
    };

    // ─── Export ───────────────────────────────────────────────
    //
    // Il partage `where`, et c'est tout l'intérêt : le fichier contient
    // exactement ce que l'écran montre. Un export qui relirait ses propres
    // paramètres finirait par diverger de la liste au premier filtre ajouté à
    // l'un et pas à l'autre.
    if (searchParams.get("format") === "csv") {
      const exportable = await prisma.inspectionReport.count({ where });
      if (exportable > MAX_EXPORT_ROWS) {
        throw badRequest(
          `L'export est limité à ${MAX_EXPORT_ROWS.toLocaleString("fr-FR")} ` +
            `lignes, et ce filtre en compte ${exportable.toLocaleString("fr-FR")}. ` +
            "Resserrez la période ou l'immeuble."
        );
      }

      const rows = await prisma.inspectionReport.findMany({
        where,
        orderBy: { submittedAt: "desc" },
        select: EXPORT_SELECT,
      });

      return csvResponse(
        csvFileName("registre-rapports-inspection"),
        toCsv<ReportExportRow>(EXPORT_COLUMNS, rows)
      );
    }

    const [total, reports, technicians, byResult] = await Promise.all([
      prisma.inspectionReport.count({ where }),
      prisma.inspectionReport.findMany({
        where,
        orderBy: { submittedAt: "desc" },
        skip,
        take: limit,
        select: LIST_SELECT,
      }),
      /**
       * Les auteurs des rapports **du périmètre**, et non ceux du filtre.
       *
       * La différence n'est pas cosmétique : construite sur `where`, cette liste
       * se réduirait au technicien qu'on vient de choisir, et le sélecteur
       * n'offrirait plus aucun moyen d'en sortir — un filtre dont on ne peut
       * plus revenir est un piège.
       *
       * Lue depuis les rapports eux-mêmes plutôt que depuis `/api/technicians` :
       * ce dernier est réservé aux rôles de gestion, et un responsable qui a
       * signé un rapport doit y figurer comme les autres. Ici, quiconque
       * apparaît dans une ligne apparaît dans la liste — et personne d'autre,
       * donc aucun nom ne fuit hors du périmètre.
       */
      prisma.user.findMany({
        where: { inspectionReports: { some: scope } },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      /**
       * La répartition par verdict, sur `where`.
       *
       * C'est le chiffre de tête d'un registre de conformité : « quarante
       * rapports, dont trois non conformes » se lit, « quarante rapports » ne
       * dit rien. Compté par la base plutôt qu'en comptant les lignes
       * affichées — celles-ci sont paginées, et un total calculé sur une page
       * serait faux sans que rien ne le signale.
       */
      prisma.inspectionReport.groupBy({
        by: ["overallResult"],
        where,
        _count: { _all: true },
      }),
    ]);

    const counts: Record<string, number> = {};
    for (const row of byResult) {
      counts[row.overallResult] = row._count._all;
    }

    // `total` sits alongside `data` rather than inside it, matching
    // /api/alerts and /api/work-orders.
    return NextResponse.json({
      data: reports,
      total,
      page,
      limit,
      technicians,
      counts,
    });
  } catch (error) {
    /**
     * Dev-only fixture fallback, engaged only when `DEMO_DATA="true"` *and* the
     * failure is a connection failure — `shouldServeDemoData` makes both checks
     * and refuses when `NODE_ENV=production`. With the flag off (the shipped
     * default) an unreachable database returns 503 `DATABASE_UNAVAILABLE`, which
     * is the honest answer: an inspection history that silently becomes
     * invented reports is worse than one that fails to load.
     */
    if (shouldServeDemoData(error)) {
      if (reportId) {
        const report = demoInspectionReportById(reportId);
        // `notFound` builds the error; `handleRouteError` is what turns it into
        // a response. A bare `throw` here would escape the catch unhandled.
        if (!report) {
          return handleRouteError(
            notFound(`Rapport d'inspection introuvable : ${reportId}`)
          );
        }
        return jsonOk(report);
      }

      if (workOrderId) {
        // Absence is normal here — the job may simply not be signed off yet —
        // so a miss is `null`, matching the live branch.
        return jsonOk(demoInspectionReportForWorkOrder(workOrderId));
      }

      warnDemoFallbackOnce("GET /api/inspection-reports");
      /**
       * Les filtres sont relus ici plutôt que passés depuis le `try`.
       *
       * Ils ont déjà été validés — s'ils étaient illisibles, la route aurait
       * refusé avant d'atteindre la base, et `shouldServeDemoData` ne se
       * déclenche que sur une panne de connexion. Les relire évite de faire
       * traverser cinq variables à travers le `catch` pour un chemin qui n'est
       * actif qu'en développement.
       */
      const period = parsePeriod(searchParams);
      const filters = {
        result: parseEnumParam(searchParams, "result", INSPECTION_CHECK_RESULTS),
        technicianId: searchParams.get("technicianId") || undefined,
        buildingId: searchParams.get("buildingId") || undefined,
        from: period.from ?? undefined,
        toExclusive: period.toExclusive ?? undefined,
      };

      // L'export est servi depuis les mêmes lignes, pour que le bouton du
      // registre rende un fichier de démonstration plutôt qu'un JSON renommé
      // en `.csv` — un fichier qu'on n'ouvre qu'une fois avant de conclure que
      // l'export est cassé.
      //
      // Et il n'est pas paginé : un export rend ce que le filtre décrit, pas la
      // page affichée. Hériter de la pagination produirait un fichier de
      // cinquante lignes qui a l'air complet.
      if (searchParams.get("format") === "csv") {
        const all = demoInspectionReports({
          ...filters,
          limit: MAX_EXPORT_ROWS,
          skip: 0,
        });
        return csvResponse(
          csvFileName("registre-rapports-inspection"),
          toCsv<ReportExportRow>(
            EXPORT_COLUMNS,
            all.data as unknown as ReportExportRow[]
          )
        );
      }

      const { limit, skip } = parsePagination(searchParams);
      return NextResponse.json(demoInspectionReports({ ...filters, limit, skip }));
    }

    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES);
    const body = CreateReportSchema.parse(await readJson(request));

    const workOrder = await prisma.workOrder.findUnique({
      where: { id: body.workOrderId },
      select: {
        id: true,
        orderNumber: true,
        title: true,
        elevatorId: true,
        assignedToId: true,
        createdById: true,
        status: true,
        elevator: {
          select: {
            elevatorCode: true,
            building: { select: { name: true, ownerId: true } },
          },
        },
        inspectionReports: {
          select: { id: true, reportNumber: true },
          orderBy: { submittedAt: "desc" },
          take: 1,
        },
      },
    });

    if (!workOrder) throw notFound(`Bon de travail introuvable : ${body.workOrderId}`);

    // A FIELD_TECHNICIAN may only file a report against their own assignment.
    const isManager =
      session.user.role === "ADMIN" || session.user.role === "MAINTENANCE_MANAGER";
    if (!isManager && workOrder.assignedToId !== session.user.id) {
      throw forbidden("Vous ne pouvez déposer un rapport que pour un bon de travail qui vous est affecté.");
    }

    const existing = workOrder.inspectionReports[0];
    if (existing) {
      throw conflict(
        `Un rapport (${existing.reportNumber}) existe déjà pour ce bon de travail.`
      );
    }

    // A report on a cancelled order would be meaningless.
    if (workOrder.status === "CANCELLED") {
      throw badRequest("Impossible de déposer un rapport d'inspection pour un bon de travail annulé.");
    }

    // A signature names who signed. A drawn signature with no name attached is
    // an image of a scribble; the API will not accept one, and it will not
    // accept a signature block that claims a role nobody filled — see below.
    const signatures = (body.signatures ?? []).map((signature) => ({
      role: signature.role,
      name: signature.name,
      method: signature.method,
      signedAt: signature.signedAt ?? new Date().toISOString(),
      ...(signature.imageDataUrl ? { imageDataUrl: signature.imageDataUrl } : {}),
    }));

    const report = await prisma.inspectionReport.create({
      data: {
        workOrderId: workOrder.id,
        technicianId: session.user.id,
        elevatorId: workOrder.elevatorId,
        reportNumber: generateReportNumber(),
        title: body.title ?? `Inspection – ${workOrder.title}`,
        summary: body.summary,
        overallResult: overallResult(body.items),
        signatures: signatures.length > 0 ? signatures : undefined,
        checkItems: {
          create: body.items.map((item) => ({
            checkName: item.checkName,
            description: item.description,
            result: item.result,
            notes: item.notes,
            measuredValue: item.measuredValue,
            unit: item.unit,
            photoUrl: item.photoUrl,
          })),
        },
      },
      select: {
        id: true,
        reportNumber: true,
        overallResult: true,
        submittedAt: true,
      },
    });

    /**
     * Tell the customer their equipment was inspected.
     *
     * Addressed to the building's owner rather than broadcast to management:
     * this is the "your lift was serviced today" message, and its audience is
     * the person who owns the building, not the dispatch desk that sent the
     * technician. When no owner is recorded on the building there is nobody
     * whose equipment it is, so nothing is sent — inventing a recipient would
     * put a customer's maintenance record in a stranger's inbox.
     */
    const owner = workOrder.elevator.building.ownerId;
    if (owner && owner !== session.user.id) {
      await notify({
        userId: owner,
        title: `Inspection terminée – ${workOrder.elevator.elevatorCode}`,
        message:
          `Le rapport ${report.reportNumber} pour ${workOrder.elevator.elevatorCode} ` +
          `(${workOrder.elevator.building.name}) est disponible. ` +
          `Résultat : ${report.overallResult}.`,
        type: "inspection",
        linkUrl: `/rapports-inspection/${report.id}`,
      });
    }

    // A FAIL is a follow-up someone has to schedule; a clean PASS is not worth
    // a notification to the dispatch desk.
    //
    // Sent to whoever raised the order, falling back to the dispatch desk when
    // the creator's account has since been deleted (`createdById` is nullable
    // and `onDelete: SetNull`). Without the fallback a failed inspection on an
    // order raised by a departed colleague would notify nobody at all.
    if (report.overallResult === "FAIL") {
      const notice = {
        title: `Inspection en échec – ${workOrder.orderNumber}`,
        message:
          `${workOrder.elevator.elevatorCode} a échoué à l'inspection (${report.reportNumber}). ` +
          "Consultez le rapport et ouvrez une intervention corrective.",
        type: "inspection" as const,
        linkUrl: `/rapports-inspection/${report.id}`,
      };

      if (workOrder.createdById) {
        await notifyMany([workOrder.createdById], notice);
      } else {
        await notifyRoles(MANAGEMENT_ROLES, notice);
      }
    }

    return NextResponse.json({ data: report }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
