"use client";

import { CheckCircle2, AlertTriangle, Wrench } from "lucide-react";
import {
  INCIDENT_VALIDATION_LABELS,
  incidentValidation,
} from "@/lib/incidents/progress";
import type { IncidentStatus } from "@/types";

/**
 * The admin board's verdict on how a fault was closed.
 *
 *   green   Résolu par client        the occupant fixed it themselves
 *   red     Non Validé / Escaladé    they could not, and asked for help
 *   blue    Résolu par technicien    we attended and closed it
 *
 * The labels live in `INCIDENT_VALIDATION_LABELS`; this component only decides
 * how they look. Each badge also carries the longer explanation as a `title`,
 * so a dispatcher who wants the reasoning does not have to leave the board.
 */

const PRESENTATION = {
  ok: {
    Icon: CheckCircle2,
    className:
      "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  },
  alert: {
    Icon: AlertTriangle,
    className:
      "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
  },
  neutral: {
    Icon: Wrench,
    className:
      "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300",
  },
} as const;

export function ValidationBadge({
  status,
  locale = "fr",
  size = "default",
}: {
  status: IncidentStatus;
  locale?: "en" | "fr";
  size?: "default" | "compact";
}) {
  const validation = incidentValidation(status);
  const label = INCIDENT_VALIDATION_LABELS[validation];
  const { Icon, className } = PRESENTATION[label.signal];

  return (
    <span
      title={label.title}
      className={`inline-flex items-center gap-1.5 rounded-full border font-semibold ${className} ${
        size === "compact" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs"
      }`}
    >
      <Icon
        className={size === "compact" ? "h-3 w-3" : "h-3.5 w-3.5"}
        aria-hidden="true"
      />
      {locale === "fr" ? label.fr : label.en}
    </span>
  );
}
