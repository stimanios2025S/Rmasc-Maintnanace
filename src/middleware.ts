import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";
import { isOpenAccessEnabled } from "@/lib/auth/open-access";
import { MANAGEMENT_ROLES, OPS_ROLES } from "@/types";

/**
 * Route protection.
 *
 * Public:
 *   - `/connexion`              (redirects to /tableau-de-bord when signed in)
 *   - `/api/auth/*`             (NextAuth handlers)
 *   - `/api/health`             (liveness/readiness probes)
 *   - `POST /api/telemetry`     (IoT devices; separately guarded by the
 *                                `IOT_INGEST_TOKEN` bearer check inside the
 *                                handler)
 *
 * Everything else requires a signed-in user. `/technicien` additionally
 * requires an ops role.
 *
 * Page paths are French, matching the rest of the interface; the `/api/*`
 * surface is not, because it is a contract with the IoT gateway, the Prisma
 * seed and NextAuth's own `/api/auth/[...nextauth]` route. The two sets are
 * independent — nothing derives a page path from an endpoint name.
 *
 * Note on the telemetry exemption: it is deliberately limited to POST. The
 * previous check was `pathname.startsWith("/api/telemetry")` with no method
 * test, which also published `GET /api/telemetry` — the entire fleet's live
 * sensor readings and building names — to unauthenticated callers.
 *
 * This is a coarse gate. Per-route role checks live in
 * `src/lib/api/guard.ts` and are the authoritative authorisation boundary.
 *
 * Local open-access mode (`OPEN_ACCESS="true"`, never active in production)
 * bypasses this gate entirely so the app can be browsed without signing in.
 * See `src/lib/auth/open-access.ts`.
 */
export default withAuth(
  function middleware(req) {
    const { pathname } = req.nextUrl;
    const token = req.nextauth.token;

    // Open access: there is no token to inspect, so the role gate below has
    // nothing to read. Bail out before it and let the request through — the
    // synthetic session in `getSession()` supplies the ADMIN identity that the
    // route handlers authorise against.
    if (isOpenAccessEnabled()) {
      if (pathname === "/connexion") {
        return NextResponse.redirect(new URL("/tableau-de-bord", req.url));
      }
      return NextResponse.next();
    }

    // Signed-in users hitting /connexion go straight to the dashboard
    if (pathname === "/connexion" && token) {
      return NextResponse.redirect(new URL("/tableau-de-bord", req.url));
    }

    // Field portal is restricted to ops roles. The list is imported rather
    // than re-typed, so it cannot drift from the server-side guard.
    if (pathname === "/technicien" || pathname.startsWith("/technicien/")) {
      const role = token?.role;
      if (!role || !OPS_ROLES.includes(role)) {
        return NextResponse.redirect(new URL("/tableau-de-bord", req.url));
      }
    }

    // The « Fiche Technique » board: every non-contract client's address,
    // capacity and installation details. Gated to the same ops roles as the
    // field portal rather than to management, because the technicians who
    // complete the technical columns are its intended readers. A building
    // owner must not see it — the API scopes their reads to their own sheets,
    // and this keeps the page itself out of reach.
    if (
      pathname === "/fiches-techniques" ||
      pathname.startsWith("/fiches-techniques/")
    ) {
      const role = token?.role;
      if (!role || !OPS_ROLES.includes(role)) {
        return NextResponse.redirect(new URL("/tableau-de-bord", req.url));
      }
    }

    // Account administration. Narrower than the management gate that covers
    // the rest of `/administration`: opening a customer account and deciding
    // whether it holds a maintenance contract is the administrator's job
    // specifically, and `/api/clients` enforces the same rule. Checked before
    // the broader block so the intent reads in order.
    if (
      pathname === "/administration/clients" ||
      pathname.startsWith("/administration/clients/")
    ) {
      if (token?.role !== "ADMIN") {
        return NextResponse.redirect(new URL("/tableau-de-bord", req.url));
      }
    }

    // The dispatch board: escalated faults, emergency transfers and the
    // technician roster. A building owner who reaches it would see every
    // other customer's incidents and the company's staffing, so it is gated
    // here as well as in the route handlers.
    if (
      pathname === "/administration" ||
      pathname.startsWith("/administration/")
    ) {
      const role = token?.role;
      if (!role || !MANAGEMENT_ROLES.includes(role)) {
        return NextResponse.redirect(new URL("/tableau-de-bord", req.url));
      }
    }

    // `/client` is deliberately *not* role-gated: a building owner is its
    // intended user, but an administrator has to be able to open it to see
    // what a customer sees. The incident API scopes every read to the caller,
    // so an admin sees an admin's view of the same screen.

    return NextResponse.next();
  },
  {
    callbacks: {
      authorized: ({ token, req }) => {
        const { pathname } = req.nextUrl;

        // Open access admits everything, signed in or not. This is the coarse
        // gate only — the authoritative per-route role checks in
        // `src/lib/api/guard.ts` still run, and in this mode they see the
        // synthetic ADMIN session rather than nothing.
        if (isOpenAccessEnabled()) {
          return true;
        }

        if (pathname === "/connexion" || pathname.startsWith("/api/auth")) {
          return true;
        }

        if (pathname === "/api/health") {
          return true;
        }

        // IoT ingestion only — and only for POST. The handler separately
        // checks the `IOT_INGEST_TOKEN` bearer, so an unauthenticated POST is
        // not automatically an authorised one.
        //
        // GET (and any other method) must still require a session. Returning
        // a bare `req.method === "POST"` short-circuited the whole callback
        // with `false` for every other verb, which made the route handler's
        // GET branch — telemetry history and latest snapshots — permanently
        // unreachable, even for a signed-in admin.
        if (pathname === "/api/telemetry") {
          return req.method === "POST" ? true : !!token;
        }

        return !!token;
      },
    },
    pages: { signIn: "/connexion" },
  }
);

export const config = {
  matcher: [
    "/tableau-de-bord/:path*",
    "/ascenseurs/:path*",
    "/bons-de-travail/:path*",
    "/technicien/:path*",
    "/fiches-techniques/:path*",
    "/client/:path*",
    "/administration/:path*",
    "/rapports-inspection/:path*",
    "/connexion",
    "/api/:path*",
  ],
};
