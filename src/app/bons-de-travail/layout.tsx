import { AppShell } from "@/components/layout/app-shell";
import { isOpenAccessEnabled } from "@/lib/auth/open-access";

/**
 * `/bons-de-travail` lives outside the `(dashboard)` route group, so it needs
 * its own shell. See `src/components/layout/app-shell.tsx`.
 *
 * If this folder is moved into `src/app/(dashboard)/`, delete this file.
 */
export default function WorkOrdersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell openAccess={isOpenAccessEnabled()}>{children}</AppShell>;
}
