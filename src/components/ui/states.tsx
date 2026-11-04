"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";

export function LoadingSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-label="Chargement" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-16 rounded-xl bg-gray-100 dark:bg-gray-800 animate-pulse"
        />
      ))}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-6 text-center">
      <AlertTriangle className="w-6 h-6 text-red-500 mx-auto mb-2" />
      <p className="text-sm font-medium text-red-700 dark:text-red-300">
        {message}
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 rounded-lg bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700"
        >
          Réessayer
        </button>
      )}
    </div>
  );
}

export type EmptyStateAction = {
  label: string;
  /** Lien interne. L'un des deux champs `href`/`onClick` est requis. */
  href?: string;
  onClick?: () => void;
  icon?: LucideIcon;
  /**
   * `primary` pour l'action attendue (« Créer… »), `secondary` pour une sortie
   * de secours (« Voir les interventions »). Un seul bouton primaire par écran
   * vide : deux actions de même poids ne disent pas par où commencer.
   */
  variant?: "primary" | "secondary";
};

/**
 * Un écran vide, avec ce qu'il faut pour en sortir.
 *
 * CE QUI A CHANGÉ
 * Le message précédent s'arrêtait à « Aucun bon de travail » — un constat, pas
 * une explication, et aucun moyen d'agir. Un écran vide est le moment où un
 * nouvel utilisateur a le plus besoin d'être guidé : il doit dire pourquoi la
 * liste est vide, ce que cela signifie, et offrir l'action qui la remplira.
 *
 * `hint` reste accepté pour les vingt-quatre appels existants ; `description`
 * est sa forme longue, et `action` le bouton qui manquait.
 */
export function EmptyState({
  title,
  hint,
  description,
  icon: Icon = Inbox,
  action,
  className,
}: {
  title: string;
  /** Une phrase courte, sous le titre. */
  hint?: string;
  /** Une explication plus longue, prioritaire sur `hint`. */
  description?: string;
  icon?: LucideIcon;
  action?: EmptyStateAction;
  className?: string;
}) {
  const body = description ?? hint;
  const IconComponent = action?.icon;

  return (
    <div
      className={cn(
        "rounded-2xl border border-dashed border-gray-300 bg-gray-50/60 px-6 py-10 text-center dark:border-gray-700 dark:bg-gray-900/40",
        className
      )}
    >
      <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white text-gray-400 shadow-sm dark:bg-gray-800 dark:text-gray-500">
        <Icon className="h-6 w-6" aria-hidden="true" />
      </span>
      <p className="text-base font-semibold text-gray-900 dark:text-white">
        {title}
      </p>
      {body && (
        <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-gray-500 dark:text-gray-400">
          {body}
        </p>
      )}

      {action && (
        <div className="mt-5">
          {action.href ? (
            <Link
              href={action.href}
              className={cn(
                "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900",
                action.variant === "secondary"
                  ? "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                  : "bg-blue-600 text-white hover:bg-blue-700"
              )}
            >
              {IconComponent && (
                <IconComponent className="h-4 w-4" aria-hidden="true" />
              )}
              {action.label}
            </Link>
          ) : (
            <button
              type="button"
              onClick={action.onClick}
              className={cn(
                "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900",
                action.variant === "secondary"
                  ? "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                  : "bg-blue-600 text-white hover:bg-blue-700"
              )}
            >
              {IconComponent && (
                <IconComponent className="h-4 w-4" aria-hidden="true" />
              )}
              {action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
