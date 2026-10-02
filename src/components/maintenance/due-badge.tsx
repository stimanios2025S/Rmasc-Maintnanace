"use client";

import { AlertTriangle, CalendarClock, CirclePause, Clock, Gauge } from "lucide-react";
import { dueFor, type ScheduleDue } from "@/lib/maintenance/schedule";
import type { MaintenanceFrequency } from "@prisma/client";

/**
 * Ce qu'une échéance veut dire, décidé une seule fois.
 *
 * Deux écrans affichent des programmes d'entretien — le tableau du bureau et la
 * fiche de l'appareil — et si chacun décidait de son côté ce qu'est « en
 * retard », ils finiraient par se contredire sur la même ligne. Le verdict est
 * donc calculé ici, et nulle part ailleurs.
 *
 * L'ordre des tests compte. Un programme suspendu dont la date est dépassée
 * n'est pas en retard : personne ne l'a planifié, c'est une décision. Un
 * programme dont la visite est déjà planifiée n'est pas en retard non plus,
 * même si le bon n'a pas encore été ouvert sur le terrain — le bureau a fait
 * son travail, et l'afficher en rouge apprendrait à ignorer le rouge.
 */

export type ScheduleBucket =
  | "late"
  | "soon"
  | "planned"
  | "upcoming"
  | "by-usage"
  | "inactive";

export function bucketOf(
  schedule: {
    frequency: MaintenanceFrequency;
    nextDueDate: string;
    isActive: boolean;
  },
  hasActiveWorkOrder: boolean,
  now: Date
): { bucket: ScheduleBucket; due: ScheduleDue } {
  const due = dueFor(schedule.frequency, new Date(schedule.nextDueDate), now);

  if (!schedule.isActive) return { bucket: "inactive", due };
  if (hasActiveWorkOrder) return { bucket: "planned", due };
  if (due.kind === "overdue") return { bucket: "late", due };
  if (due.kind === "due-soon") return { bucket: "soon", due };
  if (due.kind === "by-usage") return { bucket: "by-usage", due };
  return { bucket: "upcoming", due };
}

/** La classe de bordure qui va avec l'état, pour colorer toute la carte. */
export const BUCKET_CARD_STYLES: Record<ScheduleBucket, string> = {
  late: "border-red-300 bg-red-50/60 dark:border-red-900 dark:bg-red-950/20",
  soon: "border-amber-300 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20",
  planned: "border-blue-200 dark:border-blue-900",
  upcoming: "border-gray-200 dark:border-gray-800",
  "by-usage": "border-gray-200 dark:border-gray-800",
  inactive: "border-dashed border-gray-300 dark:border-gray-700 opacity-75",
};

/**
 * La phrase que porte l'échéance.
 *
 * Chaque état a la sienne et ils ne se remplacent pas : « en retard de 6 jours »
 * est un ordre de travail, « dans 12 jours » une information, et « selon
 * l'usage » dit qu'aucune date n'a été calculée. Cette dernière ne doit jamais
 * devenir un nombre — c'est tout l'objet de `dueFor`.
 */
export function DueBadge({
  bucket,
  due,
  isActive,
  cycleThreshold,
}: {
  bucket: ScheduleBucket;
  due: ScheduleDue;
  isActive: boolean;
  cycleThreshold: number | null;
}) {
  if (!isActive) {
    return (
      <Chip tone="muted" icon={CirclePause} label="Suspendu" />
    );
  }

  if (due.kind === "by-usage") {
    return (
      <Chip
        tone="slate"
        icon={Gauge}
        label={
          cycleThreshold
            ? `Selon l'usage · ${cycleThreshold.toLocaleString("fr-FR")} cycles`
            : "Selon l'usage"
        }
      />
    );
  }

  if (bucket === "planned") {
    return <Chip tone="blue" icon={CalendarClock} label="Planifiée" />;
  }

  if (due.kind === "overdue") {
    return (
      <Chip
        tone="red"
        icon={AlertTriangle}
        label={`En retard de ${due.days} ${due.days > 1 ? "jours" : "jour"}`}
      />
    );
  }

  if (due.kind === "due-soon") {
    return (
      <Chip
        tone="amber"
        icon={Clock}
        label={`Dans ${due.days} ${due.days > 1 ? "jours" : "jour"}`}
      />
    );
  }

  // « scheduled » : le dernier cas qui reste une fois les autres traités.
  return (
    <Chip
      tone="muted"
      icon={Clock}
      label={`Dans ${due.days} ${due.days > 1 ? "jours" : "jour"}`}
    />
  );
}

const TONES = {
  red: "bg-red-600 text-white",
  amber:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  slate:
    "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  muted:
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
} as const;

function Chip({
  tone,
  icon: Icon,
  label,
}: {
  tone: keyof typeof TONES;
  icon: typeof Clock;
  label: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TONES[tone]}`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}
