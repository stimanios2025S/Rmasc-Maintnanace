import { AppShell } from "@/components/layout/app-shell";
import { isOpenAccessEnabled } from "@/lib/auth/open-access";

/**
 * `/ascenseurs` lives outside the `(dashboard)` route group, which means the
 * group's layout — sidebar, header, sign-out — does not apply here. Without
 * this file the fleet list and detail pages render with no navigation at all.
 *
 * If this folder is moved into `src/app/(dashboard)/`, delete this file.
 */
export default function ElevatorsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell openAccess={isOpenAccessEnabled()}>{children}</AppShell>;
}
