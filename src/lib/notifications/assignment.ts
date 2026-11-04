/**
 * Le message WhatsApp envoyé au technicien quand un bon lui est affecté.
 *
 * CE QU'IL CONTIENT, ET POURQUOI CES TROIS CHOSES-LÀ
 * Le numéro du bon et le type d'intervention — de quoi savoir de quoi on parle
 * et de quelle nature est le travail. L'adresse du chantier et un lien de
 * navigation — de quoi y aller sans recopier une adresse dans une autre
 * application. Le problème signalé par le client — de quoi partir avec la
 * bonne pièce plutôt que de faire l'aller-retour. C'est tout, et c'est
 * délibérément tout : un message plus long se lit moins bien sur un téléphone
 * tenu à une main, dans une cage d'ascenseur, et le reste est dans l'application.
 *
 * LE MESSAGE EST CONSTRUIT ICI, PAS DANS LE TRANSPORT
 * `whatsapp.ts` ne sait pas ce qu'est un bon de travail et ne doit jamais
 * l'apprendre : il reçoit un numéro et un texte. Tout ce qui a un avis sur le
 * contenu — les libellés français, l'ordre des lignes, le choix du lien de
 * navigation — vit dans ce fichier, pour qu'on puisse changer le message sans
 * toucher à la plomberie.
 *
 * L'ENVOI NE BLOQUE JAMAIS L'AFFECTATION
 * `notifyTechnicianOfWorkOrderInBackground` est ce que les routes appellent
 * réellement. L'affectation est déjà validée en base quand elle part, le
 * gestionnaire a déjà sa réponse, et rien de ce qui se passe ensuite ne peut
 * la défaire.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { enumLabel } from "@/lib/ui/enum-labels";
import { notify, notifyRoles } from "./service";
import {
  sendWhatsApp,
  type WhatsAppFailureReason,
  type WhatsAppResult,
} from "./whatsapp";

/**
 * Tout ce dont le message a besoin, et rien de plus.
 *
 * Une sélection explicite plutôt qu'un `include` complet : ce message part vers
 * un téléphone, et un `include` qui s'élargit un jour emporterait des champs
 * dont personne n'a décidé qu'ils devaient sortir de la base.
 */
const ASSIGNMENT_SELECT = {
  id: true,
  orderNumber: true,
  title: true,
  description: true,
  interventionAddress: true,
  type: true,
  priority: true,
  elevator: {
    select: {
      elevatorCode: true,
      installationLocation: true,
      building: {
        select: {
          name: true,
          address: true,
          city: true,
          accessCode: true,
        },
      },
    },
  },
  incident: {
    select: {
      incidentNumber: true,
      notes: true,
      errorCode: { select: { code: true, title: true } },
    },
  },
  assignedTo: { select: { id: true, name: true, phone: true } },
} satisfies Prisma.WorkOrderSelect;

export type AssignmentOrder = Prisma.WorkOrderGetPayload<{
  select: typeof ASSIGNMENT_SELECT;
}>;

export interface AssignmentNoticeOutcome {
  /** Faux quand il n'y avait rien à faire, ou quand la lecture a échoué. */
  attempted: boolean;
  /** Vrai seulement si Evolution a accepté le message. */
  delivered: boolean;
  reason?: WhatsAppFailureReason;
}

// ─── Le message ─────────────────────────────────────────────

/**
 * Le texte envoyé au technicien — miroir exact de la carte de la cloche.
 *
 * Les deux surfaces lisent les mêmes trois champs (priorité, site + code,
 * signalement) et doivent dire la même chose : une alerte qui annonce « URGENT »
 * dans l'application et un message WhatsApp qui commence par « NOUVELLE MISSION »
 * apprennent au technicien à ne plus faire confiance à l'une des deux.
 *
 * Le gras est écrit avec les astérisques simples de WhatsApp (`*texte*`), pas
 * avec le `**` du markdown : le second s'affiche littéralement sur un téléphone.
 *
 * Exporté pour être lisible et testable sans envoyer quoi que ce soit.
 */
export function assignmentMessage(order: AssignmentOrder): string {
  const building = order.elevator.building;
  const priority = order.priority;
  const urgent =
    priority === "CRITICAL" ||
    priority === "HIGH" ||
    priority === "EMERGENCY";
  const light = urgent ? "🔴" : priority === "MEDIUM" ? "🟠" : "🟢";

  /**
   * Le motif, dans l'ordre où la cloche le choisit : les mots du client
   * d'abord, la description du bon ensuite, l'objet en dernier recours.
   */
  const description =
    order.incident?.notes?.trim() ||
    order.description?.trim() ||
    order.title;

  /**
   * Le lieu exact, avec l'adresse du site en repli.
   *
   * Sur un bon ancien, ou créé par le moteur préventif sans complément, la
   * seule adresse connue est celle de l'immeuble. On ne laisse jamais une
   * ligne vide : le technicien doit pouvoir partir avec ce message seul.
   */
  const location =
    order.interventionAddress?.trim() ||
    [building.address, building.city, order.elevator.installationLocation]
      .filter(Boolean)
      .join(", ");

  const base = (
    process.env.NEXTAUTH_URL?.trim() || "http://localhost:3000"
  ).replace(/\/+$/, "");

  return [
    urgent
      ? "🚨 *[URGENT] NOUVELLE MISSION ASSIGNÉE*"
      : "📋 *NOUVELLE MISSION ASSIGNÉE*",
    `${light} *Priorité :* ${enumLabel(priority)}`,
    `🏢 *Site :* ${building.name} - ${building.address}`,
    `📍 *Lieu exact :* ${location}`,
    `🔑 *Code d'accès :* ${building.accessCode?.trim() || "Non communiqué"}`,
    `📋 *Signalement :* ${description}`,
    `📲 *Ouvrir le bon :* ${base}/technicien`,
  ].join("\n");
}

// ─── L'envoi ────────────────────────────────────────────────

/**
 * Écrit le résultat de l'envoi sur le bon de travail.
 *
 * C'est ce qui rend la panne visible côté responsable, et c'est la moitié du
 * marché passé avec l'option « delivered: true » qu'on n'a pas retenue : le
 * système ne bloque pas, mais l'échec laisse une trace datée que quelqu'un
 * finira par lire.
 *
 * `whatsappDeliveredAt` remis à `null` à chaque échec, jamais laissé à sa
 * valeur précédente : après une réaffectation, un ancien succès ne doit pas
 * faire passer un nouvel échec pour une remise réussie.
 */
async function recordOutcome(
  orderId: string,
  result: WhatsAppResult
): Promise<void> {
  try {
    const now = new Date();
    await prisma.workOrder.update({
      where: { id: orderId },
      data: {
        whatsappAttemptedAt: now,
        whatsappDeliveredAt: result.delivered ? now : null,
        whatsappFailure: result.delivered
          ? null
          : (result.reason ?? "transport-error"),
      },
    });
  } catch (error) {
    console.error(
      `[whatsapp] Résultat d'envoi non enregistré pour le bon ${orderId}`,
      error
    );
  }
}

/**
 * Prévient les responsables qu'un technicien n'a pas pu être joint.
 *
 * Seulement quand le numéro manque ou est inutilisable — c'est-à-dire quand
 * aucun envoi n'aurait pu aboutir, quoi qu'il arrive. Une panne d'Evolution
 * n'appelle *pas* cette alerte : elle est déjà écrite sur la fiche du bon, et
 * prévenir le responsable à chaque hoquet réseau ferait de la seule alerte qui
 * compte une alerte parmi d'autres.
 */
async function alertManagers(
  order: AssignmentOrder,
  reason: WhatsAppFailureReason
): Promise<void> {
  const technician = order.assignedTo;
  if (!technician) return;

  const cause =
    reason === "bad-number"
      ? "son numéro n'est pas en forme internationale (il manque l'indicatif du pays)"
      : "sa fiche ne contient aucun numéro de téléphone";

  await notifyRoles(["ADMIN", "MAINTENANCE_MANAGER"], {
    title: `WhatsApp non envoyé — ${technician.name}`,
    message:
      `${technician.name} n'a pas été prévenu du bon ${order.orderNumber} : ` +
      `${cause}. Appelez-le pour lui donner l'intervention.`,
    type: "work_order",
    linkUrl: "/bons-de-travail",
  });
}

/**
 * Envoie le bon au technicien et enregistre ce qui s'est passé. **Ne lève jamais.**
 *
 * Rend le résultat plutôt que de le journaliser seulement, pour qu'un appelant
 * qui veut le montrer — un écran d'administration, un script — puisse le faire.
 */
export async function notifyTechnicianOfWorkOrder(
  workOrderId: string
): Promise<AssignmentNoticeOutcome> {
  try {
    const order = await prisma.workOrder.findUnique({
      where: { id: workOrderId },
      select: ASSIGNMENT_SELECT,
    });

    // Pas de bon, ou pas d'affectation : il n'y a personne à prévenir. Ce n'est
    // pas une erreur — la route de réaffectation appelle cette fonction même
    // quand on lui retire un technicien.
    if (!order?.assignedTo) {
      return { attempted: false, delivered: false };
    }

    /**
     * La notification in-app, écrite avant l'envoi WhatsApp.
     *
     * C'est elle qui alimente la cloche du portail terrain et le badge des
     * affectations ; le message WhatsApp n'est qu'un doublon hors application.
     * L'écrire en premier garantit qu'une passerelle muette ne laisse pas le
     * technicien sans rien — `notify` ne lève jamais.
     */
    await notify({
      userId: order.assignedTo.id,
      title: `Nouvelle intervention — ${order.orderNumber}`,
      message: `${order.elevator.elevatorCode} · ${order.elevator.building.name} — ${order.title}`,
      type: "ASSIGNMENT",
      linkUrl: "/technicien",
      workOrderId: order.id,
    });

    const result = await sendWhatsApp(
      order.assignedTo.phone,
      assignmentMessage(order)
    );

    await recordOutcome(order.id, result);

    if (result.reason === "no-recipient" || result.reason === "bad-number") {
      await alertManagers(order, result.reason);
    }

    return {
      attempted: true,
      delivered: result.delivered,
      reason: result.reason,
    };
  } catch (error) {
    console.error(
      `[whatsapp] Notification impossible pour le bon de travail ${workOrderId}`,
      error
    );
    return { attempted: false, delivered: false };
  }
}

/**
 * La même chose, mais l'appelant ne l'attend pas.
 *
 * C'EST CE QUE LES ROUTES APPELLENT, ET C'EST UN CHOIX
 * Attendre l'envoi ferait patienter le gestionnaire devant le bouton
 * « Affecter » pendant tout le délai d'Evolution — jusqu'à dix secondes quand
 * l'instance est éteinte, c'est-à-dire précisément les jours où il est déjà
 * pressé. Or il n'attend rien de cet envoi : l'affectation est enregistrée, le
 * technicien a sa notification dans l'application, et le message WhatsApp est
 * un confort en plus. Le faire attendre serait payer une panne réseau avec son
 * temps, pour une information qu'il n'a pas demandée.
 *
 * Le processus serveur (pm2, `next start`) reste vivant après la réponse, donc
 * la promesse lâchée ici va jusqu'au bout — l'enregistrement du résultat sur le
 * bon de travail compris.
 */
export function notifyTechnicianOfWorkOrderInBackground(
  workOrderId: string
): void {
  void notifyTechnicianOfWorkOrder(workOrderId).catch((error) => {
    // `notifyTechnicianOfWorkOrder` ne lève pas. Cette garde existe pour qu'une
    // erreur de programmation devienne une ligne de journal plutôt qu'un rejet
    // non capturé qui ferait tomber le processus.
    console.error(
      `[whatsapp] Tâche de fond interrompue pour le bon ${workOrderId}`,
      error
    );
  });
}
