/**
 * NextAuth module augmentation.
 *
 * The JWT and Session objects carry `role` and `id` (populated by the
 * callbacks in `src/lib/auth/options.ts`). Declaring them here removes the
 * `(session.user as any).role` casts that previously hid type errors at
 * every call site.
 *
 * Note: these are declaration-merged interfaces, so the added properties are
 * merged into the existing ones rather than re-declared via `extends`.
 */

import type { DefaultSession } from "next-auth";
import type { ClientType, UserRole } from "@/types";

declare module "next-auth" {
  interface User {
    role: UserRole;
    /**
     * Contracted or not. Null on every staff account and, on a client, read as
     * contracted — see `isNonContractedClient` in `@/types`.
     */
    clientType?: ClientType | null;
  }

  interface Session {
    user: {
      id: string;
      role: UserRole;
      clientType: ClientType | null;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: UserRole;
    clientType: ClientType | null;
    /**
     * `false` quand le compte a été désactivé (ou supprimé) après l'émission
     * du jeton. La session est alors vidée et le cookie expiré ; le middleware
     * refuse le jeton avant même d'atteindre une page protégée.
     */
    isActive?: boolean;
  }
}
