"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import {
  LayoutDashboard,
  ClipboardList,
  Wrench,
  Bell,
  LogOut,
  Activity,
  Menu,
  X,
  HelpCircle,
  Users,
  Building2,
  FileCheck,
  FilePlus,
  Receipt,
  PackageSearch,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ADMIN_ROLES, MANAGEMENT_ROLES, OPS_ROLES } from "@/types";
import type { UserRole } from "@/types";
import { OPEN_ACCESS_USER } from "@/lib/auth/open-access";
import { NotificationBell } from "./notification-bell";
import { CommandPalette } from "./command-palette";
import { onAlertsChanged } from "@/lib/ui/alert-events";

/**
 * The signed-in application chrome (sidebar, top bar, alert badge).
 *
 * Extracted from the `(dashboard)` route-group layout so that every protected
 * screen can render it explicitly. The group layout alone was not enough: the
 * `/ascenseurs`, `/bons-de-travail` and `/technicien` trees live outside that
 * group, so those three screens rendered their pages with no navigation, no
 * header and no way to sign out.
 */

type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** When set, only these roles see the link. */
  roles?: readonly UserRole[];
  /**
   * Chemins supplémentaires qui allument cette entrée.
   *
   * Un lien mène à une page qui porte des onglets : « Devis & Factures » ouvre
   * /administration/finance, mais on est aussi dans cette rubrique quand on lit
   * /factures ou /administration/devis. Sans ces préfixes, le menu s'éteindrait
   * dès qu'on entre dans la rubrique.
   */
  match?: readonly string[];
};

/**
 * Le menu du bureau : six portes, à plat.
 *
 * POURQUOI PLUS DE GROUPES
 * Les rubriques repliables, leurs flèches et leurs compteurs occupaient la
 * hauteur et l'attention sans aider à choisir : on ne cherche pas « Supervision
 * & parc », on cherche son parc. Les vues secondaires vivent désormais en
 * onglets dans leur page — devis et factures sous Finance, carte et audits sous
 * Parc, magasin sous Stock, comptes et personnel sous Équipe & Clients.
 *
 * Les libellés sont courts parce que la barre fait 250 px : un intitulé tronqué
 * ne dit rien, et « …commer… » ne se lit pas.
 */
const ADMIN_NAV = (role: UserRole | undefined): readonly NavItem[] => [
  {
    href: "/tableau-de-bord",
    label: "Tableau de bord",
    icon: LayoutDashboard,
  },
  {
    href: "/bons-de-travail",
    label: "Interventions",
    icon: ClipboardList,
    roles: OPS_ROLES,
    match: ["/bons-de-travail", "/entretien", "/rapports-inspection"],
  },
  {
    href: "/ascenseurs",
    label: "Parc Ascenseurs",
    icon: Building2,
    roles: OPS_ROLES,
    match: [
      "/ascenseurs",
      "/carte",
      "/administration/ascenseurs",
      "/fiches-techniques",
    ],
  },
  {
    href: "/administration/finance",
    label: "Devis & Factures",
    icon: Receipt,
    roles: MANAGEMENT_ROLES,
    match: [
      "/administration/finance",
      "/administration/devis",
      "/factures",
      "/administration/contrats",
    ],
  },
  {
    href: "/administration/pieces",
    label: "Stock & Magasin",
    icon: PackageSearch,
    roles: MANAGEMENT_ROLES,
    match: ["/administration/pieces", "/administration/magasinier"],
  },
  {
    /**
     * Le hub dépend du rôle : l'administrateur ouvre les comptes clients, le
     * personnel et les demandes d'accès ; un responsable n'a que le suivi de
     * l'équipe. Une seule ligne, deux destinations — les deux routes existent
     * toujours.
     */
    href:
      role === "ADMIN"
        ? "/administration/utilisateurs"
        : "/administration/techniciens",
    label: "Équipe & Clients",
    icon: Users,
    roles: MANAGEMENT_ROLES,
    match: [
      "/administration/utilisateurs",
      "/administration/clients",
      "/administration/personnel",
      "/administration/techniciens",
    ],
  },
];

const CLIENT_ITEMS: readonly NavItem[] = [
  {
    href: "/client",
    label: "Espace client",
    icon: HelpCircle,
  },
  {
    href: "/client/devis",
    label: "Mes devis",
    icon: FilePlus,
    roles: [...ADMIN_ROLES, "BUILDING_OWNER"],
  },
];

/**
 * Le menu d'un technicien de terrain, et lui seul.
 *
 * Un compte de terrain n'a pas de portefeuille à surveiller, pas de devis à
 * chiffrer, pas de seuils à régler : il a des interventions à faire. Le menu
 * est donc réduit à ses trois gestes — sa file, le scan d'un QR sur l'appareil,
 * ses rapports — plutôt que filtré entrée par entrée, pour qu'une nouvelle
 * rubrique ajoutée plus tard ne lui apparaisse pas par oubli.
 *
 * `/technicien` porte le scanner QR : c'est l'écran du terrain, pas la fiche
 * publique `/qr-appareil` (qui est une page de démonstration hors session).
 */
const TECHNICIAN_ITEMS: readonly NavItem[] = [
  {
    href: "/technicien",
    label: "Mon espace terrain",
    icon: Wrench,
  },
  {
    href: "/bons-de-travail",
    label: "Mes interventions",
    icon: ClipboardList,
  },
  {
    href: "/rapports-inspection",
    label: "Mes rapports",
    icon: FileCheck,
  },
];

/** Display labels for the role identifiers. The identifiers themselves are
 *  unchanged — only how they read on screen. */
const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Administrateur",
  MAINTENANCE_MANAGER: "Responsable maintenance",
  FIELD_TECHNICIAN: "Technicien de terrain",
  BUILDING_OWNER: "Propriétaire d'immeuble",
};

function formatRole(role?: string): string {
  if (!role) return "Utilisateur";
  const known = ROLE_LABELS[role];
  if (known) return known;
  return role
    .split("_")
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(" ");
}

function initials(name?: string | null, email?: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2)
      return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  if (email) return email.slice(0, 2).toUpperCase();
  return "EP";
}

/** Longest matching href wins, so `/bons-de-travail` is not shadowed by `/`. */
/**
 * L'entrée qui correspond à l'écran courant.
 *
 * Le test porte sur le lien direct **et** sur les chemins d'onglets déclarés
 * par l'entrée (`match`) : `/factures` appartient à l'entrée dont la porte est
 * `/administration/finance`. Le tri par préfixe le plus long garde le choix
 * déterministe quand deux entrées se chevauchent.
 */
function activeItem(pathname: string, items: readonly NavItem[]): NavItem | undefined {
  const matches = (item: NavItem): boolean =>
    pathname === item.href ||
    pathname.startsWith(`${item.href}/`) ||
    (item.match ?? []).some(
      (path) => pathname === path || pathname.startsWith(`${path}/`)
    );

  return items.filter(matches).sort((a, b) => b.href.length - a.href.length)[0];
}

export function AppShell({
  children,
  openAccess = false,
  showNotificationBell = true,
}: {
  children: React.ReactNode;
  /**
   * Local open-access mode. Passed in by each route tree's layout from the
   * server, because `isOpenAccessEnabled()` reads a non-`NEXT_PUBLIC_` variable
   * and would inline as `undefined` in this client bundle.
   *
   * When set, the sign-out control is replaced by an "Ouvert" badge: there is no
   * session cookie to clear, so `signOut()` would only bounce back through
   * `/connexion` to the dashboard and look broken.
   */
  openAccess?: boolean;
  /**
   * Masque la cloche de notifications de la barre supérieure.
   *
   * Le portail terrain la place dans sa propre bannière de profil, à côté du
   * nom : deux cloches sur le même écran compteraient deux fois la même chose.
   */
  showNotificationBell?: boolean;
}) {
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  /**
   * La recherche globale.
   *
   * L'état vit ici plutôt que dans la palette : le bouton de l'en-tête et le
   * raccourci clavier doivent ouvrir la même chose, et un état local au
   * composant palette aurait obligé l'en-tête à lui parler par un événement.
   */
  const [searchOpen, setSearchOpen] = useState(false);

  const user = session?.user ?? (openAccess ? OPEN_ACCESS_USER : undefined);

  /**
   * Le rôle, et le cas de l'accès libre.
   *
   * `openAccess` est un mode appliqué par le *serveur* — `getSession()` rend une
   * session ADMIN synthétique —, et il n'y a donc aucun cookie NextAuth.
   * `useSession()`, qui interroge NextAuth depuis le navigateur, rend toujours
   * `null` dans ce mode.
   *
   * Sans le repli ci-dessus, toutes les entrées réservées à un rôle
   * disparaissaient de la barre latérale : on atteignait les écrans en tapant
   * leur adresse, mais le menu n'en offrait plus aucun. Observé en capture, pas
   * déduit.
   *
   * Le repli ne peut pas fuir en production : `openAccess` vient du serveur et
   * `isOpenAccessEnabled()` rend `false` dès que `NODE_ENV` vaut `production`.
   */
  const role = user?.role;

  /**
   * Les entrées visibles pour ce rôle.
   *
   * Le terrain a son propre menu, fermé aux autres rôles : un technicien n'a
   * rien à faire d'un tableau de bord de parc ni d'un registre de devis. Le
   * filtre par entrée ne suffisait pas — une rubrique ajoutée sans `roles` lui
   * serait apparue — d'où la liste séparée.
   */
  const navItems = useMemo(() => {
    if (role === "FIELD_TECHNICIAN") return TECHNICIAN_ITEMS;

    const canSee = (item: NavItem) =>
      !item.roles || (role !== undefined && item.roles.includes(role));

    return ADMIN_NAV(role).filter(canSee);
  }, [role]);

  const clientItems = useMemo(() => {
    /**
     * Seul un compte client voit son portail dans le menu.
     *
     * Le personnel y accédait aussi et tombait donc sur le formulaire
     * « Signaler une panne » et le bouton d'urgence depuis sa propre console —
     * un écran de locataire dans une interface d'administration. La route
     * `/client` reste accessible par adresse pour vérifier ce que voit un
     * client, mais elle n'est plus proposée comme porte d'entrée.
     */
    if (role !== "BUILDING_OWNER") return [];

    const canSee = (item: NavItem) =>
      !item.roles || (role !== undefined && item.roles.includes(role));
    return CLIENT_ITEMS.filter(canSee);
  }, [role]);

  /**
   * L'écran courant, pour l'indicateur actif et le titre de la barre.
   *
   * Le rapprochement tient compte des onglets : être sur `/factures` allume
   * « Devis & Factures », dont la porte est `/administration/finance`.
   */
  const current = activeItem(pathname, [...navItems, ...clientItems]);

  // "1 alerte ouverte" / "3 alertes ouvertes" — spelled out so the singular
  // does not read like a machine translation.
  const alertLabel =
    unreadCount > 0
      ? `${unreadCount} alerte${unreadCount > 1 ? "s" : ""} ouverte${
          unreadCount > 1 ? "s" : ""
        }`
      : "Aucune alerte ouverte";

  // Unread-alert indicator. Best effort: a failure here must never break the
  // chrome, so errors are swallowed and the badge simply stays hidden.
  useEffect(() => {
    if (status !== "authenticated") return;

    let cancelled = false;
    async function loadAlerts() {
      try {
        const res = await fetch("/api/alerts?acknowledged=false&limit=1");
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled && typeof json.total === "number") {
          setUnreadCount(json.total);
        }
      } catch {
        // Keep the bell quiet.
      }
    }

    loadAlerts();
    const id = setInterval(loadAlerts, 60_000);

    /**
     * Et l'écoute des écritures faites depuis la page des alertes.
     *
     * Sans elle, acquitter une alerte laissait ce badge afficher l'ancien
     * nombre pendant une minute — soit exactement le temps qu'il faut à
     * l'utilisateur pour conclure que son clic n'a rien fait. Le sondage reste
     * en place : une alerte créée par la télémétrie pendant que personne ne
     * regarde doit finir par apparaître, et aucun événement ne l'annoncera.
     */
    const unsubscribe = onAlertsChanged(() => void loadAlerts());

    return () => {
      cancelled = true;
      clearInterval(id);
      unsubscribe();
    };
  }, [status]);

  /**
   * Un lien de navigation.
   *
   * L'état actif se lit à deux signaux discrets — un fond teinté et une
   * bordure gauche — plutôt qu'à une pastille et une couleur de texte : le
   * regard trouve l'entrée sans que le menu ait l'air d'un tableau de bord.
   */
  function navLink(item: NavItem) {
    const isActive = current?.href === item.href;
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={isActive ? "page" : undefined}
        title={sidebarOpen ? undefined : item.label}
        className={`group flex items-center gap-3 rounded-r-lg border-l-2 px-3 py-2.5 text-sm font-medium transition-colors ${
          isActive
            ? "border-blue-600 bg-blue-500/10 text-blue-600 dark:border-blue-400 dark:bg-blue-400/10 dark:text-blue-300"
            : "border-transparent text-gray-600 hover:bg-white/40 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-100"
        }`}
      >
        <item.icon
          className={`h-5 w-5 flex-none ${
            isActive
              ? "text-blue-600 dark:text-blue-400"
              : "text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300"
          }`}
          aria-hidden="true"
        />
        {sidebarOpen && <span className="min-w-0 truncate">{item.label}</span>}
      </Link>
    );
  }

  return (
    <div className="relative flex h-screen bg-transparent">
      {/*
        Le fond animé est porté par les layouts (`AppBackground`), pas par ce
        composant : il doit être un frère du contenu, au-dessus du fond du
        document, et rester fixe pendant que `main` défile. Les surfaces de
        travail restent opaques (cartes, tableaux) ; seuls les interstices et
        les zones de page laissent voir le GIF.
      */}

      {/* Sidebar */}
      <aside
        className={`${
          sidebarOpen ? "w-[250px]" : "w-16"
        } relative z-10 bg-white/75 dark:bg-slate-950/75 backdrop-blur-md border-r border-gray-200/50 dark:border-slate-800/50 flex flex-col transition-all duration-300`}
      >
        <div className="h-16 flex items-center px-4 border-b border-gray-200/60 dark:border-slate-800/60">
          {/* The brand is longer than the old one and the sidebar is a fixed
              width, so the text is allowed to shrink and clip rather than push
              the collapse button out of the row. `min-w-0` on the link is what
              makes `truncate` on the span do anything: a flex child will not
              shrink below its content width without it. */}
          {sidebarOpen && (
            <Link
              href="/tableau-de-bord"
              className="flex min-w-0 items-center gap-2"
            >
              <div className="w-8 h-8 flex-none bg-blue-600 rounded-lg flex items-center justify-center">
                <Activity className="w-5 h-5 text-white" />
              </div>
              <span className="truncate text-base font-bold text-gray-900 dark:text-white">
                Maintenance RMASC
              </span>
            </Link>
          )}
          <button
            onClick={() => setSidebarOpen((open) => !open)}
            aria-label={
              sidebarOpen
                ? "Réduire le menu latéral"
                : "Développer le menu latéral"
            }
            aria-expanded={sidebarOpen}
            className="ml-auto p-1.5 rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            {sidebarOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {/* Une liste plate : pas de rubriques, pas de flèches, pas de
              compteurs. Six portes, dans l'ordre où un bureau les ouvre. */}
          {navItems.map((item) => navLink(item))}

          {/* L'espace client reste séparé : il ne décrit pas le travail du
              personnel, et son contenu dépend d'un autre rôle. */}
          {clientItems.length > 0 && (
            <div className="mt-4 space-y-1 border-t border-gray-200/60 pt-3 dark:border-slate-800/60">
              {clientItems.map((item) => navLink(item))}
            </div>
          )}
        </nav>

        <div className="border-t border-gray-200/60 bg-white/30 p-4 backdrop-blur-sm dark:border-slate-800/60 dark:bg-slate-950/30">
          {sidebarOpen ? (
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-blue-100 dark:bg-blue-900/40 rounded-full flex items-center justify-center text-sm font-bold text-blue-700 dark:text-blue-300">
                {initials(user?.name, user?.email)}
              </div>
              <div className="flex-1 min-w-0">
                <p
                  className="truncate text-sm font-semibold text-gray-900 dark:text-white"
                  title={user?.email ?? undefined}
                >
                  {user?.name ?? "SARL RMASC"}
                </p>
                <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                  {formatRole(user?.role)}
                </p>
              </div>
              {openAccess ? (
                <span
                  title='Accès libre local — la connexion est désactivée. Définissez OPEN_ACCESS="false" dans .env pour la rétablir.'
                  className="px-1.5 py-1 rounded-md text-[10px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/30"
                >
                  Ouvert
                </span>
              ) : (
                <button
                  onClick={() => signOut({ callbackUrl: "/connexion" })}
                  title="Se déconnecter"
                  aria-label="Se déconnecter"
                  className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  <LogOut className="w-4 h-4 text-gray-400" />
                </button>
              )}
            </div>
          ) : (
            <div className="mx-auto flex justify-center">
              {openAccess ? (
                <span
                  title='Accès libre local — la connexion est désactivée. Définissez OPEN_ACCESS="false" dans .env pour la rétablir.'
                  className="w-2.5 h-2.5 rounded-full bg-amber-400"
                />
              ) : (
                <button
                  onClick={() => signOut({ callbackUrl: "/connexion" })}
                  title="Se déconnecter"
                  aria-label="Se déconnecter"
                  className="block p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  <LogOut className="w-4 h-4 text-gray-400" />
                </button>
              )}
            </div>
          )}
        </div>
      </aside>

      <div className="relative z-10 flex-1 flex flex-col overflow-hidden">
        <header className="h-16 bg-white/90 dark:bg-gray-900/90 backdrop-blur-md border-b border-gray-200/80 dark:border-gray-800/80 flex items-center justify-between px-6">
          <div>
            <h1 className="text-lg font-semibold text-gray-900 dark:text-white">
              {current?.label ?? "Maintenance RMASC"}
            </h1>
            {user?.role && (
              <p className="text-xs text-gray-500">{formatRole(user.role)}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/*
              La recherche est un bouton visible, pas seulement un raccourci.
              Un raccourci clavier que personne ne connaît n'existe pas pour
              l'utilisateur qui découvre l'application ; le bouton montre à la
              fois la fonction et la touche qui l'ouvre.
            */}
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="hidden items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500 transition-colors hover:border-gray-300 hover:bg-white hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700 sm:inline-flex"
              aria-label="Rechercher dans toute l'application (Ctrl + K)"
            >
              <Search className="h-4 w-4" aria-hidden="true" />
              <span>Rechercher…</span>
              <kbd className="ml-4 rounded border border-gray-300 bg-white px-1.5 py-0.5 font-sans text-[10px] font-medium text-gray-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-400">
                Ctrl K
              </kbd>
            </button>
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-800 sm:hidden"
              aria-label="Rechercher dans toute l'application"
            >
              <Search className="h-5 w-5" aria-hidden="true" />
            </button>

            {/* Two separate indicators, on purpose. The bell counts unread
                telemetry alerts — the fleet has a problem. The tray counts
                notifications addressed to *this* user: an incident was
                assigned to them, or one they reported was closed. Merging the
                two into a single number would make "3" mean either "three
                machines are overheating" or "you have three messages", and an
                operator cannot act on a count whose subject is ambiguous. */}
            {showNotificationBell && (
              <NotificationBell enabled={status === "authenticated"} />
            )}

            <Link
              href="/alertes"
              title={alertLabel}
              aria-label={alertLabel}
              className="relative p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              <Bell className="w-5 h-5 text-gray-500" />
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </Link>
          </div>
        </header>

        <main className="flex-1 overflow-auto bg-transparent p-6">{children}</main>
      </div>

      <CommandPalette
        open={searchOpen}
        onOpen={() => setSearchOpen(true)}
        onClose={() => setSearchOpen(false)}
      />
    </div>
  );
}
