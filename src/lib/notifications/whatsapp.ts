/**
 * Notifications WhatsApp, via Evolution API.
 *
 * CE QUE CE MODULE REMPLACE
 * Il remplace `src/lib/notifications/sms.ts`, qui n'a jamais rien envoyé :
 * aucun fournisseur SMS n'était branché, le module écrivait le message qu'il
 * *aurait* envoyé dans le journal et renvoyait `delivered: false`. Ce fichier
 * l'a remplacé plutôt que de cohabiter avec lui, pour qu'il n'existe qu'un seul
 * endroit où l'on configure un canal externe.
 *
 * LA RÈGLE, ET ELLE VIENT DE LOIN
 * **Ce module ne lève jamais d'exception, et ne prétend jamais avoir livré ce
 * qu'il n'a pas livré.** Les deux moitiés comptent autant l'une que l'autre.
 *
 * Ne pas lever : au moment où l'un de ces appels part, le travail réel —
 * l'affectation, l'escalade — est déjà validé en base. Une passerelle en panne
 * ne doit pas transformer une affectation réussie en erreur 500 que le
 * navigateur affichera comme un échec : le gestionnaire recliquerait, et
 * tomberait sur « modifié par une autre requête ». C'était déjà la doctrine du
 * module SMS, et elle reste.
 *
 * Ne pas mentir : renvoyer `delivered: true` après une panne réseau reviendrait
 * à dire au système que le technicien a été prévenu alors qu'il ne l'a pas été.
 * Personne ne s'en apercevrait avant le jour où il ne se présenterait pas sur
 * le chantier — c'est-à-dire au pire moment possible. L'appelant reçoit donc la
 * vérité (`delivered: false` et la raison), et c'est à lui de décider si cela
 * mérite une compensation ; pour l'affectation d'un bon, la compensation est
 * une notification in-app au responsable. Voir `assignment.ts`.
 *
 * CE QUE ÇA COÛTE, ET POURQUOI C'EST LE BON PRIX
 * Un envoi qui échoue ne bloque rien, mais il ne disparaît pas non plus : la
 * ligne de journal le dit en majuscules et la fiche du bon de travail le garde
 * écrit. C'est plus de code que `return true`, et c'est le seul prix qui
 * n'échange pas une panne silencieuse contre un peu de tranquillité.
 *
 * QUAND RIEN N'EST CONFIGURÉ
 * Un `.env` sans `EVOLUTION_API_URL` / `EVOLUTION_API_KEY` / `EVOLUTION_INSTANCE`
 * est un état normal — l'instance n'est pas encore installée. Le module reste
 * alors parfaitement inerte : il journalise le message qu'il aurait envoyé,
 * renvoie `no-transport`, et surtout il ne fait échouer aucun appelant. Aucune
 * garde à écrire ailleurs ; il n'y a rien à éteindre.
 */

import { getEnv } from "@/lib/config/env";
import { maskPhone, toWhatsAppNumber } from "./phone";

/**
 * Le délai au-delà duquel on considère qu'Evolution ne répondra pas.
 *
 * Dix secondes, et la valeur est un compromis assumé : assez long pour une
 * instance qui démarre ou un réseau mobile lent, assez court pour qu'un appel
 * lancé sans être attendu (voir `assignment.ts`) ne laisse pas une requête
 * pendante pendant une minute. Ce n'est pas un délai d'expérience utilisateur —
 * personne n'attend cet appel — c'est un délai de fuite.
 */
const TIMEOUT_MS = 10_000;

/** Ce que le corps de la réponse d'erreur d'Evolution est autorisé à peser. */
const MAX_DETAIL_CHARS = 300;

/**
 * Pourquoi un message n'est pas parti.
 *
 * Les raisons sont distinctes parce qu'elles demandent des gestes différents :
 * `no-transport` veut dire « remplis `.env` », `no-recipient` veut dire
 * « complète la fiche du technicien », `bad-number` veut dire « ce numéro est
 * mal écrit », `transport-error` veut dire « Evolution est injoignable », et
 * `rejected` veut dire « Evolution a répondu, et il a refusé » — la clé est
 * fausse, ou le numéro n'est pas sur WhatsApp. Les confondre dans un seul
 * « erreur » rendrait la seule information utile inutilisable.
 */
export type WhatsAppFailureReason =
  | "no-transport"
  | "no-recipient"
  | "bad-number"
  | "transport-error"
  | "rejected";

export interface WhatsAppResult {
  delivered: boolean;
  reason?: WhatsAppFailureReason;
  /** Le code HTTP quand Evolution a répondu — absent en cas de panne réseau. */
  status?: number;
  /** Le début de la réponse d'Evolution, pour le diagnostic. Jamais un secret. */
  detail?: string;
}

export interface AdminAlertInput {
  /** Première ligne — la partie qui s'affiche dans un aperçu d'écran verrouillé. */
  headline: string;
  /** Lignes du corps, envoyées dans l'ordre. Courtes : ça se lit sur un téléphone. */
  lines: readonly string[];
}

// ─── Configuration ──────────────────────────────────────────

interface WhatsAppConfig {
  baseUrl?: string;
  apiKey?: string;
  instance?: string;
  defaultCountryCode?: string;
}

/**
 * Lit l'environnement sans jamais lever.
 *
 * `getEnv` lève quand l'environnement est malformé, et un appel au niveau du
 * module transformerait ça en plantage à l'import — emportant une route qui
 * dispose encore d'un chemin de notification in-app parfaitement valable.
 */
function readConfig(): WhatsAppConfig {
  try {
    const env = getEnv();
    return {
      // Un « / » final donnerait « //message/sendText » : Evolution le tolère
      // ou non selon la version. On l'enlève ici, une fois.
      baseUrl: env.EVOLUTION_API_URL?.replace(/\/+$/, ""),
      apiKey: env.EVOLUTION_API_KEY,
      instance: env.EVOLUTION_INSTANCE,
      defaultCountryCode: env.WHATSAPP_DEFAULT_COUNTRY_CODE,
    };
  } catch {
    return {};
  }
}

/** Vrai quand les trois variables qui font fonctionner l'envoi sont présentes. */
export function isWhatsAppConfigured(): boolean {
  const config = readConfig();
  return Boolean(config.baseUrl && config.apiKey && config.instance);
}

/** Le numéro de l'astreinte, ou null si le déploiement n'en a pas choisi. */
export function adminPhoneNumber(): string | null {
  try {
    return getEnv().ADMIN_PHONE_NUMBER ?? null;
  } catch {
    return null;
  }
}

// ─── Journal ────────────────────────────────────────────────

/**
 * Écrit le message qu'on n'a pas envoyé, en majuscules.
 *
 * C'est la seule partie du module SMS qui a été reprise telle quelle, et pour
 * la raison qu'il donnait lui-même : une alerte que personne n'a reçue
 * ressemble exactement à une alerte envoyée et ignorée, jusqu'au jour où
 * quelqu'un demande pourquoi il n'a pas été prévenu. Tant que le message reste
 * dans le journal, il est possible de le lire à voix haute au téléphone.
 */
function warnNotSent(
  to: string | null | undefined,
  text: string,
  cause: string
): void {
  const rule = "─".repeat(58);
  console.warn(
    [
      "",
      `┌─ WHATSAPP NON ENVOYÉ ${rule}`,
      `│ Destinataire : ${to && to.trim() ? maskPhone(to) : "(aucun)"}`,
      `│ Motif        : ${cause}`,
      "│ Contenu qui aurait été envoyé :",
      ...text.split("\n").map((line) => `│   ${line}`),
      `└${rule}`,
      "",
    ].join("\n")
  );
}

/**
 * Le début de la réponse d'Evolution, borné.
 *
 * Borné parce qu'un corps d'erreur peut contenir la requête entière — donc le
 * numéro du destinataire — et qu'un journal n'est pas l'endroit où l'on garde
 * ça en entier. Coupé à 300 caractères, il reste de quoi comprendre.
 */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body.length > MAX_DETAIL_CHARS
      ? `${body.slice(0, MAX_DETAIL_CHARS)}…`
      : body;
  } catch {
    return "(réponse illisible)";
  }
}

// ─── Transport ──────────────────────────────────────────────

/**
 * Envoie un message. **Ne lève jamais, et ne ment jamais.**
 *
 * Le retour est la seule chose sur laquelle un appelant peut s'appuyer :
 * `delivered: true` veut dire qu'Evolution a accepté le message, et rien de
 * plus. Accepter n'est pas remettre — un numéro qui n'est pas sur WhatsApp, ou
 * un téléphone éteint, ne se voient qu'après. Cette distinction n'est pas
 * écrite ici pour être précise : c'est exactement pour cela que la
 * compensation côté responsable existe, et la faire passer pour une remise
 * garantie reviendrait à s'en passer.
 */
export async function sendWhatsApp(
  to: string | null | undefined,
  text: string
): Promise<WhatsAppResult> {
  const config = readConfig();

  if (!config.baseUrl || !config.apiKey || !config.instance) {
    warnNotSent(to, text, "aucune instance Evolution API n'est configurée");
    return { delivered: false, reason: "no-transport" };
  }

  if (!to || to.trim().length === 0) {
    warnNotSent(to, text, "aucun numéro de téléphone enregistré");
    return { delivered: false, reason: "no-recipient" };
  }

  const number = toWhatsAppNumber(to, config.defaultCountryCode);
  if (!number) {
    warnNotSent(
      to,
      text,
      "numéro inutilisable : ni forme internationale, ni pays de rattachement " +
        "déclaré (WHATSAPP_DEFAULT_COUNTRY_CODE)"
    );
    return { delivered: false, reason: "bad-number" };
  }

  try {
    const response = await fetch(
      `${config.baseUrl}/message/sendText/${encodeURIComponent(config.instance)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Evolution authentifie par en-tête, pas par jeton porteur.
          apikey: config.apiKey,
        },
        body: JSON.stringify({ number, text }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      }
    );

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      console.error(
        `[whatsapp] Refusé par Evolution API (${response.status}) pour ` +
          `${maskPhone(number)} : ${detail}`
      );
      return {
        delivered: false,
        reason: "rejected",
        status: response.status,
        detail,
      };
    }

    return { delivered: true };
  } catch (error) {
    // Instance éteinte, réseau coupé, délai dépassé : rien de tout cela n'est
    // une raison d'échouer le travail qui a déclenché l'envoi.
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[whatsapp] Envoi impossible pour ${maskPhone(number)} : ${message}`
    );
    return { delivered: false, reason: "transport-error", detail: message };
  }
}

/**
 * L'alerte d'astreinte au responsable.
 *
 * Volontairement brève. Elle arrive sur un téléphone, probablement la nuit, et
 * son lecteur a besoin de trois choses depuis l'aperçu : que c'est urgent, quel
 * site, et ce qui s'est passé. Le reste est à un geste sur le tableau, donc le
 * détail reste sur le tableau et seuls les faits bruts voyagent.
 */
export async function sendAdminWhatsAppAlert(
  input: AdminAlertInput
): Promise<WhatsAppResult> {
  const body = [`URGENT — ${input.headline}`, ...input.lines].join("\n");
  return sendWhatsApp(adminPhoneNumber(), body);
}

// ─── Visibilité au démarrage ────────────────────────────────

/**
 * Dit une fois, au démarrage, si les messages atteignent vraiment un téléphone.
 *
 * Appelé depuis `src/lib/db/prisma.ts` — le seul module que toute route qui
 * touche aux données importe déjà, donc un avertissement placé là a forcément
 * été évalué avant que le premier envoi puisse avoir lieu.
 */
export function logWhatsAppTransport(): void {
  const config = readConfig();
  const recipient = adminPhoneNumber();

  if (!config.baseUrl || !config.apiKey || !config.instance) {
    console.warn(
      "[whatsapp] Notifications WhatsApp DÉSACTIVÉES : EVOLUTION_API_URL, " +
        "EVOLUTION_API_KEY et EVOLUTION_INSTANCE ne sont pas toutes définies. " +
        "Les messages sont journalisés, pas envoyés. Voir .env.example."
    );
    return;
  }

  console.warn(
    `[whatsapp] Evolution API configurée (instance « ${config.instance} ») — ` +
      "les bons de travail affectés partent vers le téléphone du technicien."
  );

  if (!recipient) {
    console.warn(
      "[whatsapp] ADMIN_PHONE_NUMBER n'est pas défini : les escalades " +
        "d'urgence ne partent vers personne en dehors de l'application."
    );
  }
}
