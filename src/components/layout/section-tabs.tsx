"use client";

/**
 * Les onglets d'une section — des liens, pas un état local.
 *
 * Chaque vue secondaire garde son adresse : un onglet qui n'existerait qu'en
 * mémoire ne se partagerait pas, ne se mettrait pas en favori, et un
 * rafraîchissement ramènerait le premier onglet. Ce composant ne décide donc
 * que de l'apparence et de l'onglet actif, à partir du chemin courant.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface SectionTab {
  href: string;
  label: string;
}

/**
 * Les onglets d'une même section, définis une fois.
 *
 * Chaque page du groupe les affiche : sans cela, la carte du parc ne saurait
 * pas qu'elle est un onglet de « Parc Ascenseurs », et l'utilisateur devrait
 * revenir au menu pour changer de vue.
 */
export const PARC_TABS: readonly SectionTab[] = [
  { href: "/ascenseurs", label: "Parc" },
  { href: "/carte", label: "Carte du parc" },
  { href: "/administration/ascenseurs", label: "Audits de reprise" },
  { href: "/fiches-techniques", label: "Fiches techniques" },
];

export const INTERVENTION_TABS: readonly SectionTab[] = [
  { href: "/bons-de-travail", label: "Pannes" },
  { href: "/entretien", label: "Visites d'entretien" },
  { href: "/rapports-inspection", label: "Rapports" },
];

export function SectionTabs({
  tabs,
  ariaLabel,
}: {
  tabs: readonly SectionTab[];
  ariaLabel: string;
}) {
  const pathname = usePathname();

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-800"
    >
      {tabs.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            role="tab"
            aria-selected={active}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${
              active
                ? "border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-400"
                : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-800 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-200"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
