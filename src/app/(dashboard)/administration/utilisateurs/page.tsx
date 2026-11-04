"use client";

/**
 * Gestion des Accès — comptes clients, demandes entrantes et personnel.
 *
 * Les trois écrans étaient trois entrées de menu réservées à l'administrateur ;
 * ils décrivent un seul sujet — qui peut entrer dans la plateforme, et avec quel
 * rôle. Les réunir sous une porte ne change aucune de leurs règles : le
 * middleware continue de garder chaque route à ADMIN seul.
 */

import Link from "next/link";
import { ArrowRight, UserCog, UserPlus, Users, Wrench } from "lucide-react";
import { Card } from "@/components/ui/card";
import { SectionTabs } from "@/components/layout/section-tabs";

const TABS = [
  { href: "/administration/utilisateurs", label: "Vue d'ensemble" },
  { href: "/administration/clients", label: "Espace clients" },
  { href: "/administration/clients/demandes", label: "Demandes d'accès" },
  { href: "/administration/personnel", label: "Personnel" },
];

const ENTRIES = [
  {
    href: "/administration/clients",
    label: "Espace clients",
    description:
      "Le portefeuille clients : responsables de site, immeubles sous contrat, état du parc, contrats et historique d'archivage.",
    icon: Users,
    tone: "text-blue-600 bg-blue-50 dark:bg-blue-950/40 dark:text-blue-400",
  },
  {
    href: "/administration/clients/demandes",
    label: "Demandes d'accès",
    description:
      "Les demandes déposées en scannant le QR d'un appareil. Une demande approuvée devient un compte.",
    icon: UserPlus,
    tone: "text-amber-600 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-400",
  },
  {
    href: "/administration/personnel",
    label: "Personnel",
    description:
      "Créer un compte salarié et choisir son rôle. Créer un administrateur, c'est donner les droits d'administrateur.",
    icon: UserCog,
    tone: "text-violet-600 bg-violet-50 dark:bg-violet-950/40 dark:text-violet-400",
  },
  {
    // La seule entrée de ce hub qui ne parle pas d'accès mais de présence :
    // c'est ici qu'un administrateur retrouve l'équipe terrain depuis que le
    // menu latéral ne montre plus que six portes.
    href: "/administration/techniciens",
    label: "Équipe terrain",
    description:
      "Qui est disponible, qui est en mission et sur quel site. Le suivi de la charge du jour.",
    icon: Wrench,
    tone: "text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-400",
  },
];

export default function AccessManagementPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
          Gestion des Accès
        </h2>
        <p className="mt-1 text-gray-500">
          Comptes clients, demandes entrantes et comptes du personnel.
        </p>
      </div>

      <SectionTabs tabs={TABS} ariaLabel="Gestion des accès" />

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
