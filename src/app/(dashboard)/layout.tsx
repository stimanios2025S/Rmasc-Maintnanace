import { AppShell } from "@/components/layout/app-shell";
import { AppBackground } from "@/components/layout/app-background";
import { isOpenAccessEnabled } from "@/lib/auth/open-access";

/**
 * Application shell for the routes inside this group.
 *
 * NOTE: a route group only wraps the folders nested *underneath it*. The
 * `/ascenseurs`, `/bons-de-travail` and `/technicien` trees sit outside
 * `(dashboard)`, so each of them carries its own `layout.tsx` rendering the same
 * `AppShell`. If those folders are ever moved in here, delete their layouts —
 * otherwise the shell would nest inside itself.
 */
export default function DashboardGroupLayout({
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
