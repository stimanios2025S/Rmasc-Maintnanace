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
import type { UserRole } from "@/types";

declare module "next-auth" {
  interface User {
    role: UserRole;
  }

  interface Session {
    user: {
      id: string;
      role: UserRole;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: UserRole;
  }
}
