"use client";

/**
 * The map's legend, doubling as its filter.
 *
 * WHY ONE CONTROL AND NOT TWO
 * A legend that only explains colours teaches the reader what red means and
 * then leaves them to hunt for the red pins by eye. Making each entry a button
 * means the thing that tells you what red means is the thing that shows you
 * where red is — which is the question anyone looking at a fleet map is
 * actually asking.
 *
 * Counts come from the server (`totals.byLevel`), not from the rendered sites,
 * so the number on a chip is the true size of that level even while a filter is
 * hiding the rest of the map. A chip reading "Panne 4" that shows nothing when
 * clicked would be a worse lie than showing the count at all.
 *
 * `AttentionFilter` itself lives in `@/lib/map/types`, because it is also the
 * argument `filterSites` takes — it is not a property of this control.
 */

import { ATTENTION_LEVELS, ATTENTION_STYLES } from "@/lib/map/attention";
import type { AttentionCounts } from "@/lib/map/attention";
import type { AttentionFilter } from "@/lib/map/types";
import { cn } from "@/lib/utils";

export interface AttentionLegendProps {
  counts: AttentionCounts;
  active: AttentionFilter;
  onChange: (filter: AttentionFilter) => void;
  /**
   * Hides entries with nothing in them.
   *
   * Off by default, and deliberately so: a level that is empty is worth seeing,
   * because "aucune panne" is information. A dense dashboard panel turns it on
   * to save two rows of chrome.
   */
  hideEmpty?: boolean;
  className?: string;
}

export function AttentionLegend({
  counts,
  active,
  onChange,
  hideEmpty = false,
  className,
}: AttentionLegendProps) {
  const total = ATTENTION_LEVELS.reduce((sum, level) => sum + counts[level], 0);

  return (
    <div
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      role="group"
      aria-label="Filtrer la carte par état"
    >
      <FilterChip
        label="Tout"
        count={total}
        color="#475569"
        active={active === "ALL"}
        title="Afficher tous les ascenseurs"
        onClick={() => onChange("ALL")}
      />

      {ATTENTION_LEVELS.map((level) => {
        const count = counts[level];
        if (hideEmpty && count === 0 && active !== level) return null;

        const style = ATTENTION_STYLES[level];
        return (
          <FilterChip
            key={level}
            label={style.label}
            count={count}
            color={style.color}
            active={active === level}
            title={style.description}
            onClick={() => onChange(active === level ? "ALL" : level)}
          />
        );
      })}
    </div>
  );
}

function FilterChip({
  label,
  count,
  color,
  active,
  title,
  onClick,
}: {
  label: string;
  count: number;
  color: string;
  active: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      // `aria-pressed` rather than a selected role: these are toggles, and a
      // screen reader announcing "selected" for a filter is a lie about what
      // pressing it again will do.
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-gray-400",
        active
          ? "border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900"
          : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
      )}
    >
      <span
        className="h-2.5 w-2.5 flex-none rounded-full ring-1 ring-black/10"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      {label}
      <span
        className={cn(
          "tabular-nums",
          active ? "opacity-80" : "text-gray-500 dark:text-gray-400"
        )}
      >
        {count}
      </span>
    </button>
  );
}
