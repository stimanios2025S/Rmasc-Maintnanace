/**
 * Maintenance RMASC – Fault-position backfill
 *
 * WHAT THIS REPAIRS
 * Every fault reported before the position columns existed has
 * `reported_latitude` at NULL, so the fleet map has no point to draw and the
 * incident is invisible there — not hidden by a filter, simply absent. The
 * columns cannot invent a measurement, but for those rows a true statement is
 * available: the site's registered address. That is exactly what
 * `ReportedPositionSource.SITE` exists to say, and it is the same fallback the
 * live write path already applies when a reporter's device gives nothing.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not touch a row that already has a position, even a `SITE` one, and
 * it does not touch anything on a building that has never been geolocated.
 * Those rows stay NULL and stay off the map, which is the honest outcome: a pin
 * placed at a guess is worse than no pin, because it looks like evidence.
 *
 * It also does not change a single status, note or timestamp. This is a repair
 * of where the fault is believed to be, and nothing else.
 *
 * EVERY ROW IT WRITES IS MARKED `SITE`, NEVER `GPS`.
 * The difference is the whole reason the enum has two members: `GPS` is a
 * measurement the reporter's own device took; `SITE` is the building's address
 * standing in for one. Writing `GPS` here would turn a backfill into a claim
 * that somebody stood at that spot, and a dispatcher would read it as evidence.
 *
 * DRY BY DEFAULT, AND IDEMPOTENT
 * Running it with no argument reports what it would change and writes nothing.
 * `--apply` performs the writes. Both filters are on NULL, so a second run —
 * and a second run after a partial failure — finds nothing left to do rather
 * than rewriting rows. There is no `--force` and no way to overwrite a position
 * that exists.
 *
 * Usage:
 *   npx tsx scripts/backfill-incident-positions.ts            # simulation
 *   npx tsx scripts/backfill-incident-positions.ts --apply    # écriture
 *
 * Run it AFTER `npm run db:push`: before the schema is applied the three
 * columns do not exist in the database, and the query fails with "column does
 * not exist" rather than doing anything useful.
 */

import { PrismaClient } from "@prisma/client";
// A relative import rather than the `@/` alias, matching `prisma/seed.ts`: this
// runs under `tsx`, outside Next's bundler, where the alias is not resolved.
import { isCoordinates } from "../src/lib/geo/geofence";

const APPLY = process.argv.includes("--apply");

const prisma = new PrismaClient();

interface BuildingGroup {
  name: string;
  latitude: number;
  longitude: number;
  incidentIds: string[];
  workOrderIds: string[];
}

async function main() {
  await prisma.$connect();

  console.log("");
  console.log("  Maintenance RMASC — Rattrapage des positions de panne");
  console.log("  ──────────────────────────────────────────────────────");
  console.log(
    APPLY
      ? "  Mode : APPLICATION — les modifications seront écrites."
      : "  Mode : SIMULATION — aucune écriture. Ajoute --apply pour écrire."
  );
  console.log("");

  /**
   * Every incident missing at least one of the two coordinates.
   *
   * `OR` rather than a check on both: a row written by a half-finished request
   * could carry one and not the other, and such a row is just as undrawable as
   * one with neither.
   *
   * No status filter. A closed fault is still a fact about where something
   * happened, and a repair that only touched open rows would leave the rest
   * permanently unmapped for no benefit.
   */
  const candidates = await prisma.incidentReport.findMany({
    where: {
      OR: [{ reportedLatitude: null }, { reportedLongitude: null }],
    },
    select: {
      id: true,
      incidentNumber: true,
      workOrderId: true,
      elevator: {
        select: {
          building: {
            select: {
              id: true,
              name: true,
              latitude: true,
              longitude: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`  Pannes sans position : ${candidates.length}`);

  const byBuilding = new Map<string, BuildingGroup>();
  const unmappedSites = new Set<string>();
  let unmappedIncidents = 0;

  for (const incident of candidates) {
    const building = incident.elevator.building;

    if (!isCoordinates(building)) {
      // The site itself has no coordinates, so there is nothing true to copy.
      unmappedSites.add(building.id);
      unmappedIncidents += 1;
      continue;
    }

    const group = byBuilding.get(building.id) ?? {
      name: building.name,
      latitude: building.latitude,
      longitude: building.longitude,
      incidentIds: [],
      workOrderIds: [],
    };

    group.incidentIds.push(incident.id);
    // The work order carries its own copy of the same three columns so a
    // technician opening the job in the field does not have to join back
    // through the incident to learn where to go.
    if (incident.workOrderId) group.workOrderIds.push(incident.workOrderId);

    byBuilding.set(building.id, group);
  }

  if (byBuilding.size === 0) {
    console.log("");
    console.log(
      unmappedIncidents > 0
        ? `  Rien à faire : ${unmappedIncidents} panne(s) sur ${unmappedSites.size} chantier(s) sans coordonnées.`
        : "  Rien à faire : toutes les pannes ont déjà une position."
    );
    console.log("");
    return;
  }

  let incidentCount = 0;
  let workOrderCount = 0;

  if (APPLY) {
    /**
     * One transaction for the whole repair.
     *
     * Either every building is backfilled or none is, so a run interrupted
     * half-way does not leave the map showing some sites' faults and not
     * others with nothing to say which. The timeout is generous because the
     * first run on a long history is the expensive one; every later run finds
     * nothing and costs a single query.
     */
    await prisma.$transaction(
      async (tx) => {
        for (const group of byBuilding.values()) {
          const incidents = await tx.incidentReport.updateMany({
            // Re-filtered on NULL inside the transaction: another writer could
            // have filled one of these rows since the read above, and this
            // script must never overwrite a real measurement with an address.
            where: {
              id: { in: group.incidentIds },
              OR: [{ reportedLatitude: null }, { reportedLongitude: null }],
            },
            data: {
              reportedLatitude: group.latitude,
              reportedLongitude: group.longitude,
              reportedPositionSource: "SITE",
            },
          });

          const workOrders = group.workOrderIds.length
            ? await tx.workOrder.updateMany({
                where: {
                  id: { in: group.workOrderIds },
                  OR: [
                    { reportedLatitude: null },
                    { reportedLongitude: null },
                  ],
                },
                data: {
                  reportedLatitude: group.latitude,
                  reportedLongitude: group.longitude,
                  reportedPositionSource: "SITE",
                },
              })
            : { count: 0 };

          incidentCount += incidents.count;
          workOrderCount += workOrders.count;

          console.log(
            `  ✔ ${group.name} — ${incidents.count} panne(s), ${workOrders.count} bon(s) de travail`
          );
        }
      },
      { timeout: 120_000 }
    );
  } else {
    for (const group of byBuilding.values()) {
      incidentCount += group.incidentIds.length;
      workOrderCount += group.workOrderIds.length;
      console.log(
        `  · ${group.name} — ${group.incidentIds.length} panne(s), ${group.workOrderIds.length} bon(s) de travail`
      );
    }
  }

  console.log("");
  console.log(`  Chantiers concernés : ${byBuilding.size}`);
  console.log(
    `${APPLY ? "  Pannes mises à jour : " : "  Pannes à mettre à jour : "}${incidentCount}`
  );
  console.log(
    `${APPLY ? "  Bons de travail mis à jour : " : "  Bons de travail à mettre à jour : "}${workOrderCount}`
  );

  if (unmappedIncidents > 0) {
    console.log("");
    console.log(
      `  ⚠ ${unmappedIncidents} panne(s) laissée(s) sans position : ${unmappedSites.size} chantier(s) n'ont toujours pas de coordonnées.`
    );
    console.log(
      "    Placez ces chantiers sur la carte depuis l'écran Ascenseurs, puis relancez ce script."
    );
  }

  console.log("");
  console.log(
    APPLY
      ? "  Terminé. Chaque position écrite est marquée « Adresse du site », jamais « Téléphone du client »."
      : "  Simulation terminée. Relancez avec --apply pour écrire ces positions."
  );
  console.log("");
}

main()
  .catch((error) => {
    console.error("");
    console.error("  ✘ Échec du rattrapage.");
    console.error(`    ${(error as Error).message}`);
    console.error("");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
