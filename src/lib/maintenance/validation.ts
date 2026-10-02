/**
 * Validation des programmes d'entretien, partagée entre la création et
 * l'édition.
 *
 * Les deux routes doivent s'accorder sur ce qu'est un programme valide, et une
 * règle recopiée dans deux fichiers finit par diverger : celle-ci vit donc ici,
 * et la seule partie qui ne peut pas y vivre — la règle croisée qui a besoin de
 * la valeur *existante* en édition — est écrite comme une fonction pure que les
 * deux appellent.
 */

import { z } from "zod";
import { MaintenanceFrequency } from "@prisma/client";

export const ChecklistItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /**
   * Ce que le point vaut contractuellement. Défaut `true` : un point écrit par
   * le bureau est un point qu'il veut voir contrôlé, et un défaut à `false`
   * ferait disparaître en silence ce qui n'a pas été coché.
   */
  required: z.boolean().default(true),
});

const FrequencySchema = z.nativeEnum(MaintenanceFrequency);

/**
 * Un identifiant de point de contrôle tel que le formulaire le saisit.
 *
 * Le plafond n'est pas décoratif : `checklistItems` est une colonne `Json`, et
 * une liste de dix mille lignes écrite en base rendrait la fiche d'un appareil
 * impossible à ouvrir sans qu'aucune requête n'ait échoué.
 */
const ChecklistSchema = z.array(ChecklistItemSchema).max(100);

const commonFields = {
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(2000).optional(),
  frequency: FrequencySchema,
  cycleThreshold: z.number().int().positive().max(100_000_000).nullable(),
  nextDueDate: z.string().min(1),
  checklistItems: ChecklistSchema,
};

/**
 * Création : tout est requis sauf la description.
 *
 * `nextDueDate` est obligatoire parce qu'un programme sans échéance ne peut
 * jamais apparaître dans la file « à traiter » : il existerait en base sans
 * jamais rien déclencher, ce qui est la façon la plus silencieuse d'oublier un
 * contrat.
 */
export const CreateScheduleSchema = z
  .object({
    elevatorId: z.string().min(1),
    ...commonFields,
  })
  .strict();

/**
 * Édition : tout est facultatif, mais `elevatorId` n'y figure pas.
 *
 * Un programme ne change pas d'appareil. Le déplacer réécrirait le passé : les
 * visites déjà enregistrées contre lui désigneraient soudain une autre machine,
 * et les rapports d'inspection qui citent ce programme ne décriraient plus le
 * même équipement. Pour changer d'appareil, on désactive et on recrée.
 */
export const UpdateScheduleSchema = z
  .object({
    title: commonFields.title.optional(),
    description: commonFields.description.optional(),
    frequency: commonFields.frequency.optional(),
    cycleThreshold: commonFields.cycleThreshold.optional(),
    nextDueDate: commonFields.nextDueDate.optional(),
    checklistItems: commonFields.checklistItems.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

/**
 * La règle qui lie la périodicité au seuil de cycles, ou `null` si tout va
 * bien.
 *
 * Elle est ici et non dans un `.refine()` de schéma parce qu'en édition l'un
 * des deux termes peut ne pas être envoyé : c'est au gestionnaire de composer
 * la valeur *effective* — celle qui sera écrite — à partir du corps et de la
 * ligne existante, puis d'appeler cette fonction. Un `.refine()` sur un
 * `.partial()` ne verrait qu'un des deux et laisserait passer le cas le plus
 * fréquent : changer la seule périodicité.
 *
 * Les deux sens sont refusés, et pour deux raisons différentes :
 *
 *  - « à l'usage » sans seuil n'a aucun sens : sans nombre de cycles de
 *    référence, rien ne peut décider qu'une visite est due, et le programme
 *    resterait à l'écran sous l'étiquette « à l'usage » sans que personne ne
 *    puisse jamais savoir quand intervenir.
 *  - Un seuil sur une périodicité calendaire est un nombre que rien ne lit. Le
 *    garder ferait croire à un contrôle qui n'a pas lieu, et le jour où l'on
 *    basculerait vers « à l'usage », on appliquerait un seuil oublié là depuis
 *    des mois.
 */
export function cyclesRuleViolation(
  frequency: MaintenanceFrequency,
  cycleThreshold: number | null | undefined
): string | null {
  const threshold = cycleThreshold ?? null;

  if (frequency === "BY_USAGE_CYCLES" && threshold === null) {
    return (
      "Une périodicité « à l'usage » exige un nombre de cycles de référence : " +
      "sans lui, aucune visite ne peut jamais être déclarée due."
    );
  }

  if (frequency !== "BY_USAGE_CYCLES" && threshold !== null) {
    return (
      "Le seuil de cycles ne s'applique qu'à une périodicité « à l'usage ». " +
      "Sur une périodicité calendaire, il serait écrit sans être jamais lu."
    );
  }

  return null;
}
