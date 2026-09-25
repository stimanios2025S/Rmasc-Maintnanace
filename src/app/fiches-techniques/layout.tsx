import { AppShell } from "@/components/layout/app-shell";
import { isOpenAccessEnabled } from "@/lib/auth/open-access";

/**
 * `/fiches-techniques` lives outside the `(dashboard)` route group, so it needs
 * its own shell. See `src/components/layout/app-shell.tsx`.
 *
 * WHY NOT UNDER `/administration`
 * The dispatch board's tree is gated to MANAGEMENT_ROLES in `src/middleware.ts`,
 * and the « Fiche Technique » is explicitly meant to be read by the maintenance
 * technicians who complete its technical columns on site. Nesting the board
 * under `/administration` would have bounced every FIELD_TECHNICIAN back to the
 * dashboard, so it sits at the top level beside `/technicien`, which is gated
 * the same way for the same reason.
 *
 * If this folder is moved into `src/app/(dashboard)/`, delete this file.
 */
export default function TechnicalSheetsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell openAccess={isOpenAccessEnabled()}>{children}</AppShell>;
}
