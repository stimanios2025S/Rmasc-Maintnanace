/**
 * Les composants du code couleur universel.
 *
 * Trois formes, pour trois usages : la pastille seule quand le texte est à côté,
 * la pilule quand il faut lire l'état d'un coup, la légende quand il faut
 * expliquer le code une fois pour toutes.
 *
 * Ils lisent `TRAFFIC_LEVELS` et ne redéfinissent aucune couleur : c'est la
 * même table qui décide du vert d'un ascenseur et de celui d'un contrat.
 */

import { cn } from "@/lib/utils";
import {
  TRAFFIC_LEVELS,
  type TrafficLevel,
} from "@/lib/ui/traffic";

export function TrafficDot({
  level,
  size = "md",
  pulse = false,
  className,
  label,
}: {
  level: TrafficLevel;
  size?: "sm" | "md" | "lg";
  /** Réservé au niveau critique : un clignotement attire l'œil, il ne doit pas être partout. */
  pulse?: boolean;
  className?: string;
  /** Lu par les lecteurs d'écran quand la pastille porte l'information seule. */
  label?: string;
}) {
  const tone = TRAFFIC_LEVELS[level];
  const sizing =
    size === "sm" ? "h-2 w-2" : size === "lg" ? "h-4 w-4" : "h-2.5 w-2.5";

  return (
    <span
      className={cn(
        "inline-block flex-none rounded-full",
        sizing,
        tone.dot,
        pulse && level === "danger" && "animate-pulse",
        className
      )}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export function TrafficPill({
  level,
  label,
  size = "md",
  className,
}: {
  level: TrafficLevel;
  /** Texte affiché ; à défaut, le libellé générique du niveau. */
  label?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const tone = TRAFFIC_LEVELS[level];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-semibold",
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs",
        tone.bg,
        tone.border,
        tone.text,
        className
      )}
    >
      <TrafficDot level={level} size="sm" pulse />
      {label ?? tone.label}
    </span>
  );
}

/**
 * La légende du code couleur.
 *
 * Affichée une fois par écran de registre plutôt que dans chaque ligne : le
 * code s'apprend en le lisant une fois, pas en le répétant vingt fois. Le gris
 * y figure avec sa propre phrase, sinon « état inconnu » se confond avec
 * « mauvais état ».
 */
export function TrafficLegend({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const levels: TrafficLevel[] = ["ok", "warning", "danger", "neutral"];

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-600 dark:text-gray-300",
        className
      )}
      aria-label="Légende des couleurs d'état"
    >
      {levels.map((level) => (
        <span key={level} className="inline-flex items-center gap-1.5">
          <TrafficDot level={level} size="sm" />
          <span className="font-medium">{TRAFFIC_LEVELS[level].label}</span>
          {!compact && (
            <span className="text-gray-400 dark:text-gray-500">
              — {TRAFFIC_LEVELS[level].description}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
