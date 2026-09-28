"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Activity, Eye, EyeOff, LogIn } from "lucide-react";

const QUICK_ACCESS = [
  {
    role: "Administrateur",
    email: "admin@elevatorpulse.com",
    color:
      "bg-purple-50 border-purple-200 text-purple-700 hover:bg-purple-100 dark:bg-purple-900/20 dark:border-purple-800 dark:text-purple-300",
  },
  {
    role: "Responsable maintenance",
    email: "manager@elevatorpulse.com",
    color:
      "bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/20 dark:border-blue-800 dark:text-blue-300",
  },
  {
    role: "Technicien de terrain",
    email: "tech1@elevatorpulse.com",
    color:
      "bg-green-50 border-green-200 text-green-700 hover:bg-green-100 dark:bg-green-900/20 dark:border-green-800 dark:text-green-300",
  },
  {
    role: "Propriétaire d'immeuble",
    email: "owner@metroplaza.com",
    color:
      "bg-orange-50 border-orange-200 text-orange-700 hover:bg-orange-100 dark:bg-orange-900/20 dark:border-orange-800 dark:text-orange-300",
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
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-blue-50 dark:from-gray-950 dark:via-gray-900 dark:to-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-600/25">
            <Activity className="w-9 h-9 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Maintenance RMASC
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Plateforme de maintenance prédictive
          </p>
        </div>

        {/* Login Card */}
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-xl p-8">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-6">
            Connectez-vous à votre compte
          </h2>

          {error && (
            <div
              role="alert"
              className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 mb-4"
            >
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5"
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
                className="w-full px-4 py-2.5 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5"
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
                  className="w-full px-4 py-2.5 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent pr-10"
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
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
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

        {/* Quick Access — one tap signs you in directly */}
        <div className="mt-6 bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <p className="text-xs text-gray-500 text-center mb-3 font-medium uppercase tracking-wider">
            Accès démo rapide — connexion immédiate en un appui
          </p>
          <div className="grid grid-cols-2 gap-2">
            {QUICK_ACCESS.map((item) => {
              const busy = demoLoading === item.email;
              return (
                <button
                  key={item.role}
                  type="button"
                  disabled={busy || isLoading}
                  onClick={() => quickLogin(item.email)}
                  className={`px-3 py-2 text-xs font-medium rounded-lg border transition-colors flex items-center justify-center gap-1.5 disabled:opacity-60 disabled:cursor-wait ${item.color}`}
                >
                  {busy && (
                    <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  )}
                  {busy ? "Connexion…" : `Se connecter en tant que ${item.role}`}
                </button>
              );
            })}
          </div>
          <p className="text-[10px] text-gray-400 text-center mt-2">
            Mot de passe de démonstration pour tous les comptes : password123
          </p>
        </div>
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
