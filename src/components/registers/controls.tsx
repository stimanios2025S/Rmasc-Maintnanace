"use client";

import type { ReactNode } from "react";
import { Download, RotateCcw } from "lucide-react";

/**
 * Les pièces communes aux deux registres.
 *
 * POURQUOI CES CONTRÔLES SONT PARTAGÉS
 * Le registre des rapports et celui des factures posent la même question à deux
 * tables différentes, et ils doivent y répondre de la même façon : une période
 * se saisit pareil, un filtre s'efface pareil, un export se demande pareil. Deux
 * copies auraient divergé à la première correction — l'étiquette d'un champ, la
 * façon dont une date vide se comporte — et personne ne compare deux écrans
 * qu'il n'ouvre jamais côte à côte.
 *
 * Ce fichier ne connaît ni les factures ni les rapports : il ne prend que des
 * valeurs et des gestionnaires.
 */

/** Une ligne de filtre : l'étiquette à gauche, les contrôles à droite. */
export function FilterRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-24 flex-none text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </span>
      {children}
    </div>
  );
}

/** Le style commun des champs de filtre. */
const FIELD_CLASS =
  "rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 " +
  "focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 " +
  "dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";

/**
 * Un sélecteur de filtre.
 *
 * `options` est rendue vide quand le choix est encore à « toutes » : un
 * sélecteur vide affiche « Toutes » et seules les options reçues le complètent.
 * La valeur `""` est celle de « pas de filtre », et non `"ALL"` — c'est aussi ce
 * qu'un paramètre d'adresse absent vaut, et une seule convention vaut mieux que
 * deux.
 */
export function FilterSelect({
  id,
  value,
  onChange,
  allLabel,
  options,
  disabled = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Le libellé de l'option « pas de filtre ». */
  allLabel: string;
  options: readonly { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className={`${FIELD_CLASS} disabled:opacity-50`}
    >
      <option value="">{allLabel}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Les deux bornes d'une période.
 *
 * Deux `<input type="date">` plutôt qu'un composant de calendrier : le champ
 * natif sait déjà écrire une date, la dicter, la refuser et l'afficher dans la
 * langue du poste, et tout cela sans script. Une plage de dates est aussi la
 * seule forme sous laquelle un bureau énonce une période — « du 1er au 31 ».
 *
 * La borne haute est inclusive pour qui la saisit, et la route en fait une
 * borne exclue du lendemain : voir `lib/registers/filters.ts`.
 */
export function PeriodFilter({
  from,
  to,
  onFromChange,
  onToChange,
}: {
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
        <span className="sr-only">Date de début</span>
        <input
          type="date"
          value={from}
          onChange={(event) => onFromChange(event.target.value)}
          className={FIELD_CLASS}
        />
      </label>
      <span className="text-sm text-gray-400">au</span>
      <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
        <span className="sr-only">Date de fin</span>
        <input
          type="date"
          value={to}
          onChange={(event) => onToChange(event.target.value)}
          className={FIELD_CLASS}
        />
      </label>
    </div>
  );
}

/**
 * Le bouton d'export, qui est un lien.
 *
 * Un téléchargement n'est pas une requête que l'écran attend : le laisser partir
 * comme un lien ordinaire laisse le navigateur gérer le fichier, son nom et sa
 * progression, et l'écran n'a rien à faire pendant ce temps. Un `fetch` rendrait
 * le fichier en mémoire pour le reproposer en pièce jointe, avec un `Content-
 * Disposition` reconstruit à la main — trois occasions de mal nommer le fichier
 * pour aucun gain.
 *
 * `href` porte donc les filtres affichés, et le fichier contient ce que l'écran
 * montre.
 */
export function ExportButton({
  href,
  disabled = false,
  title,
}: {
  href: string;
  disabled?: boolean;
  title?: string;
}) {
  if (disabled) {
    return (
      <button
        type="button"
        disabled
        title={title}
        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-400 disabled:cursor-not-allowed dark:border-gray-700 dark:text-gray-600"
      >
        <Download className="h-4 w-4" aria-hidden="true" />
        Exporter en CSV
      </button>
    );
  }

  return (
    <a
      href={href}
      title={title}
      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
    >
      <Download className="h-4 w-4" aria-hidden="true" />
      Exporter en CSV
    </a>
  );
}

/**
 * Le bouton qui remet tous les filtres à zéro.
 *
 * Il n'apparaît que lorsqu'au moins un filtre est posé : un bouton « tout
 * effacer » sur un écran vide ne fait rien et n'apprend rien.
 */
export function ResetFiltersButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
    >
      <RotateCcw className="h-4 w-4" aria-hidden="true" />
      Effacer les filtres
    </button>
  );
}

/** Le bandeau de confirmation, vert, identique à celui des alertes. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm font-medium text-green-800 dark:bg-green-950/40 dark:text-green-300"
    >
      {children}
    </p>
  );
}

/** Le bandeau d'échec, rouge. */
export function ActionError({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-800 dark:bg-red-950/40 dark:text-red-300"
    >
      {children}
    </p>
  );
}
