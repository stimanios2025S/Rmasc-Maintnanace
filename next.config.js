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

  /**
   * The page routes were renamed to French. These redirects keep the old
   * English addresses working, because they are already out in the world:
   * bookmarks, links in notification rows written before the rename, and any
   * message a customer was sent. Only page paths are redirected — `/api/*`
   * keeps its English names, which are a contract with the IoT gateway,
   * NextAuth and the seeded scripts, and none of the sources below touch it.
   */
  async redirects() {
    const RENAMED = [
      ["/dashboard", "/tableau-de-bord"],
      ["/elevators", "/ascenseurs"],
      ["/work-orders", "/bons-de-travail"],
      ["/technician", "/technicien"],
      ["/inspection-reports", "/rapports-inspection"],
      ["/login", "/connexion"],
      /*
       * Les deux adresses du parcours public, telles qu'elles sont nommées
       * dans les consignes d'exploitation. Elles n'existent pas comme pages :
       * le tableau des pannes est `/administration/incidents`, la carte est
       * `/carte`. Rediriger plutôt que dupliquer garde une seule définition
       * de chaque écran.
       */
      ["/administration/pannes", "/administration/incidents"],
      ["/supervision", "/carte"],
      /*
       * Les adresses « métier » des deux registres. Elles ne sont pas des
       * pages : la reprise d'appareil vit dans `/administration/ascenseurs`,
       * les fiches techniques dans `/fiches-techniques`. Rediriger évite deux
       * écrans jumeaux à maintenir.
       */
      ["/administration/reprises", "/administration/ascenseurs"],
      ["/administration/fiches-techniques", "/fiches-techniques"],
      ["/administration/prospects", "/fiches-techniques"],
    ];

    return [
      /*
       * Le QR code apposé sur les appareils pointe vers /qr-appareil.
       * Next ne sert pas automatiquement l'index d'un dossier de `public` ;
       * cette redirection exacte ouvre la fiche statique sans toucher aux
       * fichiers voisins (machine.png, manuel-ascenseur.pdf, etc.).
       */
      {
        source: "/qr-appareil",
        destination: "/qr-appareil/index.html",
        permanent: false,
      },
      /*
       * La racine de l'administration n'a pas d'écran.
       *
       * Ces deux règles sont *exactes* et volontairement hors de `RENAMED` :
       * y ajouter `/administration` produirait aussi la règle
       * `/administration/:path*` → `/tableau-de-bord/:path*`, qui enverrait
       * `/administration/pieces` vers une page inexistante. Seule la racine
       * redirige ; les sous-chemins gardent leur page.
       *
       * `/admin/:path*` conserve en revanche les anciens liens profonds
       * (`/admin/clients`, `/admin/personnel`…) vers leurs équivalents
       * français. Seul `/admin` nu mène au tableau de bord.
       */
      {
        source: "/administration",
        destination: "/tableau-de-bord",
        permanent: false,
      },
      {
        source: "/admin",
        destination: "/tableau-de-bord",
        permanent: false,
      },
      {
        source: "/admin/:path*",
        destination: "/administration/:path*",
        permanent: false,
      },
      ...RENAMED.flatMap(([from, to]) => [
        { source: from, destination: to, permanent: false },
        { source: `${from}/:path*`, destination: `${to}/:path*`, permanent: false },
      ]),
    ];
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Le tableau de bord n'est jamais destiné à être affiché dans un cadre.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            /*
             * `self` et non `()` : le portail technicien a besoin de la
             * géolocalisation pour le pointage géofencé et le suivi de
             * position, et le scanner QR a besoin de la caméra. Une politique
             * vide désactivait les deux sans le dire. Le microphone reste
             * fermé : rien dans l'application ne l'utilise.
             */
            value: "camera=(self), microphone=(), geolocation=(self)",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },

  experimental: {
    /**
     * `pdfkit` doit rester hors du bundle serveur.
     *
     * Ce n'est pas une optimisation, c'est ce qui le fait fonctionner. La
     * bibliothèque charge ses polices standard — Helvetica, Times, Courier —
     * depuis des fichiers `.afm` posés à côté d'elle et lus avec `fs` à partir
     * de son propre `__dirname`. Une fois le paquet avalé par le bundler, ce
     * chemin ne désigne plus rien, et la première facture échoue sur un
     * `ENOENT` qui ne mentionne ni la facture ni la police manquante.
     *
     * Exclue du bundle, elle est chargée par `require` au moment de l'exécution,
     * depuis `node_modules`, où ses fichiers sont bien à côté d'elle.
     */
    serverComponentsExternalPackages: ["pdfkit"],
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
