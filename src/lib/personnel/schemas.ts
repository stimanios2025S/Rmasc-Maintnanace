/**
 * Schémas et règles de la gestion du personnel.
 *
 * Partagés entre la création, l'édition et la génération d'accès, pour que les
 * trois ne puissent pas diverger sur ce qu'est une fiche salarié valide.
 *
 * LES VOCABULAIRES VIENNENT DE `@/types`, ET PAS DU SCHÉMA PRISMA
 * `STAFF_ROLES`, `SETTABLE_TECHNICIAN_STATUSES` et `TECHNICIAN_SKILLS` sont
 * déclarés dans `@/types`, avec les autres regroupements de rôles et d'états.
 * Ce n'est pas un rangement : ce module est importé par l'écran qui affiche les
 * sélecteurs, et un composant client ne peut pas importer `@prisma/client` sans
 * en tirer tout le moteur dans le bundle du navigateur. Une définition unique,
 * lisible des deux côtés, était la seule façon d'éviter soit une duplication,
 * soit un paquet inutile livré au client.
 */

import { z } from "zod";
import {
  SETTABLE_TECHNICIAN_STATUSES,
  STAFF_ROLES,
  TECHNICIAN_SKILLS,
} from "@/types";

/** Le nom, commun aux deux formulaires. */
const nameField = z.string().trim().min(2).max(120);

/** L'adresse électronique, normalisée en minuscules — l'unicité en base l'est. */
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email("Adresse électronique invalide.")
  .max(200);

/** Le secteur, libre et facultatif. Voir la note sur `defaultZone` au schéma. */
const zoneField = z.string().trim().max(120);

const specialtiesField = z.array(z.enum(TECHNICIAN_SKILLS)).max(10);

export const CreateStaffSchema = z
  .object({
    name: nameField,
    email: emailField,
    phone: z.string().trim().max(40),
    role: z.enum(STAFF_ROLES),
    specialties: specialtiesField.default([]),
    defaultZone: zoneField.optional(),
  })
  .strict();

/**
 * Édition : tout est facultatif.
 *
 * Le rôle en fait partie, parce que le formulaire d'édition en porte un — et
 * qu'une seconde route dédiée au seul rôle aurait obligé l'écran à deux
 * enregistrements pour une fiche. Les gardes qui l'entourent ne sont pas dans
 * ce schéma pour autant : elles ont besoin de la session et de la base (quel
 * compte est modifié, combien d'administrateurs restent), et vivent donc dans
 * le gestionnaire de route.
 */
export const UpdateStaffSchema = z
  .object({
    name: nameField.optional(),
    email: emailField.optional(),
    phone: z.string().trim().max(40).optional(),
    role: z.enum(STAFF_ROLES).optional(),
    isActive: z.boolean().optional(),
    status: z.enum(SETTABLE_TECHNICIAN_STATUSES).optional(),
    specialties: specialtiesField.optional(),
    defaultZone: z.string().trim().max(120).nullable().optional(),
  })
  .strict();

/**
 * Normalise un numéro de téléphone, et refuse ce que rien ne pourra joindre.
 *
 * LA RÈGLE EST CELLE DU TRANSPORT, PAS UNE PRÉFÉRENCE DE FORME
 * `src/lib/notifications/whatsapp.ts` passe le numéro au fournisseur *tel
 * qu'il est écrit*. Un « 0661234567 » ne veut rien dire sans pays, et
 * l'envoyer quand même, c'est livrer le message à un inconnu. La seule
 * exception est le réglage `WHATSAPP_DEFAULT_COUNTRY_CODE`, qui complète
 * justement les numéros écrits à la locale : quand il est défini, un numéro
 * local redevient joignable, et le refuser ici bloquerait un cas que le
 * transport sait traiter.
 *
 * Autrement dit : cette fonction refuse exactement ce que le transport
 * refusera, et accepte exactement ce qu'il saura envoyer. Un numéro qui passe
 * ici ne produira pas un `bad-number` trois semaines plus tard, au moment où
 * personne ne regarde.
 *
 * Le vide est accepté et rend `null` : un technicien sans téléphone est un état
 * normal, pas une fiche incomplète.
 */
export function normalisePhone(
  raw: string
): { ok: true; phone: string | null } | { ok: false; message: string } {
  // Espaces, points, tirets et parenthèses sont des façons d'écrire un numéro,
  // pas des caractères du numéro. Le ` ` est l'espace insécable qu'un
  // copier-coller depuis un document apporte souvent sans qu'on le voie.
  const compact = raw.replace(/[\s.\-() ]/g, "");

  if (compact === "") return { ok: true, phone: null };

  if (/^\+[1-9]\d{6,14}$/.test(compact)) {
    return { ok: true, phone: compact };
  }

  const countryCode = process.env.WHATSAPP_DEFAULT_COUNTRY_CODE;
  if (countryCode && /^\d{6,15}$/.test(compact)) {
    return { ok: true, phone: compact };
  }

  return {
    ok: false,
    message:
      `Numéro inexploitable : « ${raw} ». Écrivez-le en forme internationale, ` +
      "par exemple +213661234567 — les notifications WhatsApp transmettent le " +
      "numéro tel quel, et une suite de chiffres sans pays ne peut être livrée " +
      "à personne. Laissez vide si ce salarié n'a pas de mobile.",
  };
}
