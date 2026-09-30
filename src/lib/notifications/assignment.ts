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
import { readCoordinates } from "@/lib/geo/geofence";
import { enumLabel } from "@/lib/ui/enum-labels";
import { notifyRoles } from "./service";
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
  type: true,
  reportedLatitude: true,
  reportedLongitude: true,
  elevator: {
    select: {
      elevatorCode: true,
      building: {
        select: {
          name: true,
          address: true,
          latitude: true,
          longitude: true,
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

// ─── Le lien de navigation ──────────────────────────────────

/**
 * Le lien que le technicien touche pour partir vers le chantier.
 *
 * TROIS CAS, DANS CET ORDRE, ET L'ORDRE EST LE FOND DU SUJET
 * Les coordonnées du **bâtiment** d'abord : c'est l'adresse permanente de
 * l'ascenseur, celle vers laquelle on conduit. Les coordonnées de **signalement**
 * ensuite — l'endroit d'où le client a signalé la panne, souvent le même
 * immeuble, et de loin préférable à rien. Une **recherche sur l'adresse** en
 * dernier : elle ne place aucun point, elle ouvre une recherche, ce qui est la
 * seule chose honnête à faire quand on ne sait pas où c'est. Et rien du tout
 * quand il n'y a même pas d'adresse — une ligne vide vaut mieux qu'un lien qui
 * ouvre une carte au hasard.
 *
 * La distinction entre les deux premiers importe peu au technicien qui part
 * travailler, et c'est pour ça qu'ils sont traités de la même façon ici. Elle
 * importe beaucoup à la carte, où les deux ne sont jamais confondus — voir le
 * commentaire de `reportedLatitude` dans `prisma/schema.prisma`.
 */
function navigationLine(order: AssignmentOrder): string | null {
  const building = order.elevator.building;

  const site = readCoordinates(building);
  if (site) {
    return (
      "Itinéraire : https://www.google.com/maps/dir/?api=1&destination=" +
      `${site.latitude},${site.longitude}`
    );
  }

  const reported = readCoordinates({
    latitude: order.reportedLatitude,
    longitude: order.reportedLongitude,
  });
  if (reported) {
    return (
      "Itinéraire : https://www.google.com/maps/dir/?api=1&destination=" +
      `${reported.latitude},${reported.longitude}`
    );
  }

  const address = building.address?.trim();
  if (address) {
    return (
      "Rechercher l'adresse : https://www.google.com/maps/search/?api=1&query=" +
      encodeURIComponent(`${address}, ${building.name}`)
    );
  }

  return null;
}

/**
 * Le lien vers le portail, quand il pointe quelque part d'utile.
 *
 * Omis sur `localhost` : en développement, `NEXTAUTH_URL` vaut
 * `http://localhost:3000`, et un lien qui promet d'ouvrir l'application sur un
 * téléphone pour n'ouvrir rien est pire que pas de lien. En production c'est
 * l'adresse publique du tunnel, et là il est vraiment utile.
 */
function portalLine(): string | null {
  const raw = process.env.NEXTAUTH_URL?.trim();
  if (!raw) return null;
  if (/localhost|127\.0\.0\.1|\[::1\]/i.test(raw)) return null;
  return `Application : ${raw.replace(/\/+$/, "")}/technicien`;
}

// ─── Le message ─────────────────────────────────────────────

/**
 * Le texte envoyé au technicien.
 *
 * Exporté pour être lisible et testable sans envoyer quoi que ce soit — c'est
 * la seule partie de cette chaîne qu'on peut vérifier avec certitude avant
 * qu'Evolution soit installée, et c'est celle qui compte pour celui qui la lit.
 */
export function assignmentMessage(order: AssignmentOrder): string {
  const building = order.elevator.building;
  const lines: string[] = [];

  lines.push(`NOUVEAU BON DE TRAVAIL — ${order.orderNumber}`);
  lines.push(`Intervention : ${enumLabel(order.type)}`);
  lines.push("");
  lines.push(`${order.elevator.elevatorCode} — ${building.name}`);
  if (building.address?.trim()) lines.push(building.address.trim());
  lines.push(`Objet : ${order.title}`);

  const navigation = navigationLine(order);
  if (navigation) {
    lines.push("");
    lines.push(navigation);
  }

  /**
   * Le problème, tel que le client l'a raconté.
   *
   * Ses mots d'abord, parce que « ça fait un bruit bizarre au 4e » situe mieux
   * un technicien que n'importe quelle reformulation. Le code affiché par
   * l'armoire ensuite, quand il y en a un : c'est ce qui transforme une
   * description en diagnostic.
   *
   * Quand il n'y a pas d'incident à l'origine du bon — une visite préventive,
   * par exemple — c'est la description du bon qui prend la place. Et quand il
   * n'y a rien du tout, on le dit : un technicien qui sait qu'il ne sait rien
   * appelle avant de partir, ce qui est exactement ce qu'on veut.
   */
  const problemBlock: string[] = [];
  if (order.incident) {
    if (order.incident.errorCode) {
      problemBlock.push(
        `Code affiché : ${order.incident.errorCode.code} — ${order.incident.errorCode.title}`
      );
    }
    problemBlock.push(
      order.incident.notes?.trim()
        ? `Signalé par le client : ${order.incident.notes.trim()}`
        : "Signalé par le client : aucune description fournie — appelez-le avant de partir."
    );
    problemBlock.push(`Incident : ${order.incident.incidentNumber}`);
  } else if (order.description?.trim()) {
    problemBlock.push(`Description : ${order.description.trim()}`);
  } else {
    problemBlock.push("Aucune description fournie pour ce bon.");
  }

  lines.push("");
  lines.push(...problemBlock);

  const portal = portalLine();
  if (portal) {
    lines.push("");
    lines.push(portal);
  }

  return lines.join("\n");
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
