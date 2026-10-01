/**
 * Maintenance RMASC – une fiche client, et tout son parc.
 *
 * GET /api/clients/:id – le compte, ses immeubles, ses ascenseurs, et les
 *                        immeubles qu'il est possible de lui rattacher
 *
 * POURQUOI UNE SEULE RÉPONSE POUR TOUT CELA
 * La fiche client est un écran, et cet écran a besoin des trois ensemble : on
 * n'affiche pas un immeuble sans pouvoir dire s'il porte des appareils, et le
 * sélecteur de rattachement n'a de sens qu'à côté de la liste de ce qui est
 * déjà rattaché. Trois allers-retours pour peindre une page, c'est trois états
 * de chargement et trois façons d'échouer à moitié.
 *
 * Elle n'est pas confondue avec `GET /api/buildings`, qui sert la carte du parc
 * et renvoie tous les immeubles du périmètre de l'appelant — un administrateur y
 * voit donc les contacts de site de tous ses clients. Ici, la requête part du
 * client : un seul compte, et rien d'autre.
 *
 * ADMIN UNIQUEMENT, comme le reste du module client.
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError, jsonOk, notFound } from "@/lib/api/http";
import { requireRole } from "@/lib/api/guard";

type Params = { params: { id: string } };

/** Au-delà, le sélecteur devient une liste qu'on ne lit plus. */
const ATTACHABLE_LIMIT = 50;

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireRole("ADMIN");
    const { searchParams } = new URL(request.url);

    const client = await prisma.user.findFirst({
      // Scoped to client accounts, so an id belonging to a technician or an
      // administrator comes back as a 404 rather than as a staff file rendered
      // by a customer screen.
      where: { id: params.id, role: "BUILDING_OWNER" },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        address: true,
        clientType: true,
        isActive: true,
        createdAt: true,
        ownedBuildings: {
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            address: true,
            city: true,
            state: true,
            zipCode: true,
            contactPerson: true,
            contactEmail: true,
            contactPhone: true,
            slaTier: true,
            latitude: true,
            longitude: true,
            geofenceRadiusM: true,
            elevators: {
              where: { isActive: true },
              orderBy: { elevatorCode: "asc" },
              select: {
                id: true,
                elevatorCode: true,
                brand: true,
                model: true,
                serialNumber: true,
                motorType: true,
                controllerType: true,
                floorsServed: true,
                maxPayloadKg: true,
                installationDate: true,
                status: true,
                overallHealth: true,
                nextMaintenance: true,
              },
            },
          },
        },
      },
    });

    if (!client) throw notFound(`Compte client introuvable : ${params.id}`);

    /**
     * Les immeubles qu'on peut encore lui rattacher.
     *
     * Tous ceux qu'il ne possède pas déjà, et non les seuls orphelins : un site
     * qui change de gestionnaire est un cas réel, et ne proposer que les
     * immeubles sans propriétaire obligerait à passer par une modification en
     * base pour les autres. Le propriétaire actuel est renvoyé avec chacun, pour
     * que l'écran puisse dire ce qu'on est en train de déplacer.
     *
     * La condition est écrite en `OR` plutôt qu'en `{ not: … }` seul : sur une
     * colonne nullable, `not` ne dit pas clairement ce qu'il advient des lignes
     * à NULL, et un immeuble sans propriétaire est précisément le cas qu'on veut
     * voir figurer ici.
     */
    const query = searchParams.get("q")?.trim();
    const attachable = await prisma.building.findMany({
      where: {
        isActive: true,
        OR: [{ ownerId: null }, { ownerId: { not: client.id } }],
        ...(query
          ? {
              AND: [
                {
                  OR: [
                    { name: { contains: query, mode: "insensitive" } },
                    { address: { contains: query, mode: "insensitive" } },
                    { city: { contains: query, mode: "insensitive" } },
                  ],
                },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        address: true,
        city: true,
        owner: { select: { id: true, name: true } },
        _count: { select: { elevators: { where: { isActive: true } } } },
      },
      orderBy: { name: "asc" },
      take: ATTACHABLE_LIMIT,
    });

    return jsonOk({
      client,
      attachable: attachable.map((building) => ({
        id: building.id,
        name: building.name,
        address: building.address,
        city: building.city,
        owner: building.owner,
        elevatorCount: building._count.elevators,
      })),
      // Dit à l'écran que la liste est tronquée, plutôt que de laisser croire
      // qu'un immeuble est introuvable.
      attachableTruncated: attachable.length === ATTACHABLE_LIMIT,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
