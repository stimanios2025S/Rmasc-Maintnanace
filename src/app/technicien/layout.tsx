import { AppShell } from "@/components/layout/app-shell";
import { AppBackground } from "@/components/layout/app-background";
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
  return (
    <div className="relative min-h-screen">
      <AppBackground />
      <div className="relative z-10 bg-transparent">
        <AppShell
          openAccess={isOpenAccessEnabled()}
          /* La cloche vit dans la bannière de profil de la page. */
          showNotificationBell={false}
        >
          {children}
        </AppShell>
      </div>
    </div>
  );
}
