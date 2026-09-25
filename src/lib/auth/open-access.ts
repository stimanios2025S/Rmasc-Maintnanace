/**
 * Local "open access" mode — browse the app with no sign-in.
 *
 * WHAT THIS DOES
 * Every request is treated as a signed-in ADMIN, so `/tableau-de-bord`,
 * `/ascenseurs`, `/bons-de-travail` and `/technicien` open straight away and the
 * whole `/api/*` surface answers without a session cookie. Credentials, the login
 * form and the NextAuth flow are all still present and untouched — this
 * short-circuits the *session lookup*, it does not delete the auth system.
 *
 * IT CANNOT REACH PRODUCTION
 * Two independent conditions must hold, and `NODE_ENV === "production"` forces
 * the answer to `false` before the flag is even read. `next build && next start`
 * sets `NODE_ENV=production`, so a production bundle cannot be talked into
 * opening itself with an environment variable. This is the whole reason the
 * check is written as a deny-list of one rather than as a plain flag read: a
 * flag named `OPEN_ACCESS` that worked in production would be a single
 * misconfigured `.env` away from publishing every customer's portfolio.
 *
 * TURNING IT OFF
 * Set `OPEN_ACCESS="false"` (or delete the line) in `.env` and restart
 * `npm run dev`. The login screen comes back and the seeded demo accounts work
 * exactly as before.
 *
 * WHAT IT DOES *NOT* DO
 * It does not create data. Every screen reads from PostgreSQL, and this flag
 * does not change that — with no database reachable the app opens but the
 * screens render their empty/error states. See the README's "Local setup".
 */

import type { Session } from "next-auth";
import type { ClientType, UserRole } from "@/types";

/**
 * The identity every open-access session is attributed to.
 *
 * ADMIN is deliberate: it is the only role the portfolio-scoping helpers in
 * `src/lib/api/guard.ts` treat as unscoped, so open access shows the whole
 * fleet rather than one customer's slice of it. A `BUILDING_OWNER` stand-in
 * would look like a broken app with almost every screen empty.
 *
 * The id is a sentinel, not a real `User` row. Reads are unaffected (ADMIN is
 * unscoped), but writes that set a foreign key to the acting user — creating a
 * work order, for instance — will fail until a real database is seeded. That is
 * the correct outcome: silently inventing an owner for a work order would be
 * worse than refusing it.
 */
export const OPEN_ACCESS_USER: {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  clientType: ClientType | null;
} = {
  id: "open-access-local",
  // Shown in the app shell as the signed-in user, so it is French like the rest
  // of the interface.
  name: "Accès local",
  email: "local@elevatorpulse.dev",
  role: "ADMIN",
  // Staff are neither contracted nor not: the column only means anything on a
  // client account. Null here reads as contracted, which is what keeps the
  // synthetic ADMIN session out of the non-contracted portal.
  clientType: null,
};

/**
 * True when the operator has opted in *and* this is not a production process.
 *
 * `process.env.OPEN_ACCESS` is written as a literal member expression on
 * purpose — Next.js replaces that exact form with the inlined value at build
 * time, and a computed `process.env[name]` would not be inlined in the Edge
 * middleware bundle, where it would silently read as `undefined`.
 */
export function isOpenAccessEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.OPEN_ACCESS === "true";
}

/** The synthetic session handed to every caller while open access is on. */
export function openAccessSession(): Session {
  return {
    user: { ...OPEN_ACCESS_USER },
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

if (isOpenAccessEnabled()) {
  console.warn(
    "[auth] ACCÈS LIBRE ACTIVÉ — toute requête est traitée comme ADMIN et " +
      "aucune connexion n'est requise. Développement uniquement ; mettez " +
      'OPEN_ACCESS="false" dans .env pour rétablir l' +
      "écran de connexion."
  );
}
