"use client";

import { SessionProvider as NextAuthSessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import type { ReactNode } from "react";

/**
 * Client-side session context.
 *
 * `initialSession` is normally omitted and the provider fetches `/api/auth/session`
 * on mount, exactly as before. It is supplied only by the root layout in local
 * open-access mode, where there is no session cookie to fetch: passing it here
 * makes `useSession()` report `authenticated` immediately, so the sidebar shows
 * a real name and role instead of rendering the signed-out fallbacks.
 */
export function SessionProvider({
  children,
  initialSession,
}: {
  children: ReactNode;
  initialSession?: Session | null;
}) {
  return (
    <NextAuthSessionProvider session={initialSession}>
      {children}
    </NextAuthSessionProvider>
  );
}
