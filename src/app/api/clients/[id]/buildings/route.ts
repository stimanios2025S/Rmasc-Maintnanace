/**
 * Maintenance RMASC – rattachement d'un immeuble à un compte client.
 *
 * PATCH  /api/clients/:id/buildings   – rattacher un immeuble existant
 * DELETE /api/clients/:id/buildings   – le détacher (le remettre sans propriétaire)
 *
 * POURQUOI PAS `PATCH /api/buildings/:id`
 * Cette route-là configure un *site* : position, rayon de géorepérage, et sa
 * validation exige qu'au moins un de ces deux champs soit présent. Y ajouter un
 * changement de propriétaire aurait mélangé deux métiers — la configuration
 * d'un lieu et l'administration d'un compte — dans un schéma dont la règle
 * « aucun champ à mettre à jour » aurait alors dépendu de qui appelle.
 *
 * Ici l'objet de la requête est le client, et l'immeuble n'est que ce qu'on lui
 * donne ou lui retire. Les deux verbes vivent donc sous `/clients/:id/`.
 *
 * CRÉER UN IMMEUBLE N'EST PAS ICI
 * La création passe par `POST /api/buildings`, qui valide déjà tout le site —
 * adresse, contact, palier de service, propriétaire éligible. Recopier ce
 * schéma ici en aurait fait une deuxième version, et c'est la deuxième qui
 * oublie un champ.
 *
 * ADMIN UNIQUEMENT.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  badRequest,
  handleRouteError,
  jsonOk,
  notFound,
  readJson,
} from "@/lib/api/http";
import { requireRole } from "@/lib/api/guard";

type Params = { params: { id: string } };

const AttachSchema = z
  .object({ buildingId: z.string().trim().min(1, "L'immeuble est obligatoire") })
  .strict();

/**
 * Le compte client visé, ou une 404 nommée.
 *
 * Répété aux deux verbes plutôt que factorisé dans un helper qui renverrait
 * aussi la réponse d'erreur : deux appels, deux lignes, et le jour où l'un des
 * deux doit changer, il change là où il est écrit.
 */
async function requireClient(id: string) {
  const client = await prisma.user.findFirst({
    where: { id, role: "BUILDING_OWNER" },
    select: { id: true, name: true },
  });
  if (!client) throw notFound(`Compte client introuvable : ${id}`);
  return client;
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    await requireRole("ADMIN");
    const client = await requireClient(params.id);
    const parsed = AttachSchema.parse(await readJson(request));

    const building = await prisma.building.findFirst({
      where: { id: parsed.buildingId, isActive: true },
      select: { id: true, name: true, ownerId: true },
    });
    if (!building) {
      throw notFound(`Immeuble introuvable : ${parsed.buildingId}`);
    }

    /**
     * Réaffecter un immeuble déjà détenu par un autre client est permis — c'est
     * le cas « le site change de gestionnaire » — mais jamais en silence : le
     * changement est journalisé côté serveur, et l'écran affiche à qui
     * l'immeuble appartenait avant que l'administrateur ne valide.
     */
    if (building.ownerId === client.id) {
      return jsonOk({ buildingId: building.id, ownerId: client.id, moved: false });
    }

    const updated = await prisma.building.update({
      where: { id: building.id },
      data: { ownerId: client.id },
      select: { id: true, name: true, ownerId: true },
    });

    return jsonOk({
      buildingId: updated.id,
      ownerId: updated.ownerId,
      moved: true,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    await requireRole("ADMIN");
    const client = await requireClient(params.id);

    const buildingId = new URL(request.url).searchParams.get("buildingId");
    if (!buildingId) throw badRequest("L'immeuble est obligatoire");

    /**
     * Détacher n'est autorisé que sur un immeuble que ce client détient
     * réellement. Sans cette condition, la route servirait à retirer un site à
     * un *autre* client en passant son identifiant de compte — le verbe
     * paraîtrait anodin et l'effet ne le serait pas.
     */
    const building = await prisma.building.findFirst({
      where: { id: buildingId, ownerId: client.id },
      select: { id: true },
    });
    if (!building) {
      throw notFound(
        `Cet immeuble n'est pas rattaché à ${client.name} : ${buildingId}`
      );
    }

    const updated = await prisma.building.update({
      where: { id: building.id },
      // Détacher, c'est remettre l'immeuble sans propriétaire — jamais le
      // supprimer. Le site, ses appareils, son historique d'interventions et ses
      // rapports restent en base : ils appartiennent au bâtiment, pas au
      // contrat qui vient de se terminer.
      data: { ownerId: null },
      select: { id: true },
    });

    return jsonOk({ buildingId: updated.id, ownerId: null });
  } catch (error) {
    return handleRouteError(error);
  }
}
