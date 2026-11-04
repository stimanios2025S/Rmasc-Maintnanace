"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Activity, Eye, EyeOff, LogIn } from "lucide-react";

/**
 * Les deux raccourcis demandés, et seulement ceux-là.
 *
 * Ils restent sous la garde `NODE_ENV === "development"` plus bas : ces boutons
 * appellent `signIn` avec le mot de passe de démonstration, et une page de
 * connexion publique qui distribue un accès administrateur est exactement ce
 * que ce panneau avait un jour produit. En développement, il rend un vrai
 * service ; dans un lot de production, le code n'existe pas.
 */
const QUICK_ACCESS = [
  {
    role: "Admin",
    email: "admin@elevatorpulse.com",
    dot: "🔴",
    color:
      "border-red-500/40 bg-red-500/10 text-red-100 hover:bg-red-500/20",
  },
  {
    role: "Technicien",
    email: "tech1@elevatorpulse.com",
    dot: "🟢",
    color:
      "border-green-500/40 bg-green-500/10 text-green-100 hover:bg-green-500/20",
  },
];

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/tableau-de-bord";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState<string | null>(null);
  const [error, setError] = useState("");

  /**
   * NextAuth's error codes, in words a person can act on.
   *
   * The default is the raw code, NOT the credentials message. That default is
   * the point: this page used to report every failure that was not
   * "AuthServiceUnavailable" as « adresse e-mail ou mot de passe incorrect »,
   * so an expired CSRF token, a 500, or a page left open in a background tab
   * since yesterday all read as "you typed it wrong" — and sent the reader off
   * to retype a password that was never the problem.
   */
  const AUTH_ERROR_MESSAGES: Record<string, string> = {
    CredentialsSignin:
      "Adresse e-mail ou mot de passe incorrect. Veuillez réessayer.",
    MissingCSRF:
      "La page est restée ouverte trop longtemps : sa session de sécurité a expiré. Rechargez la page, puis reconnectez-vous.",
    SessionRequired: "Votre session a expiré. Reconnectez-vous.",
  };

  const messageFor = (code: string): string => {
    if (code.includes("AuthServiceUnavailable")) {
      return "Service d'authentification indisponible — la base de données est peut-être arrêtée ou non initialisée.";
    }
    return AUTH_ERROR_MESSAGES[code] ?? `La connexion a échoué (${code}).`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");

    /**
     * Read the values out of the form, not out of React state.
     *
     * State is only as fresh as the last `onChange` React saw, and on a phone
     * that is not always the last thing that happened. Android Chrome and iOS
     * Safari fill a field from the keyboard's password manager *without*
     * dispatching a change event React is listening for, so the input displays
     * the address while the component still holds "". Submitting then posts an
     * empty e-mail, the server refuses, and the reader is told their address is
     * wrong while looking straight at it on the screen.
     *
     * The DOM value is the one the person can actually see, so that is the one
     * to send. The state stays as the fallback for anything that fills the
     * fields without a submit event.
     */
    const form = e.currentTarget as HTMLFormElement;
    const submitted = new FormData(form);

    const submittedEmail = String(submitted.get("email") ?? email)
      .trim()
      .toLowerCase();
    const submittedPassword = String(submitted.get("password") ?? password);

    const result = await signIn("credentials", {
      email: submittedEmail,
      password: submittedPassword,
      redirect: false,
    });

    setIsLoading(false);

    if (result?.error) {
      setError(messageFor(result.error));
      return;
    }

    router.push(callbackUrl);
    router.refresh();
  };

  const quickLogin = async (roleEmail: string) => {
    setEmail(roleEmail);
    setPassword("password123");
    setError("");
    setDemoLoading(roleEmail);

    const result = await signIn("credentials", {
      email: roleEmail.trim().toLowerCase(),
      password: "password123",
      redirect: false,
    });

    setDemoLoading(null);

    if (result?.error) {
      setError(messageFor(result.error));
      return;
    }

    router.push(callbackUrl);
    router.refresh();
  };

  return (
    <div className="relative flex min-h-[100svh] items-center justify-center overflow-hidden bg-slate-950 p-4">
      {/*
        Arrière-plan animé : le visuel 3D de l'ascenseur, en dérive lente.
        Aucun GIF ni vidéo n'est livré dans `public/` ; ce fond animé en CSS
        remplit le même rôle sans dépendre d'un média externe, et il est
        immobile pour qui a demandé moins d'animations.
      */}
      <style>{`
        @keyframes loginDrift {
          from { transform: scale(1.05) translate3d(-1.2%, -0.8%, 0); }
          to   { transform: scale(1.14) translate3d(1.2%, 0.8%, 0); }
        }
        .login-bg { animation: loginDrift 26s ease-in-out infinite alternate; }
        @media (prefers-reduced-motion: reduce) {
          .login-bg { animation: none; }
        }
      `}</style>

      <div
        className="login-bg absolute -inset-[6%] bg-cover bg-center"
        style={{ backgroundImage: "url('/qr-appareil/preview-hero-3d.png')" }}
        aria-hidden="true"
      />
      <div
        className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"
        aria-hidden="true"
      />

      <div className="relative z-10 w-full max-w-md">
        {/* Logo */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-600 shadow-lg shadow-blue-600/30">
            <Activity className="h-9 w-9 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">
            Maintenance RMASC
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Plateforme de maintenance prédictive
          </p>
        </div>

        {/* Carte en verre fumé */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl backdrop-blur-xl">
          <h2 className="mb-6 text-lg font-semibold text-white">
            Connectez-vous à votre compte
          </h2>

          {error && (
            <div
              role="alert"
              className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3"
            >
              <p className="text-sm text-red-200">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="mb-1.5 block text-sm font-medium text-slate-300"
              >
                Adresse e-mail
              </label>
              {/*
                `name` is not decoration: `handleSubmit` reads the submitted
                values with `new FormData(form)`, and an input without one is
                simply absent from it.

                `autoComplete="username"` rather than "email" because password
                managers key their saved credentials on that token, and it is
                what pairs the address with the password box below.

                The next four attributes are for phone keyboards. `type="email"`
                suppresses capitalisation in most browsers but not all of them,
                and a leading capital is invisible on a phone screen — the
                address looks right and arrives wrong.
              */}
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="vous@entreprise.com"
                className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="mb-1.5 block text-sm font-medium text-slate-300"
              >
                Mot de passe
              </label>
              <div className="relative">
                {/* Same as the address above: a password is not a word, and the
                    keyboard must not capitalise or correct it. */}
                <input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-4 py-2.5 pr-10 text-sm text-white placeholder:text-slate-500 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={
                    showPassword
                      ? "Masquer le mot de passe"
                      : "Afficher le mot de passe"
                  }
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                >
                  {showPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  <LogIn className="w-4 h-4" />
                  Se connecter
                </>
              )}
            </button>
          </form>
        </div>

        {/*
          ACCÈS DÉMO — INTERDIT EN PRODUCTION, ET CE N'ÉTAIT PAS LE CAS.

          Ces boutons ne sont pas une aide à la saisie : ils appellent
          `signIn("credentials")` avec le mot de passe de démonstration, écrit
          en clair juste en dessous. Rendus en production — et ils l'étaient —
          la page de connexion distribuait un accès administrateur à quiconque
          la chargeait, sur une URL publique.

          Les gardes serveur de `auth/open-access.ts` et `demo/mode.ts` n'y
          pouvaient rien, et ce n'est pas un défaut de leur part : elles
          protègent l'authentification, pas la distribution des identifiants.
          Un mot de passe affiché à l'écran rend inutile toute vérification
          faite derrière lui.

          `process.env.NODE_ENV` est remplacé par sa valeur à la construction.
          Dans un lot de production la condition devient `"production" ===
          "development"`, donc `false`, et le panneau disparaît du JavaScript
          livré : il n'est pas masqué, il n'existe pas. Le masquer n'aurait pas
          suffi — les identifiants seraient restés lisibles dans le contenu de
          la page. La garde est désormais strictement `"development"` : un
          environnement `test` ou tout autre valeur ne l'ouvre pas non plus.

          Le panneau reste tel quel en développement, où il rend un vrai
          service : sans base de données, il n'existe aucun compte à qui se
          connecter.
        */}
        {process.env.NODE_ENV === "development" && (
          <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-900/70 p-5 shadow-xl backdrop-blur-xl">
            <p className="mb-3 text-center text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Accès démo — connexion en un appui
            </p>
            <div className="grid grid-cols-2 gap-3">
              {QUICK_ACCESS.map((item) => {
                const busy = demoLoading === item.email;
                return (
                  <button
                    key={item.role}
                    type="button"
                    disabled={busy || isLoading}
                    onClick={() => quickLogin(item.email)}
                    className={`flex flex-col items-center justify-center gap-1 rounded-xl border px-3 py-3 text-sm font-bold transition-colors disabled:cursor-wait disabled:opacity-60 ${item.color}`}
                  >
                    <span className="flex items-center gap-1.5">
                      {busy ? (
                        <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      ) : (
                        <span aria-hidden="true">{item.dot}</span>
                      )}
                      {busy ? "Connexion…" : item.role}
                    </span>
                    <span className="max-w-full truncate text-[10px] font-normal opacity-70">
                      {item.email}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-blue-600/30 border-t-blue-600 rounded-full animate-spin" />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
