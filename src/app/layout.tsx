import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { SessionProvider } from "@/components/providers/session-provider";
import {
  isOpenAccessEnabled,
  openAccessSession,
} from "@/lib/auth/open-access";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "ElevatorPulse — Plateforme de maintenance prédictive",
  description:
    "Plateforme de maintenance prédictive et préventive prête pour la production, destinée aux entreprises de maintenance d'ascenseurs. Télémétrie IoT en temps réel, prédiction des pannes assistée par IA et affectation des techniciens de terrain.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Normally `undefined`, which leaves the provider fetching the real session
  // from `/api/auth/session` on mount. In local open-access mode there is no
  // cookie to fetch, so the synthetic session is handed straight down; the
  // server-side equivalent lives in `getSession()` in `src/lib/api/guard.ts`.
  const initialSession = isOpenAccessEnabled() ? openAccessSession() : undefined;

  return (
    <html lang="fr">
      <body className={inter.className}>
        <SessionProvider initialSession={initialSession}>
          {children}
        </SessionProvider>
      </body>
    </html>
  );
}
