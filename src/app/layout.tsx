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
  title: "ElevatorPulse — Predictive Maintenance Platform",
  description:
    "Production-ready predictive and preventive maintenance platform for elevator service companies. Real-time IoT telemetry, AI-powered failure prediction, and field technician dispatch.",
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
    <html lang="en">
      <body className={inter.className}>
        <SessionProvider initialSession={initialSession}>
          {children}
        </SessionProvider>
      </body>
    </html>
  );
}
