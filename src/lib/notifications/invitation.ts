/**
 * L'invitation qui suit l'ouverture d'un accès client.
 *
 * DEUX CANAUX, ET ILS NE SONT PAS ÉGAUX
 * Le WhatsApp part réellement, par la même instance Evolution que les alertes
 * d'astreinte — dès que les trois variables d'environnement sont posées. Le
 * courriel, lui, n'a aucun transport dans ce produit : il n'existe ni SMTP
 * configuré ni client d'envoi, et prétendre le contraire produirait une
 * promesse que rien n'honore. Ce module prépare donc le message *et* un lien
 * `mailto:` que le bureau ouvre d'un clic ; le texte est le même que celui
 * envoyé sur WhatsApp, mot pour mot.
 *
 * POURQUOI LE MOT DE PASSE EST DANS LE MESSAGE
 * C'est la seule occasion où il existe en clair — l'API le renvoie une fois, il
 * n'est stocké nulle part, et le hachage ne se relit pas. Le bureau doit donc
 * le transmettre maintenant, par le canal qui atteint la personne. C'est aussi
 * pourquoi ce module n'écrit jamais le message dans un journal.
 *
 * RIEN ICI N'EST FATAL
 * Comme le reste du pipeline de notification : l'accès est créé et commité avant
 * l'envoi. Un WhatsApp qui ne part pas ne défait pas un compte.
 */

import {
  sendWhatsApp,
  type WhatsAppResult,
} from "@/lib/notifications/whatsapp";

export interface AccessInvitation {
  /** Le nom de la personne invitée. */
  name: string;
  email: string;
  phone: string;
  /** Le mot de passe engendré — en clair, une seule fois. */
  password: string;
  buildingName: string;
  elevatorCode: string;
  /** La qualité déclarée sur la demande : « Syndic », « Propriétaire »… */
  declaredRole: string;
  /** L'adresse de connexion, telle que le déploiement la sert. */
  signInUrl: string;
}

/**
 * Le texte de l'invitation.
 *
 * Court, et il dit les trois choses qu'un nouvel accès demande : où aller, avec
 * quoi se connecter, et à quoi cet accès donne droit. Le nom de l'appareil est
 * dans le message parce que c'est ce qui permet à un syndic de plusieurs
 * immeubles de savoir de quelle machine on parle.
 */
export function invitationMessage(invitation: AccessInvitation): string {
  return [
    `Bonjour ${invitation.name},`,
    "",
    `Vos accès Maintenance RMASC sont ouverts pour ${invitation.buildingName} ` +
      `(appareil ${invitation.elevatorCode}), en qualité de ${invitation.declaredRole}.`,
    "",
    `Adresse : ${invitation.signInUrl}`,
    `E-mail : ${invitation.email}`,
    `Mot de passe : ${invitation.password}`,
    "",
    "Ce mot de passe est provisoire : changez-le après votre première connexion.",
  ].join("\n");
}

export interface InvitationDelivery {
  text: string;
  /** Le lien que le bureau ouvre pour envoyer le message par sa messagerie. */
  mailto: string;
  whatsapp: WhatsAppResult;
}

/**
 * Envoie l'invitation sur WhatsApp, et prépare le courriel.
 *
 * Ne lève jamais — voir `sendWhatsApp`, qui ne lève pas non plus. Le retour dit
 * ce qui est réellement parti, pour que l'écran ne présente pas un envoi
 * manqué comme une remise.
 */
export async function deliverInvitation(
  invitation: AccessInvitation
): Promise<InvitationDelivery> {
  const text = invitationMessage(invitation);

  const whatsapp = await sendWhatsApp(invitation.phone, text);

  const subject = `Vos accès Maintenance RMASC — ${invitation.buildingName}`;
  const mailto = `mailto:${encodeURIComponent(invitation.email)}?subject=${encodeURIComponent(
    subject
  )}&body=${encodeURIComponent(text)}`;

  return { text, mailto, whatsapp };
}
