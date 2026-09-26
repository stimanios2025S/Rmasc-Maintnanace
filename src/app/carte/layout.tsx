import { AppShell } from "@/components/layout/app-shell";
import { isOpenAccessEnabled } from "@/lib/auth/open-access";

/**
 * The fleet map sits outside the `(dashboard)` route group, like `/ascenseurs`
 * and `/bons-de-travail`, so it renders `AppShell` itself. See the note at the
 * top of `src/components/layout/app-shell.tsx` for why that extraction exists.
 *
 * NO ROLE GATE BEYOND SIGNED-IN
 * `/api/map/fleet` scopes a BUILDING_OWNER to their own portfolio through
 * `buildingScopeFor`, exactly as `/api/elevators` does, so an owner who opens
 * this page gets a map of their own sites and nothing else. That is the same
 * arrangement `/ascenseurs` already uses, and gating the page more tightly than
 * the API it reads would only produce a link some roles cannot follow.
 */
export default function CarteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell openAccess={isOpenAccessEnabled()}>{children}</AppShell>;
}
