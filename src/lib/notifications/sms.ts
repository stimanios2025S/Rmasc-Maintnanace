/**
 * Out-of-band alerting by SMS.
 *
 * WHAT THIS DOES TODAY — AND WHAT IT DOES NOT
 * There is no SMS gateway wired into this deployment. `sendSms` writes the
 * message it *would* send to the server log, marked as not sent, and returns
 * `{ delivered: false }`. Nothing arrives on anyone's phone.
 *
 * That gap is worth stating in the code rather than leaving to a README, and
 * worth stating loudly, because its failure mode is silent and points the
 * dangerous way: an escalation nobody was told about looks exactly like an
 * escalation that was sent and ignored — right up until somebody asks why
 * they were not informed. So every line this module logs says `NON ENVOYÉ`
 * in capitals, and `logSmsTransport()` runs once at server start so the
 * situation is visible at deploy time rather than during an incident.
 *
 * Quietly pretending was the alternative and was rejected: a feature that
 * reports success while doing nothing is worse than a feature that is absent.
 *
 * WIRING A REAL PROVIDER
 * Replace the body of `deliver` below with the provider call and return
 * `{ delivered: true }` once it accepts the message. Everything above it —
 * recipient resolution, message shaping, the never-throw rule — stays as it
 * is, and every caller starts working without a change. The recipient is
 * `ADMIN_PHONE_NUMBER` in `.env`; see `.env.example`.
 *
 * NEVER THROWS
 * The same rule as `src/lib/notifications/service.ts`, and it matters more
 * here: by the time one of these is called, the incident and its work order
 * are already committed. A gateway timeout must not turn a successful
 * escalation into a 500 that the client's browser shows as a failed report —
 * the reporter would press the button again and raise a second incident.
 */

import { getEnv } from "@/lib/config/env";

// ─── Types ──────────────────────────────────────────────────

export interface SmsResult {
  /** False whenever the message did not leave this process. */
  delivered: boolean;
  /** Why not, when `delivered` is false. */
  reason?: "no-recipient" | "no-transport" | "transport-error";
}

export interface AdminAlertInput {
  /** First line of the text — the part that shows in a lock-screen preview. */
  headline: string;
  /** Body lines, sent in order. Keep it short: this is read on a phone. */
  lines: readonly string[];
}

// ─── Recipient ──────────────────────────────────────────────

/**
 * The on-call number, or null when the deployment has not chosen one.
 *
 * `getEnv` is called in a try/catch rather than at module scope on purpose.
 * It throws when the environment is malformed, and a module-scope call would
 * turn that into a crash at import time — taking down a route that still has
 * a perfectly good in-app notification path available.
 */
function adminPhoneNumber(): string | null {
  try {
    return getEnv().ADMIN_PHONE_NUMBER ?? null;
  } catch {
    return null;
  }
}

/**
 * `+213661234567` becomes `+213•••••4567`.
 *
 * Logs get pasted into chats and tickets. The recipient is a member of staff
 * rather than a customer, so this is not a data-protection requirement — it
 * is that a personal mobile number in a shared log line is noise at best and
 * a leak at worst, and the last four digits carry everything a reader needs
 * to confirm who was texted.
 */
export function maskPhone(number: string): string {
  const trimmed = number.trim();
  if (trimmed.length <= 8) return "••••";
  return `${trimmed.slice(0, 4)}${"•".repeat(
    trimmed.length - 8
  )}${trimmed.slice(-4)}`;
}

// ─── Transport ──────────────────────────────────────────────

/**
 * Hands one message to the transport. **Currently a logging stub.**
 *
 * This is the single function to replace when a provider is chosen — see the
 * module header. It is deliberately the only place in this file that would
 * need to know which provider it is talking to.
 */
async function deliver(to: string, body: string): Promise<SmsResult> {
  const rule = "─".repeat(58);
  console.warn(
    [
      "",
      `┌─ SMS NON ENVOYÉ ${rule}`,
      `│ Destinataire : ${maskPhone(to)}`,
      "│ Motif        : aucun fournisseur SMS n'est configuré",
      "│ Contenu qui aurait été envoyé :",
      ...body.split("\n").map((line) => `│   ${line}`),
      `└${rule}`,
      "",
    ].join("\n")
  );

  return { delivered: false, reason: "no-transport" };
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Sends one text message. Never throws; never claims a success it did not have.
 *
 * The return value is the only thing callers may rely on. Treat
 * `delivered: false` as "nobody was alerted out of band" and decide whether
 * that needs compensating — for escalations the in-app notification to every
 * manager is that compensation, and it is sent regardless.
 */
export async function sendSms(
  to: string | null,
  body: string
): Promise<SmsResult> {
  if (!to || to.trim().length === 0) {
    console.warn(
      "[sms] Aucun destinataire : ADMIN_PHONE_NUMBER n'est pas défini. " +
        "L'alerte n'a été envoyée à personne."
    );
    return { delivered: false, reason: "no-recipient" };
  }

  try {
    return await deliver(to, body);
  } catch (error) {
    // A provider that is down is not a reason to fail the escalation that
    // triggered this. The in-app path has already run by the time we get here.
    console.error("[sms] Échec de l'envoi du message", error);
    return { delivered: false, reason: "transport-error" };
  }
}

/**
 * The escalation alert to the on-call administrator.
 *
 * Kept deliberately terse. This lands on a phone, probably at night, and the
 * reader needs three things from the preview: that it is urgent, which site,
 * and what happened. Everything else is one tap away on the board, so the
 * detail stays on the board and only the bare facts travel.
 */
export async function sendAdminSmsAlert(
  input: AdminAlertInput
): Promise<SmsResult> {
  const body = [`URGENT — ${input.headline}`, ...input.lines].join("\n");
  return sendSms(adminPhoneNumber(), body);
}

// ─── Startup visibility ─────────────────────────────────────

/**
 * Says once, at boot, whether escalations actually reach a phone.
 *
 * Called from `src/lib/db/prisma.ts` — the one module every data-touching
 * route already imports, so a warning placed there has certainly been
 * evaluated before the first escalation can happen.
 */
export function logSmsTransport(): void {
  const recipient = adminPhoneNumber();

  if (!recipient) {
    console.warn(
      "[sms] Alerte SMS DÉSACTIVÉE : ADMIN_PHONE_NUMBER n'est pas défini. " +
        "Les escalades déclencheront uniquement des notifications in-app."
    );
    return;
  }

  console.warn(
    `[sms] Alerte SMS configurée pour ${maskPhone(recipient)}, mais AUCUN ` +
      "fournisseur n'est branché : les messages sont journalisés, pas envoyés. " +
      "Voir src/lib/notifications/sms.ts."
  );
}
