import { AppShell } from "@/components/layout/app-shell";
import { AppBackground } from "@/components/layout/app-background";
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
  return (
    <div className="relative min-h-screen">
      <AppBackground />
      <div className="relative z-10 bg-transparent">
        <AppShell openAccess={isOpenAccessEnabled()}>{children}</AppShell>
      </div>
    </div>
  );
}
