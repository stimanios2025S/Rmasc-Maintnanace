/**
 * Maintenance RMASC – Client Incident API
 *
 * GET  /api/incidents   – list incidents visible to the caller
 * POST /api/incidents   – record a client-reported fault
 *
 * This is the endpoint behind the client portal, and the only write path in
 * the application a BUILDING_OWNER may use. It is therefore the only place
 * where the caller's own input decides what work the company does — hence the
 * scoping below and the transition rules in `src/lib/incidents/progress.ts`.
 *
 * ESCALATION CREATES A WORK ORDER
 * A fault the customer could not clear becomes a real job, linked one-to-one
 * and raised in the same transaction. Doing it here rather than leaving it to
 * a dispatcher means an escalated fault cannot sit unnoticed on a board — by
 * the time the client's "non résolu" request returns, the work exists.
 */

import { NextRequest, NextResponse } from "next/server";
import type { Session } from "next-auth";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";
import {
  badRequest,
  handleRouteError,
  notFound,
  parseEnumParam,
  parsePagination,
  readJson,
} from "@/lib/api/http";
import {
  buildingScopeFor,
  elevatorScopeFor,
  MANAGEMENT_ROLES,
  OPS_ROLES,
  requireRole,
} from "@/lib/api/guard";
import { generateIncidentNumber, generateOrderNumber } from "@/lib/ids";
import { notifyRoles } from "@/lib/notifications/service";
import { autoAssignIncident } from "@/lib/dispatch/auto-assign";
import { sendAdminWhatsAppAlert } from "@/lib/notifications/whatsapp";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";
import { demoIncidents } from "@/lib/demo/responses";
import { readCoordinates } from "@/lib/geo/geofence";
import {
  readTechnicianFix,
  technicianProximity,
} from "@/lib/geo/technician-position";
import { INCIDENT_STATUSES } from "@/types";
import type { ReportedPositionSource } from "@/types";

// ─── Schemas ────────────────────────────────────────────────

/**
 * The two outcomes the client portal can submit.
 *
 * Drawn from `INCIDENT_STATUSES` so the list cannot drift from the Prisma
 * enum, then narrowed: the wizard reports a fault and either has fixed it or
 * has not. It cannot open an incident already assigned to a technician, and
 * it cannot close one that was never reported.
 */
const ClientOutcomeSchema = z.enum(["RESOLVED_BY_CLIENT", "ESCALATED"]);

const CreateIncidentSchema = z
  .object({
    elevatorId: z.string().min(1),
    errorCodeId: z.string().min(1).optional(),
    status: ClientOutcomeSchema.default("ESCALATED"),
    /**
     * True when the fault came from the emergency button rather than the
     * wizard. Drives the work order's type and priority, and is surfaced on
     * the admin board so a dispatcher can tell the two apart at a glance.
     */
    isDirectTransfer: z.boolean().default(false),
    notes: z.string().trim().max(4000).optional(),
    audioNoteUrl: z.string().trim().max(2000).optional(),
    /**
     * The reporter's own position, when their device supplied one.
     *
     * Optional, both halves together. Geocoding a fault report is a courtesy,
     * not a condition: a client who declines the browser prompt, or whose phone
     * takes ten seconds to get a fix, must still be able to report a stopped
     * lift. The bounds are checked here so an impossible pair is a 400 rather
     * than a row no map can draw.
     *
     * Half a coordinate is treated as no coordinate at all — see
     * `resolveReportedPosition`. A latitude with no longitude is a client bug,
     * and storing it would put a pin on the Greenwich meridian.
     */
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  })
  .strict();

type CreateIncidentInput = z.infer<typeof CreateIncidentSchema>;

const INCIDENT_SELECT = {
  id: true,
  incidentNumber: true,
  status: true,
  isDirectTransfer: true,
  notes: true,
  audioNoteUrl: true,
  // Returned so the board and the technician's sheet can draw the fault where
  // it was reported from, and say whether that is a measurement or the site's
  // address standing in for one.
  reportedLatitude: true,
  reportedLongitude: true,
  reportedPositionSource: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
  elevator: {
    select: {
      id: true,
      elevatorCode: true,
      model: true,
      building: {
        select: {
          id: true,
          name: true,
          address: true,
          city: true,
          // Read for the distance, never written. Null on a site that has
          // never been geolocated, which is why the board says "distance
          // inconnue" instead of guessing from the address.
          latitude: true,
          longitude: true,
          geofenceRadiusM: true,
          // Le code d'accès accompagne la panne : le dispatcheur le lit au
          // téléphone, et il part avec l'affectation vers le cockpit terrain.
          accessCode: true,
        },
      },
    },
  },
  errorCode: { select: { id: true, code: true, title: true } },
  /**
   * `clientType` is carried so the board can say whether the reporter is a
   * contracted customer.
   *
   * Read, never stored. An earlier draft added a `contractStatus` column to
   * `IncidentReport` — a denormalised copy of this value — which would have
   * been wrong the first time an account changed contract, with nothing to
   * reconcile it against. The relation is one join away and cannot drift.
   */
  client: {
    select: { id: true, name: true, email: true, phone: true, clientType: true },
  },
  /**
   * The assignee, with the last position their own phone reported.
   *
   * The three position columns are carried so the board can answer the one
   * question a dispatcher has while a job is open — how far out is he — without
   * a second request per row. They are the technician's own device's word, not
   * an administrator's, and `readTechnicianFix` decides whether they are recent
   * enough to show as current.
   */
  technician: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      /**
       * Le statut temps réel du technicien, pour que la colonne
       * « Statut & Affectation » du tableau puisse dire « Disponible » ou
       * « En mission » — sans quoi elle n'afficherait qu'un nom.
       */
      status: true,
      lastLatitude: true,
      lastLongitude: true,
      lastPositionAt: true,
    },
  },
  workOrder: {
    select: { id: true, orderNumber: true, status: true, priority: true },
  },
} satisfies Prisma.IncidentReportSelect;

/**
 * Adds the assignee's distance to the site to one incident row.
 *
 * WHY THIS IS COMPUTED HERE AND NOT IN THE BROWSER
 * The board already receives the site's coordinates and could subtract them
 * itself, but a distance the client derives is a distance the server never
 * agreed to: two screens would round it differently, and a route that later
 * stops sending one of the four numbers would produce `NaN` metres rather than
 * a missing value. It goes through `technicianProximity`, which goes through
 * `evaluateGeofence` — the same function the technician's own télémètre counts
 * down with and the server refuses a late check-in with, so the number a
 * dispatcher reads and the number a technician is judged by cannot disagree.
 *
 * THE AGE TRAVELS WITH THE DISTANCE, AND THAT IS THE POINT
 * A distance alone cannot be acted on, because a stale one looks exactly like a
 * live one. `technicianProximity.ageMs` is how long ago the device last spoke
 * and `isFresh` is whether that was inside the freshness window; the board
 * shows "il y a 18 min" beside a number it no longer trusts, rather than either
 * hiding it or presenting a phone in a basement as a live dot.
 *
 * Nothing is faked when the coordinates are missing. `distanceM` is null and
 * the board says « position inconnue » — the alternative, falling back to the
 * site's own position, would confidently report zero metres for a technician
 * whose phone never answered.
 */
function withTechnicianProximity<
  T extends {
    elevator: {
      building: {
        latitude: number | null;
        longitude: number | null;
        geofenceRadiusM: number | null;
      };
    };
    technician: {
      id: string;
      name: string | null;
      email: string;
      phone: string | null;
      status: string;
      lastLatitude: number | null;
      lastLongitude: number | null;
      lastPositionAt: Date | null;
    } | null;
  },
>(incident: T, now: Date) {
  const building = incident.elevator.building;
  const fix = readTechnicianFix(
    incident.technician ?? {
      lastLatitude: null,
      lastLongitude: null,
      lastPositionAt: null,
    },
    now
  );

  return {
    ...incident,
    technicianProximity: technicianProximity(
      fix,
      readCoordinates(building),
      building.geofenceRadiusM
    ),
  };
}

// ─── GET ────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");
    const { searchParams } = request.nextUrl;
    const { page, limit, skip } = parsePagination(searchParams);

    const status = parseEnumParam(searchParams, "status", INCIDENT_STATUSES);
    const elevatorId = searchParams.get("elevatorId");

    const where: Prisma.IncidentReportWhereInput = {
      ...incidentScopeFor(session),
      ...(status ? { status } : {}),
      ...(elevatorId ? { elevatorId } : {}),
      ...(searchParams.get("mine") === "true"
        ? { clientId: session.user.id }
        : {}),
    };

    const [total, incidents] = await Promise.all([
      prisma.incidentReport.count({ where }),
      prisma.incidentReport.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: INCIDENT_SELECT,
      }),
    ]);

    const now = new Date();

    return NextResponse.json({
      data: incidents.map((incident) => withTechnicianProximity(incident, now)),
      total,
      page,
      limit,
    });
  } catch (error) {
    if (shouldServeDemoData(error)) {
      warnDemoFallbackOnce("GET /api/incidents");
      const { searchParams } = new URL(request.url);
      return NextResponse.json(
        demoIncidents({
          status: searchParams.get("status"),
          elevatorId: searchParams.get("elevatorId"),
        })
      );
    }
    return handleRouteError(error);
  }
}

// ─── POST ───────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  /**
   * Le corps validé, gardé pour le repli de démonstration.
   *
   * Une écriture ne peut pas être servie par une fixture : le signalement
   * n'existe pas en base. Sans ce marqueur, le `catch` n'aurait aucun moyen de
   * reconstruire une réponse cohérente — et une erreur de connexion resterait
   * un « Échec d'envoi » opaque sur un écran dont toute la raison d'être est
   * de fonctionner quand la base est absente.
   */
  let demoBody: CreateIncidentInput | null = null;

  try {
    const session = await requireRole(...OPS_ROLES, "BUILDING_OWNER");
    const body = CreateIncidentSchema.parse(await readJson(request));
    demoBody = body;

    // The elevator must be inside the caller's portfolio. Scoping the lookup
    // rather than checking ownership afterwards means an out-of-portfolio id
    // is reported as "not found", which tells the caller nothing about whether
    // the unit exists.
    const elevator = await prisma.elevator.findFirst({
      where: { id: body.elevatorId, ...elevatorScopeFor(session) },
      select: {
        id: true,
        elevatorCode: true,
        installationLocation: true,
        building: {
          select: {
            id: true,
            name: true,
            address: true,
            city: true,
            // Read for the fallback position only. Never written back: the
            // building's own address is the permanent record and a report must
            // not be able to move it.
            latitude: true,
            longitude: true,
          },
        },
      },
    });
    if (!elevator) throw notFound(`Ascenseur introuvable : ${body.elevatorId}`);

    if (body.errorCodeId) {
      const code = await prisma.errorCode.findFirst({
        where: { id: body.errorCodeId, isActive: true },
        select: { id: true },
      });
      if (!code) throw badRequest(`Code d'erreur inconnu : ${body.errorCodeId}`);
    }

    const isEscalation = body.status === "ESCALATED";

    /**
     * Where this fault is, resolved once and written to both rows.
     *
     * Computed before the transaction because it reads the building we have
     * already fetched and depends on nothing the transaction writes. The same
     * three values go to the incident and to its work order, which is safe
     * precisely because neither is ever revised afterwards: the pair cannot
     * drift, there being nothing to drift from.
     */
    const reported = resolveReportedPosition(body, elevator.building);

    /**
     * The incident and its work order are written together.
     *
     * Both carry a table-unique human reference generated from a six-character
     * random suffix, so a collision is vanishingly unlikely but not
     * impossible. If either insert trips P2002 the whole transaction is
     * retried once with fresh numbers, rather than leaving an escalated
     * incident with no work order behind it.
     */
    const created = await withNumberCollisionRetry(() =>
      prisma.$transaction(async (tx) => {
        let workOrderId: string | null = null;

        if (isEscalation) {
          const workOrder = await tx.workOrder.create({
            data: {
              orderNumber: generateOrderNumber(
                body.isDirectTransfer ? "EMRG" : undefined
              ),
              title: buildWorkOrderTitle(elevator.elevatorCode, body),
              description: buildWorkOrderDescription(elevator, body),
              /**
               * Le lieu exact est repris du site et du complément d'installation
               * de l'appareil. Un signalement client ne saisit pas d'adresse :
               * c'est l'immeuble qui la porte, et le technicien doit la
               * retrouver telle quelle sur sa fiche.
               */
              interventionAddress: [
                elevator.building.address,
                elevator.building.city,
                elevator.installationLocation,
              ]
                .filter(Boolean)
                .join(", "),
              type: body.isDirectTransfer ? "EMERGENCY" : "CORRECTIVE",
              priority: body.isDirectTransfer ? "CRITICAL" : "HIGH",
              status: "OPEN",
              elevatorId: elevator.id,
              // The reporter owns the record of why this order exists. Using
              // the system creator here (as the telemetry ingestion path does)
              // would discard the only link back to the person who reported it.
              createdById: session.user.id,
              // The same snapshot the incident carries, so a technician opening
              // the job in the field never has to join back to find out where
              // the customer said the problem was.
              reportedLatitude: reported.latitude,
              reportedLongitude: reported.longitude,
              reportedPositionSource: reported.source,
            },
            select: { id: true },
          });
          workOrderId = workOrder.id;
        }

        return tx.incidentReport.create({
          data: {
            incidentNumber: generateIncidentNumber(),
            elevatorId: elevator.id,
            clientId: session.user.id,
            errorCodeId: body.errorCodeId ?? null,
            status: body.status,
            isDirectTransfer: body.isDirectTransfer,
            workOrderId,
            notes: body.notes ?? null,
            audioNoteUrl: body.audioNoteUrl ?? null,
            reportedLatitude: reported.latitude,
            reportedLongitude: reported.longitude,
            reportedPositionSource: reported.source,
            resolvedAt:
              body.status === "RESOLVED_BY_CLIENT" ? new Date() : null,
          },
          select: INCIDENT_SELECT,
        });
      })
    );

    /**
     * An escalation is dispatched straight away, before anybody is told.
     *
     * The order matters. Announcing "this needs a technician" and *then*
     * finding one produces two notifications that contradict each other, and a
     * manager who reads the first and dispatches by hand creates exactly the
     * double assignment `assignIncidentToTechnician`'s serializable claim
     * exists to prevent. Assigning first lets the notification say what
     * actually happened.
     *
     * This never throws. With no engineer reachable the incident simply stays
     * ESCALATED on the board awaiting manual dispatch, which is where it would
     * have been before this existed — see `src/lib/dispatch/auto-assign.ts`.
     */
    const auto = isEscalation ? await autoAssignIncident(created.id) : null;

    /**
     * Notification goes out after the commit, never inside the transaction.
     * A courtesy that fails must not roll back an escalation — see the note
     * at the top of `src/lib/notifications/service.ts`.
     */
    /**
     * Le lien commun aux deux issues.
     *
     * Une panne signalée — escaladée ou résolue par le client — doit ouvrir la
     * carte sur l'appareil, et non le tableau des incidents : le dispatcheur
     * voit immédiatement où se situe le problème.
     */
    const mapLink = `/carte?site=${encodeURIComponent(
      elevator.building.id
    )}&elevator=${encodeURIComponent(
      elevator.id
    )}&incident=${encodeURIComponent(created.id)}`;

    if (isEscalation) {
      const assignedTo = auto?.assigned
        ? auto.technician.name ?? auto.technician.id
        : null;

      await notifyRoles([...MANAGEMENT_ROLES], {
        title: body.isDirectTransfer
          ? `Urgence – ${elevator.elevatorCode}`
          : `Panne signalée – ${elevator.elevatorCode}`,
        message: assignedTo
          ? `${buildNotificationMessage(elevator, body)} Technicien affecté automatiquement : ${assignedTo}.`
          : `${buildNotificationMessage(elevator, body)} Aucun technicien disponible — affectation manuelle requise.`,
        type: "incident",
        /**
         * La notification ouvre la carte du parc, déjà centrée sur l'appareil
         * signalé.
         *
         * `site` sélectionne l'immeuble et `elevator` désigne la machine dans
         * sa liste ; `incident` permet à la carte de viser la position exacte
         * du signalement quand elle a été relevée. Les trois sont lus par
         * `/carte` — un lien vers le tableau des incidents obligerait le
         * dispatcheur à retrouver lui-même l'immeuble sur une carte qu'il
         * vient d'ouvrir.
         */
        linkUrl: mapLink,
        /**
         * Le bon, pour que la cloche du bureau puisse dispatcher depuis la
         * notification. Sans lui, l'alerte la plus urgente de l'application
         * arrive sans le bouton qui la traite et oblige à retrouver la ligne
         * sur le tableau.
         */
        workOrderId: created.workOrder?.id,
      });

      /**
       * Out of band, because the point of an escalation is that whoever needs
       * to see it may not be looking at a dashboard.
       *
       * Awaited rather than fired and forgotten, unlike the technician's
       * assignment message: this one is the whole point of the escalation, and
       * the caller is a customer pressing a button rather than a manager
       * waiting on a board. Even so, the send cannot fail the request — the
       * transport never throws, and a message that does not go out is logged in
       * capitals and reported as `delivered: false`. See the module header in
       * `src/lib/notifications/whatsapp.ts`.
       */
      await sendAdminWhatsAppAlert({
        headline: `Incident escaladé – ${elevator.elevatorCode}`,
        lines: [
          created.incidentNumber,
          `${elevator.building.name}, ${elevator.building.address}`,
          assignedTo
            ? `Technicien affecté : ${assignedTo}`
            : "Aucun technicien disponible",
        ],
      });
    } else {
      /**
       * Une panne que le client a résolue lui-même reste un signalement.
       *
       * Elle n'appelle pas de dispatch, mais elle informe le bureau : la
       * machine a eu un incident, et la carte doit pouvoir la montrer. Le
       * message le dit sans urgence, et le lien ouvre la même vue.
       */
      await notifyRoles([...MANAGEMENT_ROLES], {
        title: `Panne signalée – ${elevator.elevatorCode}`,
        message: `Une panne a été signalée pour ${elevator.elevatorCode} à ${elevator.building.name}, puis résolue par le client.`,
        type: "incident",
        linkUrl: mapLink,
        workOrderId: created.workOrder?.id,
      });
    }

    // The response reflects the final state rather than the state at commit:
    // after an automatic dispatch the incident is no longer ESCALATED, and
    // returning the pre-assignment row would have the caller's own next read
    // contradict the answer it was just given.
    //
    // Shaped by the same function the list uses, so a freshly created incident
    // carries the same three proximity fields as one that came off a GET — an
    // auto-dispatch has just assigned a technician, and that is precisely the
    // moment a caller wants to know where they are.
    return NextResponse.json(
      {
        data: withTechnicianProximity(
          auto?.assigned ? auto.incident : created,
          new Date()
        ),
      },
      { status: 201 }
    );
  } catch (error) {
    /**
     * Mode démonstration : le signalement est acquitté, pas enregistré.
     *
     * C'est une exception assumée au principe « les fixtures ne servent que
     * des lectures ». Elle n'existe que lorsque `DEMO_DATA="true"` et qu'une
     * base est injoignable — deux conditions que la production neutralise
     * (`NODE_ENV=production` force le repli à `false`, voir `demo/mode.ts`).
     * La réponse porte `demo: true` pour que le formulaire le dise à
     * l'utilisateur au lieu de laisser croire à une écriture.
     */
    if (demoBody && shouldServeDemoData(error)) {
      warnDemoFallbackOnce("POST /api/incidents");
      const now = new Date();
      return NextResponse.json(
        {
          data: {
            id: `demo-incident-${now.getTime()}`,
            incidentNumber: `DEMO-${String(now.getTime()).slice(-6)}`,
            status: demoBody.status,
            isDirectTransfer: demoBody.isDirectTransfer,
            notes: demoBody.notes ?? null,
            createdAt: now.toISOString(),
            resolvedAt:
              demoBody.status === "RESOLVED_BY_CLIENT"
                ? now.toISOString()
                : null,
            elevator: {
              id: demoBody.elevatorId,
              elevatorCode: "—",
              building: { id: "", name: "" },
            },
            errorCode: null,
            technician: null,
          },
          demo: true,
        },
        { status: 201 }
      );
    }
    return handleRouteError(error);
  }
}

// ─── Scoping ────────────────────────────────────────────────

/**
 * The `IncidentReport` filter a session may read.
 *
 * A BUILDING_OWNER is confined to incidents on its own portfolio, expressed
 * through the elevator relation so it reuses the same boundary as every other
 * owner-accessible read.
 *
 * A FIELD_TECHNICIAN sees only incidents assigned to them — narrower than the
 * fleet they can otherwise inspect. An incident carries the reporter's
 * free-text description of a fault in their own building, and that is not
 * something every technician needs to read.
 */
function incidentScopeFor(session: Session): Prisma.IncidentReportWhereInput {
  const role = session.user.role;

  if (role === "BUILDING_OWNER") {
    return { elevator: { building: buildingScopeFor(session) } };
  }
  if (role === "FIELD_TECHNICIAN") {
    return { technicianId: session.user.id };
  }
  return {};
}

// ─── Reported position ──────────────────────────────────────

/**
 * Where the reported fault is, and how we know.
 *
 * Three outcomes, in order of trust:
 *
 *  - the reporter's device gave a usable pair → `GPS`;
 *  - it did not, but we have geolocated the building → `SITE`, the address
 *    standing in for a measurement;
 *  - neither → nothing stored at all, and the map draws no pin for it. The
 *    site's own pin still carries the incident count, so the fault is not
 *    invisible — it is simply not pinned to a point nobody can vouch for.
 *
 * The validation is `readCoordinates`, the same predicate the geofence uses.
 * That is deliberate rather than convenient: it already refuses NaN, infinities
 * and out-of-range values, and it already accepts `(0, 0)` as the real place in
 * the Atlantic that it is rather than treating it as "unset". A second,
 * subtly-different test here is exactly how one screen ends up disagreeing with
 * another about whether a position exists.
 *
 * A single coordinate is not half a position, it is none: a latitude with no
 * longitude would place the pin on the Greenwich meridian, which is worse than
 * no pin because it looks like an answer.
 */
function resolveReportedPosition(
  body: CreateIncidentInput,
  building: { latitude: number | null; longitude: number | null }
): {
  latitude: number | null;
  longitude: number | null;
  source: ReportedPositionSource | null;
} {
  const device = readCoordinates({
    latitude: body.latitude ?? null,
    longitude: body.longitude ?? null,
  });
  if (device) return { ...device, source: "GPS" };

  const site = readCoordinates(building);
  if (site) return { ...site, source: "SITE" };

  return { latitude: null, longitude: null, source: null };
}

// ─── Copy builders ──────────────────────────────────────────

/**
 * The title the work order raised from a client report is stored under.
 *
 * Persisted on the row, so translating it changes what future orders record.
 * Nothing looks a work order up by this string — the incident links to its
 * order by id — so the change cannot orphan an existing record.
 */
function buildWorkOrderTitle(
  elevatorCode: string,
  body: CreateIncidentInput
): string {
  const prefix = body.isDirectTransfer
    ? "Signalement client urgent"
    : "Signalement client";
  return `${prefix} – ${elevatorCode}`;
}

function buildWorkOrderDescription(
  elevator: {
    elevatorCode: string;
    building: { name: string; address: string };
  },
  body: CreateIncidentInput
): string {
  const lines = [
    "Signalé par l'immeuble via l'espace client.",
    `Ascenseur : ${elevator.elevatorCode}`,
    `Site : ${elevator.building.name}, ${elevator.building.address}`,
  ];
  if (body.isDirectTransfer) {
    lines.push(
      "Déposé via le bouton d'urgence (transfert direct, sans tri préalable)."
    );
  }
  if (body.notes) {
    lines.push("", "Description du signalant :", body.notes);
  }
  return lines.join("\n");
}

function buildNotificationMessage(
  elevator: { elevatorCode: string; building: { name: string } },
  body: CreateIncidentInput
): string {
  const where = `${elevator.elevatorCode} à ${elevator.building.name}`;
  if (body.isDirectTransfer) {
    return `Assistance d'urgence demandée pour ${where}. Le signalant n'a pas pu décrire la panne — intervenez ou rappelez-le.`;
  }
  return `Une panne signalée pour ${where} n'a pas pu être résolue par le client et nécessite un technicien.`;
}

// ─── Retry ──────────────────────────────────────────────────

/**
 * Runs `fn`, retrying once when a unique constraint on a generated reference
 * collides. Only P2002 is retried; anything else is a real failure and is
 * rethrown untouched.
 */
async function withNumberCollisionRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isCollision = (error as { code?: string })?.code === "P2002";
      if (!isCollision || attempt >= 1) throw error;
      console.warn("[incidents] reference collision, retrying");
    }
  }
}
