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

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** `NEEDS_ATTENTION` -> `Needs Attention` */
export function formatEnum(value: string): string {
  return value
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
