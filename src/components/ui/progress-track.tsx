"use client";

import { incidentProgress, incidentStageTrack } from "@/lib/incidents/progress";
import type { IncidentStatus } from "@/types";

/**
 * The four-stage incident progress bar.
 *
 * Reaches into `src/lib/incidents/progress.ts` for both the percentage and
 * the stop list, so the bar, the badge and the API can never disagree about
 * how far along a fault is. The component holds no mapping of its own.
 *
 * A self-resolved incident is drawn with its middle stops *hollow* rather
 * than filled. It reaches 100% without a technician ever being involved, and
 * a bar that filled through "Technician assigned" would claim work that never
 * happened.
 */

const TONE = {
  ok: {
    fill: "bg-emerald-500",
    dot: "bg-emerald-500 border-emerald-500",
    label: "text-emerald-700 dark:text-emerald-400",
  },
  alert: {
    fill: "bg-amber-500",
    dot: "bg-amber-500 border-amber-500",
    label: "text-amber-700 dark:text-amber-400",
  },
  neutral: {
    fill: "bg-blue-600",
    dot: "bg-blue-600 border-blue-600",
    label: "text-blue-700 dark:text-blue-400",
  },
} as const;

export function ProgressTrack({
  status,
  locale = "fr",
  showLabels = true,
  className = "",
}: {
  status: IncidentStatus;
  /** Which label set to render. `fr` is the client portal's default. */
  locale?: "en" | "fr";
  showLabels?: boolean;
  className?: string;
}) {
  const { percent, stageNumber, validation } = incidentProgress(status);
  const stops = incidentStageTrack(status);
  const tone = TONE[validation === "escalated" ? "alert" : validation === "validated" ? "ok" : "neutral"];

  return (
    <div className={className}>
      <div className="flex items-center gap-3">
        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={
            locale === "fr"
              ? `Progression : étape ${stageNumber} sur 4`
              : `Progress: step ${stageNumber} of 4`
          }
          className="h-2 flex-1 rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden"
        >
          <div
            className={`h-full rounded-full transition-[width] duration-500 ${tone.fill}`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="text-xs font-semibold tabular-nums text-gray-500 dark:text-gray-400 w-10 text-right">
          {percent}%
        </span>
      </div>

      {showLabels && (
        <ol className="mt-2 flex justify-between gap-1">
          {stops.map((stop) => (
            <li
              key={stop.key}
              className="flex flex-1 flex-col items-center gap-1 text-center"
            >
              <span
                aria-hidden="true"
                className={`h-2 w-2 rounded-full border ${
                  stop.isReached && !stop.isSkipped
                    ? tone.dot
                    : "bg-transparent border-gray-300 dark:border-gray-700"
                }`}
              />
              <span
                className={`text-[10px] leading-tight ${
                  stop.isCurrent
                    ? `font-semibold ${tone.label}`
                    : stop.isReached && !stop.isSkipped
                      ? "text-gray-600 dark:text-gray-400"
                      : "text-gray-400 dark:text-gray-600"
                }`}
              >
                {locale === "fr" ? stop.fr : stop.en}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
