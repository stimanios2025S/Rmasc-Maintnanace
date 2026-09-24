/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Do not advertise the framework version on every response.
  poweredByHeader: false,

  images: {
    // Was `hostname: '**'`, which turns the image optimiser into an open proxy
    // for any HTTPS origin. Nothing in the app loads a remote image, so the
    // list is empty; add explicit hosts (e.g. your CDN) if that changes.
    remotePatterns: [],

    /**
     * AVIF is dropped from the negotiation list, leaving WebP as the only
     * modern format the optimiser will emit.
     *
     * Next.js defaults to `['image/avif', 'image/webp']`. AVIF output is the
     * path named by GHSA-2xp9-vwfh-vxw4 — unauthenticated RCE in the Image
     * Optimization API when AVIF is used. Next 14.2 carries no patch for it;
     * the fix shipped in Next 16, which is a two-major-version upgrade this
     * project has not taken. Removing AVIF closes that path today without
     * touching application code: nothing here uses `next/image` at all (no
     * import under `src/`, and `public/` is empty), so no rendered image loses
     * anything by it. Add `image/avif` back only alongside the Next 16 move.
     *
     * This is a mitigation, not a fix. The rest of the advisory list covers
     * surfaces this app does not use — Server Actions, rewrites, middleware,
     * CSP nonces, Windows hosting — and is tracked with the upgrade.
     */
    formats: ["image/webp"],
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // The dashboard is never meant to be framed.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },

  // NOTE: the previous config declared `experimental.serverActions.bodySizeLimit`
  // but the codebase contains no Server Actions — every mutation goes through a
  // route handler. The dead block has been removed.
  //
  // A Content-Security-Policy is deliberately not set here: Next.js injects
  // inline bootstrap scripts, so a meaningful CSP requires per-request nonces
  // threaded through `src/middleware.ts`. Adding a permissive placeholder
  // policy would give the appearance of protection without the substance.
};

module.exports = nextConfig;
