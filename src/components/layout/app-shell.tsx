"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import {
  LayoutDashboard,
  ClipboardList,
  FileSpreadsheet,
  Wrench,
  Bell,
  LogOut,
  Activity,
  Menu,
  X,
  AlertOctagon,
  HelpCircle,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ADMIN_ROLES, MANAGEMENT_ROLES, OPS_ROLES } from "@/types";
import type { UserRole } from "@/types";
import { NotificationBell } from "./notification-bell";

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
};

const NAV_ITEMS: readonly NavItem[] = [
  { href: "/tableau-de-bord", label: "Tableau de bord", icon: LayoutDashboard },
  { href: "/ascenseurs", label: "Ascenseurs", icon: Activity },
  { href: "/bons-de-travail", label: "Bons de travail", icon: ClipboardList },
  // The « Fiche Technique » board for non-contract clients. Same reasoning as
  // /technicien below: the middleware gates it to OPS_ROLES, so the link is
  // filtered to exactly those roles rather than offered and then refused.
  {
    href: "/fiches-techniques",
    label: "Fiches techniques",
    icon: FileSpreadsheet,
    roles: OPS_ROLES,
  },
  // Mirrors the middleware rule for /technicien. Without the filter a building
  // owner would see a link that silently bounces them back to the dashboard.
  { href: "/technicien", label: "Technicien", icon: Wrench, roles: OPS_ROLES },
  // The dispatch board for escalated client faults. Same reasoning as above:
  // the middleware redirects anyone below management, so the link is filtered
  // to exactly those roles.
  {
    href: "/administration/incidents",
    label: "Incidents",
    icon: AlertOctagon,
    roles: MANAGEMENT_ROLES,
  },
  // Opening customer accounts and setting their contract status. Narrower than
  // the incidents board above: the middleware gates this path to ADMIN alone,
  // so a maintenance manager is not offered a link they cannot follow.
  {
    href: "/administration/clients",
    label: "Comptes clients",
    icon: Users,
    roles: ADMIN_ROLES,
  },
  // The customer's own view of their equipment. Deliberately unrestricted — an
  // administrator needs to be able to open it to see what a customer sees.
  { href: "/client", label: "Espace client", icon: HelpCircle },
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
function activeItem(pathname: string, items: readonly NavItem[]): NavItem | undefined {
  return items
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

export function AppShell({
  children,
  openAccess = false,
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
}) {
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);

  const user = session?.user;

  const role = session?.user?.role;
  const navItems = NAV_ITEMS.filter(
    (item) => !item.roles || (role !== undefined && item.roles.includes(role))
  );
  const current = activeItem(pathname, navItems);

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
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [status]);

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-950">
      {/* Sidebar */}
      <aside
        className={`${
          sidebarOpen ? "w-64" : "w-16"
        } bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col transition-all duration-300`}
      >
        <div className="h-16 flex items-center px-4 border-b border-gray-200 dark:border-gray-800">
          {sidebarOpen && (
            <Link href="/tableau-de-bord" className="flex items-center gap-2">
              <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                <Activity className="w-5 h-5 text-white" />
              </div>
              <span className="font-bold text-lg text-gray-900 dark:text-white">
                ElevatorPulse
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

        <nav className="flex-1 py-4 space-y-1 px-2">
          {navItems.map((item) => {
            const isActive = current?.href === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                title={sidebarOpen ? undefined : item.label}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"
                    : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
                }`}
              >
                <item.icon className="w-5 h-5 flex-shrink-0" />
                {sidebarOpen && <span>{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-gray-200 dark:border-gray-800 p-4">
          {sidebarOpen ? (
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-blue-100 dark:bg-blue-900/40 rounded-full flex items-center justify-center text-sm font-bold text-blue-700 dark:text-blue-300">
                {initials(user?.name, user?.email)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                  {user?.name ?? "Connecté"}
                </p>
                <p className="text-xs text-gray-500 truncate">
                  {user?.email ?? formatRole(user?.role)}
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

      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-16 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between px-6">
          <div>
            <h1 className="text-lg font-semibold text-gray-900 dark:text-white">
              {current?.label ?? "ElevatorPulse"}
            </h1>
            {user?.role && (
              <p className="text-xs text-gray-500">{formatRole(user.role)}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Two separate indicators, on purpose. The bell counts unread
                telemetry alerts — the fleet has a problem. The tray counts
                notifications addressed to *this* user: an incident was
                assigned to them, or one they reported was closed. Merging the
                two into a single number would make "3" mean either "three
                machines are overheating" or "you have three messages", and an
                operator cannot act on a count whose subject is ambiguous. */}
            <NotificationBell enabled={status === "authenticated"} />

            <Link
              href="/bons-de-travail"
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

        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
