/**
 * Small client-safe formatting helpers.
 *
 * Deliberately narrow. This file previously also exported a *second*
 * `generateOrderNumber` / `generateReportNumber` pair built on
 * `Math.floor(Math.random() * 10000)` — a 10,000-value space per month against
 * a `@unique` column. `src/lib/ids.ts` was written to replace them, but the
 * originals were left here, unreferenced and one autocomplete away from being
 * picked up again. They, and the three hardcoded status-colour maps
 * superseded by `src/lib/ui/status-styles.ts`, are gone.
 *
 * Identifiers: `@/lib/ids`
 * Status colours: `@/lib/ui/status-styles`
 */

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { enumLabel } from "@/lib/ui/enum-labels";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * `NEEDS_ATTENTION` -> "À surveiller".
 *
 * The platform reads French, so this now resolves through the label table in
 * `@/lib/ui/enum-labels` instead of building a title-cased string from the raw
 * value. The mechanical transformation survives as that table's fallback, for
 * a value it does not yet carry.
 *
 * Kept under this name because it is called from a dozen screens; renaming it
 * would be a refactor with no behaviour to show for it.
 */
export function formatEnum(value: string): string {
  return enumLabel(value);
}
