/**
 * La complétion d'une fiche technique par l'équipe de maintenance.
 *
 * PATCH /api/technical-sheets/[id]
 *
 * POURQUOI CETTE ROUTE EXISTE
 * La fiche arrive du client avec quatre champs ; le reste se relève en machine.
 * Jusqu'ici l'écran était volontairement en lecture seule, et les colonnes
 * techniques se complétaient sur papier. Le tableau doit maintenant permettre
 * au technicien de les saisir au retour de visite — sans quoi la fiche reste
 * éternellement « incomplète » dans l'application.
 *
 * CE QUI EST MODIFIABLE, ET CE QUI NE L'EST PAS
 * Seuls les champs *optionnels* du catalogue sont acceptés. Les quatre champs
 * obligatoires viennent du client : les réécrire depuis un bureau effacerait sa
 * déclaration sans trace. `OPTIONAL_FIELD_NAMES` est la même liste que celle
 * qui construit le formulaire, donc aucune colonne ne peut être oubliée ici.
 *
 * RÉSERVÉ AU PERSONNEL
 * Un compte client n'écrit pas dans la fiche technique : c'est le compte rendu
 * de la visite, pas une déclaration. La route demande un rôle OPS.
 */

import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import {
  handleRouteError,
  jsonOk,
  notFound,
  readJson,
} from "@/lib/api/http";
import { OPS_ROLES, requireRole } from "@/lib/api/guard";
import {
  EDITABLE_FIELD_NAMES,
  isRequiredField,
} from "@/lib/technical-sheets/fields";
import { shouldServeDemoData, warnDemoFallbackOnce } from "@/lib/demo/mode";

export const dynamic = "force-dynamic";

/**
 * Un champ optionnel, tel que le formulaire l'envoie.
 *
 * Une chaîne vide vaut « non renseigné » et sera écrite `NULL` : sans cela,
 * effacer un champ le distinguerait mal de « jamais demandé ».
 */
const shape: Record<string, z.ZodTypeAny> = {};
for (const name of EDITABLE_FIELD_NAMES) {
  shape[name] = z.string().trim().max(300).optional();
}

const UpdateSheetSchema = z.object(shape).strict();

const SHEET_INCLUDE = {
  client: { select: { id: true, name: true, email: true, phone: true } },
  elevator: {
    select: {
      id: true,
      elevatorCode: true,
      model: true,
      building: { select: { id: true, name: true, city: true } },
    },
  },
} as const;

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  let parsed: Record<string, string | undefined> | null = null;

  try {
    await requireRole(...OPS_ROLES);

    parsed = UpdateSheetSchema.parse(
      await readJson(request)
    ) as Record<string, string | undefined>;

    const existing = await prisma.technicalSheet.findUnique({
      where: { id: params.id },
      select: { id: true },
    });
    if (!existing) {
      throw notFound(`Fiche technique introuvable : ${params.id}`);
    }

    const data: Record<string, string | null> = {};
    for (const name of EDITABLE_FIELD_NAMES) {
      if (!(name in parsed)) continue;
      const value = parsed[name];
      const trimmed =
        typeof value === "string" && value.trim().length > 0
          ? value.trim()
          : "";
      /**
       * Une valeur obligatoire laissée vide ne s'efface pas : la colonne est
       * NOT NULL, et une fiche sans charge ni nombre de niveaux n'est plus une
       * fiche technique. On ignore simplement la case vide, en laissant la
       * valeur existante intacte.
       */
      if (isRequiredField(name) && trimmed.length === 0) continue;
      data[name] = trimmed.length > 0 ? trimmed : null;
    }

    const sheet = await prisma.technicalSheet.update({
      where: { id: params.id },
      data: data as Prisma.TechnicalSheetUpdateInput,
      include: SHEET_INCLUDE,
    });

    return jsonOk({ sheet });
  } catch (error) {
    /**
     * Mode démonstration : les valeurs sont acquittées, pas écrites.
     *
     * L'écran fusionne la réponse dans sa ligne locale et affiche le message ;
     * un rechargement ramènerait la fixture intacte.
     */
    if (parsed && shouldServeDemoData(error)) {
      warnDemoFallbackOnce("PATCH /api/technical-sheets/[id]");
      const values: Record<string, string | null> = {};
      for (const name of EDITABLE_FIELD_NAMES) {
        if (!(name in parsed)) continue;
        const value = parsed[name];
        const trimmed =
          typeof value === "string" && value.trim().length > 0
            ? value.trim()
            : "";
        if (isRequiredField(name) && trimmed.length === 0) continue;
        values[name] = trimmed.length > 0 ? trimmed : null;
      }
      return NextResponse.json({
        data: { sheet: { id: params.id, ...values } },
        demo: true,
      });
    }

    return handleRouteError(error);
  }
}
