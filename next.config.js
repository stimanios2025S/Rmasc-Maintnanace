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
