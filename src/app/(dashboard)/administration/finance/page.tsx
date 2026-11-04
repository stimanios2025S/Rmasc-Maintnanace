"use client";

/**
 * Finance & Contrats — la porte unique des pièces commerciales.
 *
 * Devis, factures et contrats vivaient dans trois entrées de menu séparées ;
 * ils répondent à la même question — « qu'est-ce que l'entreprise a engagé,
 * facturé et signé ? » — et se lisent dans cet ordre. Cette page ne réécrit
 * aucun de ces écrans : elle les expose en onglets, avec une vue d'ensemble qui
 * dit où aller.
 */

import Link from "next/link";
import { FileText, Receipt, ScrollText, ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { SectionTabs } from "@/components/layout/section-tabs";

const TABS = [
  { href: "/administration/finance", label: "Vue d'ensemble" },
  { href: "/administration/devis", label: "Devis" },
  { href: "/factures", label: "Factures" },
  { href: "/administration/contrats", label: "Contrats & SLA" },
];

const ENTRIES = [
  {
    href: "/administration/devis",
    label: "Devis",
    description:
      "Les offres chiffrées, de la demande client à l'acceptation. Une offre acceptée engage l'entreprise.",
    icon: FileText,
    tone: "text-blue-600 bg-blue-50 dark:bg-blue-950/40 dark:text-blue-400",
  },
  {
    href: "/factures",
    label: "Factures",
    description:
      "La facturation émise sur les interventions terminées, avec les montants et les paiements.",
    icon: Receipt,
    tone: "text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-400",
  },
  {
    href: "/administration/contrats",
    label: "Contrats & SLA",
    description:
      "Les engagements de maintenance, leurs paliers de service, les échéances et les reconductions.",
    icon: ScrollText,
    tone: "text-violet-600 bg-violet-50 dark:bg-violet-950/40 dark:text-violet-400",
  },
];

export default function FinancePage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
          Finance &amp; Contrats
        </h2>
        <p className="mt-1 text-gray-500">
          Devis, facturation et engagements contractuels, au même endroit.
        </p>
      </div>

      <SectionTabs tabs={TABS} ariaLabel="Finance et contrats" />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {ENTRIES.map((entry) => (
          <Link key={entry.href} href={entry.href} className="group">
            <Card className="flex h-full flex-col p-5 transition-colors group-hover:border-blue-300 dark:group-hover:border-blue-800">
              <span
                className={`flex h-10 w-10 items-center justify-center rounded-xl ${entry.tone}`}
              >
                <entry.icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <p className="mt-3 text-base font-bold text-gray-900 dark:text-white">
                {entry.label}
              </p>
              <p className="mt-1 flex-1 text-sm text-gray-500 dark:text-gray-400">
                {entry.description}
              </p>
              <span className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-blue-600 dark:text-blue-400">
                Ouvrir
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </span>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
