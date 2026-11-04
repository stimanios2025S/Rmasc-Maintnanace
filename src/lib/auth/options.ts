import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db/prisma";
import type { UserRole } from "@/types";

/**
 * A structurally valid bcrypt hash (60 chars: `$2a$12$` + 22-char salt +
 * 31-char digest) used to equalise the cost of a login attempt for an
 * unknown account against one for a known account.
 *
 * It MUST parse as a real bcrypt hash. A malformed string such as
 * "$2a$12$invalidinvalid..." makes bcryptjs bail out on an early structural
 * check without performing any key derivation, which defeats the entire
 * purpose of the dummy compare and re-opens the account-enumeration oracle
 * the surrounding code is trying to close.
 *
 * Nothing ever authenticates against this value — the comparison result is
 * deliberately discarded. It only needs to be expensive to compute.
 */
const TIMING_EQUALISATION_HASH =
  "$2a$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW";

const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60; // 24 hours

// Enforcement of NEXTAUTH_SECRET in production lives in
// `src/lib/config/env.ts`, which is evaluated at module load via the Prisma
// client that every data-touching route already imports.
//
// It is deliberately NOT duplicated here as a module-level throw: this file is
// imported during `next build` to collect route metadata, so throwing would
// fail the *build* in any CI job that does not inject runtime secrets — the
// wrong failure at the wrong time. `env.ts` skips validation during the build
// phase and enforces it on server start.

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        // Only ever rendered by NextAuth's built-in sign-in page, which this
        // application does not use — `/connexion` posts these fields itself.
        // Translated anyway so the fallback page is not the one English screen
        // left in the product.
        email: { label: "Adresse e-mail", type: "email" },
        password: { label: "Mot de passe", type: "password" },
      },
      async authorize(credentials) {
        try {
          if (!credentials?.email || !credentials?.password) return null;

          const email = credentials.email.trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;

          const user = await prisma.user.findUnique({
            where: { email },
          });

          if (!user || !user.isActive) {
            // Burn equivalent CPU so response time does not reveal whether
            // the account exists. The result is intentionally discarded.
            await bcrypt.compare(
              credentials.password,
              TIMING_EQUALISATION_HASH
            );
            return null;
          }

          const isValid = await bcrypt.compare(
            credentials.password,
            user.passwordHash
          );

          if (!isValid) return null;

          return {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            clientType: user.clientType,
          };
        } catch (error) {
          // DB down, schema drift, etc. Log the real cause server-side and
          // signal the login form so it shows "service unavailable"
          // instead of the misleading "invalid password".
          console.error("[auth][authorize] failed:", error);
          throw new Error("AuthServiceUnavailable");
        }
      },
    }),
  ],
  session: {
    strategy: "jwt",
    maxAge: SESSION_MAX_AGE_SECONDS,
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = user.role;
        token.id = user.id;
        token.clientType = user.clientType ?? null;
        token.isActive = true;
        return token;
      }

      /**
       * Un jeton existant est revérifié à chaque lecture de session.
       *
       * La stratégie est JWT : sans cette lecture, désactiver un compte ou
       * changer son rôle ne prenait effet qu'à l'expiration du cookie, soit
       * jusqu'à 24 h. Le prix est une requête par lecture de session ; c'est
       * le compromis retenu pour que « désactivé » veuille dire désactivé.
       */
      const dbUser = token.id
        ? await prisma.user.findUnique({
            where: { id: token.id },
            select: { isActive: true, role: true, clientType: true },
          })
        : null;

      if (!dbUser || dbUser.isActive === false) {
        token.isActive = false;
        token.id = "";
        token.role = "" as UserRole;
        token.clientType = null;
        // Expire le cookie : la requête suivante ne présentera plus ce jeton.
        token.exp = 0;
        return token;
      }

      token.isActive = true;
      token.role = dbUser.role;
      token.clientType = dbUser.clientType ?? null;
      return token;
    },
    async session({ session, token }) {
      /**
       * Une session invalidée reste un objet `Session` valide — le type
       * augmenté exige `user` — mais sans identité exploitable : `id` et
       * `role` sont vides, et `requireSession` refuse cet état.
       */
      if (token.isActive === false || !token.id || !token.role) {
        if (session.user) {
          session.user.id = "";
          session.user.role = "" as UserRole;
          session.user.clientType = null;
        }
        session.expires = new Date(0).toISOString();
        return session;
      }

      if (session.user) {
        session.user.role = token.role;
        session.user.id = token.id;
        session.user.clientType = token.clientType ?? null;
      }
      return session;
    },
  },
  pages: {
    // Must match `pages.signIn` in `src/middleware.ts` and the `/connexion`
    // folder under `src/app/(auth)/`: NextAuth sends an unauthenticated visitor
    // here, and a mismatch would land them on the built-in English form.
    signIn: "/connexion",
  },
  debug: process.env.NODE_ENV === "development",
  secret: process.env.NEXTAUTH_SECRET,
};
