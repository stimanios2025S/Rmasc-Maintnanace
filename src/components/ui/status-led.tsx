/**
 * Le témoin lumineux de disponibilité d'un technicien.
 *
 * Une LED, pas un badge de texte : sur un bureau de dispatch, l'état se lit
 * d'un coup d'œil avant le nom. Les cinq états couvrent la journée réelle —
 * disponible, en intervention, en pause, en congé, hors service — et le halo
 * néon ne sert qu'à attirer l'œil sur ce qui bouge.
 *
 * CONTRASTE
 * Les teintes sont déclinées clair/sombre : un `text-emerald-400` sur fond
 * blanc serait illisible, et l'écran doit rester utilisable dans les deux
 * thèmes. Le libellé est aussi rendu en toutes lettres, pour que la couleur ne
 * soit jamais la seule information (daltonisme, impression).
 *
 * Composant sans état : il s'importe indifféremment dans un écran client ou
 * serveur.
 */

import { cn } from "@/lib/utils";

interface StatusConfig {
  color: string;
  glow: string;
  pulse: string;
  label: string;
  badgeBg: string;
}

const CONFIG: Record<string, StatusConfig> = {
  AVAILABLE: {
    color: "bg-emerald-500",
    glow: "shadow-[0_0_12px_rgba(16,185,129,0.7)]",
    pulse: "bg-emerald-400",
    label: "Disponible / Libre",
    badgeBg:
      "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20",
  },
  ON_JOB: {
    color: "bg-sky-500",
    glow: "shadow-[0_0_12px_rgba(14,165,233,0.7)]",
    pulse: "bg-sky-400",
    label: "En intervention",
    badgeBg:
      "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-400 dark:border-sky-500/20",
  },
  ON_LEAVE: {
    color: "bg-rose-500",
    glow: "shadow-[0_0_12px_rgba(239,68,68,0.7)]",
    pulse: "bg-rose-400",
    label: "En congé",
    badgeBg:
      "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/10 dark:text-rose-400 dark:border-rose-500/20",
  },
  ON_BREAK: {
    color: "bg-amber-500",
    glow: "shadow-[0_0_12px_rgba(245,158,11,0.7)]",
    pulse: "bg-amber-400",
    label: "En pause",
    badgeBg:
      "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20",
  },
  OFF_DUTY: {
    color: "bg-slate-500",
    glow: "",
    pulse: "hidden",
    label: "Hors service",
    badgeBg:
      "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-400 dark:border-slate-500/20",
  },
};

const FALLBACK: StatusConfig = {
  color: "bg-slate-500",
  glow: "",
  pulse: "hidden",
  label: "État inconnu",
  badgeBg:
    "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-400 dark:border-slate-500/20",
};

export function StatusLED({
  status,
  showLabel = true,
  className,
}: {
  status: string;
  /** `false` pour un simple point, dans une carte KPI par exemple. */
  showLabel?: boolean;
  className?: string;
}) {
  const config = CONFIG[status] ?? FALLBACK;
  const label = CONFIG[status]?.label ?? status;

  return (
    <span
      role="status"
      aria-label={`Disponibilité : ${label}`}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium",
        config.badgeBg,
        className
      )}
    >
      <span className="relative flex h-2.5 w-2.5 items-center justify-center">
        {config.pulse !== "hidden" && (
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
              config.pulse
            )}
            aria-hidden="true"
          />
        )}
        <span
          className={cn(
            "relative inline-flex h-2.5 w-2.5 rounded-full",
            config.color,
            config.glow
          )}
          aria-hidden="true"
        />
      </span>
      {showLabel && <span>{config.label}</span>}
    </span>
  );
}
