import { AppShell } from "@/components/layout/app-shell";
import { isOpenAccessEnabled } from "@/lib/auth/open-access";

/**
 * `/technicien` lives outside the `(dashboard)` route group, so it needs its
 * own shell — previously the field portal had no header, no navigation and no
 * sign-out button.
 *
 * If this folder is moved into `src/app/(dashboard)/`, delete this file.
 */
export default function TechnicianLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell openAccess={isOpenAccessEnabled()}>{children}</AppShell>;
}
