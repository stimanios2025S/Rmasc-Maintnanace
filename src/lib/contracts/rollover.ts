/**
 * Le traitement de reconduction tacite et d'alertes d'échéance des contrats.
 *
 * POURQUOI CE MODULE EST PARTAGÉ
 * Deux appelants font le même travail : le script `scripts/contracts-rollover.ts`
 * pour un passage manuel ou planifié hors HTTP, et
 * `POST /api/cron/contracts-rollover` pour un planificateur qui ne peut appeler
 * qu'une URL. Écrire la boucle deux fois garantirait qu'une correction n'arrive
 * que dans l'une des deux.
 *
 * LA RECONDUCTION EST ÉCRITE, PAS SEULEMENT CALCULÉE
 * `effectiveEndsAt` repousse la date à la lecture — c'est ce qui empêche un
 * écran d'afficher « échu » sur un contrat reconduit tacitement. Mais une date
 * qui n'existe que dans un calcul ne laisse aucune trace : six mois plus tard,
 * personne ne peut dire quand la reconduction a eu lieu. Ce module matérialise
 * la période en cours et écrit la révision qui l'atteste.
 *
 * L'IDEMPOTENCE EST UNE CONDITION D'ÉCRITURE, PAS UNE INTENTION
 * La mise à jour est un compare-and-swap sur l'ancienne date et le statut
 * `ACTIVE`. Deux passages simultanés — un planificateur et un déclenchement
 * manuel — ne peuvent pas produire deux révisions : le second ne trouve plus la
 * ligne dans l'état qu'il avait lu, et s'arrête.
 *
 * LES ALERTES SONT DÉDOUBLONNÉES PAR TERME ET PAR PALIER
 * Le titre de la notification porte la date de fin effective et le seuil
 * (60 ou 30 jours). C'est ce qui rend le doublon détectable sans colonne
 * supplémentaire, et ce qui permet à la même alerte de repartir l'année
 * suivante sur un nouveau terme.
 *
 * Module serveur : il lit et écrit la base, et parle au transport WhatsApp.
 */

import { prisma } from "@/lib/db/prisma";
import { notifyRoles } from "@/lib/notifications/service";
import {
  adminPhoneNumber,
  isWhatsAppConfigured,
  sendWhatsApp,
} from "@/lib/notifications/whatsapp";
import {
  decisionLevel,
  effectiveEndsAt,
  expiryAlert,
  revisionSummary,
} from "@/lib/contracts/status";
import { MANAGEMENT_ROLES } from "@/types";
import type { ContractRenewalMode, ContractStatus } from "@/types";

// ─── Types du compte rendu ──────────────────────────────────

export interface RenewedContract {
  id: string;
  reference: string;
  clientName: string;
  previousEndsAt: string;
  newEndsAt: string;
}

export interface ExpiryNotice {
  id: string;
  reference: string;
  clientName: string;
  level: "notice" | "urgent";
  days: number;
  endsAt: string;
  /** Une notification existait déjà pour ce terme et ce palier. */
  alreadyNotified: boolean;
  /** Une notification a été demandée dans ce passage. */
  notified: boolean;
}

export interface RolloverOutcome {
  dryRun: boolean;
  ranAt: string;
  renewed: RenewedContract[];
  alerts: ExpiryNotice[];
  whatsapp: {
    attempted: boolean;
    delivered: boolean;
    reason?: string;
  };
}

export interface RolloverOptions {
  /**
   * Ne rien écrire. Les lectures restent réelles : c'est un aperçu de ce que le
   * passage produirait, pas une simulation hors base.
   */
  dryRun?: boolean;
  /** Injectable pour les vérifications : le traitement est daté, pas horloge. */
  now?: Date;
}

interface ContractRow {
  id: string;
  reference: string;
  status: string;
  renewalMode: string;
  startsAt: Date;
  endsAt: Date;
  client: { name: string };
}

/** La forme que les règles pures attendent. */
function dated(contract: ContractRow) {
  return {
    status: contract.status as ContractStatus,
    renewalMode: contract.renewalMode as ContractRenewalMode,
    startsAt: contract.startsAt,
    endsAt: contract.endsAt,
  };
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function frenchDay(date: Date): string {
  return date.toLocaleDateString("fr-FR", { dateStyle: "long" });
}

// ─── 1. Reconductions tacites ───────────────────────────────

/**
 * Repousse la date de fin des contrats `AUTO` actifs arrivés à leur terme.
 *
 * Seuls les contrats `ACTIVE` sont matérialisés. Un contrat `SUSPENDED` est
 * administrativement couvert mais son service est arrêté : repousser sa date
 * en silence reviendrait à reconduire un contrat que personne n'a remis en
 * service. Il reste lisible, et sa date est recalculée à l'affichage comme
 * avant.
 */
async function applyTacitRenewals(
  now: Date,
  dryRun: boolean
): Promise<RenewedContract[]> {
  const candidates = await prisma.contract.findMany({
    where: {
      renewalMode: "AUTO",
      status: "ACTIVE",
      endsAt: { lte: now },
    },
    select: {
      id: true,
      reference: true,
      status: true,
      renewalMode: true,
      startsAt: true,
      endsAt: true,
      client: { select: { name: true } },
    },
    orderBy: { endsAt: "asc" },
  });

  const renewed: RenewedContract[] = [];

  for (const contract of candidates) {
    const newEndsAt = effectiveEndsAt(dated(contract), now);
    if (newEndsAt.getTime() <= contract.endsAt.getTime()) continue;

    const record: RenewedContract = {
      id: contract.id,
      reference: contract.reference,
      clientName: contract.client.name,
      previousEndsAt: contract.endsAt.toISOString(),
      newEndsAt: newEndsAt.toISOString(),
    };

    if (dryRun) {
      renewed.push(record);
      continue;
    }

    /**
     * La phrase du journal est écrite ici, dans la langue du lecteur, comme
     * toutes les révisions : le journal ne se reconstitue pas à l'affichage.
     */
    const summary = `Reconduction tacite — ${revisionSummary(
      "TACIT_RENEWAL",
      { endsAt: contract.endsAt },
      { endsAt: newEndsAt }
    )}`;

    const applied = await prisma.$transaction(async (tx) => {
      // Compare-and-swap : la ligne ne change que si elle est encore dans
      // l'état lu. Un second passage, même simultané, n'écrit rien.
      const claim = await tx.contract.updateMany({
        where: {
          id: contract.id,
          status: "ACTIVE",
          renewalMode: "AUTO",
          endsAt: contract.endsAt,
        },
        data: { endsAt: newEndsAt },
      });
      if (claim.count !== 1) return false;

      await tx.contractRevision.create({
        data: {
          contractId: contract.id,
          kind: "TACIT_RENEWAL",
          summary,
          // Des chaînes, pas des `Date` : le champ est un JSON Prisma, et une
          // date sérialisée là-dedans dépendrait de la couche qui l'écrit.
          before: { endsAt: contract.endsAt.toISOString() },
          after: { endsAt: newEndsAt.toISOString() },
          changedById: null,
        },
      });

      return true;
    });

    if (applied) renewed.push(record);
  }

  return renewed;
}

// ─── 2. Alertes d'échéance ──────────────────────────────────

/**
 * Crée les notifications in-app des contrats entrés dans la fenêtre de préavis.
 *
 * Le palier vient de `decisionLevel` : la file « Décision requise » de l'écran
 * et ce balayage posent donc exactement la même question. Un contrat `NONE` est
 * exclu — le client a renoncé à la reconduction et à l'alerte —, un brouillon
 * aussi, et un contrat échu n'a plus de décision à prendre.
 */
async function sweepExpiryAlerts(
  now: Date,
  dryRun: boolean
): Promise<ExpiryNotice[]> {
  const candidates = await prisma.contract.findMany({
    where: {
      status: { in: ["ACTIVE", "SUSPENDED"] },
      renewalMode: { not: "NONE" },
    },
    select: {
      id: true,
      reference: true,
      status: true,
      renewalMode: true,
      startsAt: true,
      endsAt: true,
      client: { select: { name: true } },
    },
    orderBy: { endsAt: "asc" },
  });

  const notices: ExpiryNotice[] = [];

  for (const contract of candidates) {
    const level = decisionLevel(dated(contract), now);
    if (!level) continue;

    const alert = expiryAlert(dated(contract), now);
    const endsAt = effectiveEndsAt(dated(contract), now);
    const threshold = level === "urgent" ? 30 : 60;
    const linkUrl = `/administration/contrats/${contract.id}`;

    /**
     * Le titre porte le terme et le seuil. C'est la clé de dédoublonnage : sans
     * la date, la même alerte serait considérée comme déjà envoyée l'année
     * suivante ; sans le seuil, l'alerte de 30 jours serait avalée par celle de
     * 60 jours.
     */
    const title = `Contrat ${contract.reference} — préavis ${threshold} jours (terme du ${isoDay(endsAt)})`;

    const existing = await prisma.notification.findFirst({
      where: { title, linkUrl },
      select: { id: true },
    });
    const alreadyNotified = Boolean(existing);

    if (!alreadyNotified && !dryRun) {
      const tacit = contract.renewalMode === "AUTO";
      const days = `${alert.days} jour${alert.days > 1 ? "s" : ""}`;
      await notifyRoles([...MANAGEMENT_ROLES], {
        title,
        message:
          `${contract.client.name} — le contrat ${contract.reference} arrive à ` +
          `échéance le ${frenchDay(endsAt)} (dans ${days}). ` +
          (tacit
            ? "Reconduction tacite prévue : résiliez, renégociez ou passez-le en " +
              "renouvellement manuel avant l'échéance."
            : "Aucune reconduction automatique : décidez du renouvellement ou de l'arrêt."),
        type: "system",
        linkUrl,
      });
    }

    notices.push({
      id: contract.id,
      reference: contract.reference,
      clientName: contract.client.name,
      level,
      days: alert.days,
      endsAt: endsAt.toISOString(),
      alreadyNotified,
      notified: !alreadyNotified && !dryRun,
    });
  }

  return notices;
}

// ─── 3. Le résumé WhatsApp ──────────────────────────────────

/**
 * Le résumé qui part sur le téléphone de l'astreinte, si l'instance existe.
 *
 * Il ne liste que les alertes **nouvelles de ce passage** : renvoyer chaque
 * jour les mêmes échéances produirait un message qu'on apprend à ignorer, ce
 * qui est l'inverse du but. Le message est borné à huit lignes — un résumé qui
 * ne tient pas sur un écran verrouillé n'est pas un résumé.
 *
 * Jamais fatal : `sendWhatsApp` ne lève pas, et le résultat est rapporté tel
 * quel. Les notifications in-app, elles, sont déjà écrites.
 */
async function sendDigest(
  notices: readonly ExpiryNotice[],
  dryRun: boolean
): Promise<RolloverOutcome["whatsapp"]> {
  if (dryRun) {
    return { attempted: false, delivered: false, reason: "dry-run" };
  }

  const fresh = notices.filter((notice) => notice.notified);
  if (fresh.length === 0) {
    return { attempted: false, delivered: false, reason: "no-new-alert" };
  }

  if (!isWhatsAppConfigured()) {
    return { attempted: false, delivered: false, reason: "no-transport" };
  }

  const lines = fresh
    .slice(0, 8)
    .map(
      (notice) =>
        `${notice.reference} — J-${notice.days} (${
          notice.level === "urgent" ? "30 j" : "60 j"
        })`
    );
  if (fresh.length > 8) {
    lines.push(`… et ${fresh.length - 8} autre${fresh.length - 8 > 1 ? "s" : ""}`);
  }

  const result = await sendWhatsApp(
    adminPhoneNumber(),
    [`Échéances contrats — ${fresh.length} à décider`, ...lines].join("\n")
  );

  return {
    attempted: true,
    delivered: result.delivered,
    reason: result.reason,
  };
}

// ─── Point d'entrée ─────────────────────────────────────────

/**
 * Un passage complet : reconductions, puis alertes, puis résumé.
 *
 * L'ordre compte. Les reconductions sont matérialisées avant le balayage, pour
 * que celui-ci lise les dates à jour : un contrat reconduit aujourd'hui ne doit
 * pas déclencher ce soir une alerte sur un terme qui n'existe plus.
 */
export async function runContractsRollover(
  options: RolloverOptions = {}
): Promise<RolloverOutcome> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;

  const renewed = await applyTacitRenewals(now, dryRun);
  const alerts = await sweepExpiryAlerts(now, dryRun);
  const whatsapp = await sendDigest(alerts, dryRun);

  return {
    dryRun,
    ranAt: now.toISOString(),
    renewed,
    alerts,
    whatsapp,
  };
}
