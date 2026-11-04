"use client";

import { useEffect, useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";
import {
  ArrowRight,
  ArrowUpDown,
  Loader2,
  Moon,
  QrCode,
  Sun,
} from "lucide-react";

type Theme = "light" | "dark";

export default function HomePage() {
  const [theme, setTheme] = useState<Theme>("dark");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let stored: string | null = null;

    try {
      stored = localStorage.getItem("rmasc-theme");
    } catch {
      stored = null;
    }

    const initial: Theme =
      stored === "light" || stored === "dark" ? stored : "dark";

    setTheme(initial);
    document.documentElement.classList.toggle("dark", initial === "dark");
  }, []);

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";

    setTheme(next);
    document.documentElement.classList.toggle("dark", next === "dark");

    try {
      localStorage.setItem("rmasc-theme", next);
    } catch {
      /* Stockage indisponible : le thème reste valable pour la session. */
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (!email.trim() || !password) {
      setError("Renseignez votre identifiant et votre mot de passe.");
      return;
    }

    setLoading(true);

    try {
      const result = await signIn("credentials", {
        email: email.trim(),
        password,
        redirect: false,
        callbackUrl: "/client",
      });

      if (!result || result.error) {
        setError(
          "Identifiant ou mot de passe incorrect, ou service de connexion indisponible."
        );
        setLoading(false);
        return;
      }

      window.location.href = result.url || "/client";
    } catch {
      setError("Connexion indisponible pour le moment. Réessayez dans un instant.");
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-[100svh] overflow-hidden bg-slate-950">
      <style>{`
        @keyframes landingDrift {
          from { transform: scale(1.03) translate3d(-1.2%, -0.8%, 0); }
          to { transform: scale(1.1) translate3d(1.2%, 0.8%, 0); }
        }

        .landing-bg {
          animation: landingDrift 22s ease-in-out infinite alternate;
        }

        @media (prefers-reduced-motion: reduce) {
          .landing-bg { animation: none; }
        }
      `}</style>

      <div
        className="landing-bg absolute -inset-[4%] bg-cover bg-center"
        style={{
          backgroundImage: "url('/qr-appareil/technician-maintenance.png')",
        }}
      />
      <div className="absolute inset-0 bg-[rgba(10,15,29,0.72)] backdrop-blur-[3px]" />

      <header className="relative z-20 flex items-center justify-between px-5 py-4 sm:px-8">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-950/40">
            <ArrowUpDown className="h-5 w-5" aria-hidden="true" />
          </span>
          <span className="text-sm font-black tracking-[0.2em] text-white">
            RMASC
          </span>
        </div>

        <button
          type="button"
          onClick={toggleTheme}
          aria-label={
            theme === "dark" ? "Passer en mode clair" : "Passer en mode sombre"
          }
          title={theme === "dark" ? "Mode clair" : "Mode sombre"}
          className="grid h-10 w-10 place-items-center rounded-xl border border-white/15 bg-white/10 text-white backdrop-blur transition hover:border-cyan-300/60 hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/40"
        >
          {theme === "dark" ? (
            <Sun className="h-5 w-5" aria-hidden="true" />
          ) : (
            <Moon className="h-5 w-5" aria-hidden="true" />
          )}
        </button>
      </header>

      <main className="relative z-20 flex min-h-[calc(100svh-76px)] items-center justify-center px-4 pb-10 pt-2">
        <section className="w-full max-w-[460px] rounded-[22px] border border-white/15 bg-[rgba(10,15,29,0.75)] p-6 text-white shadow-[0_30px_80px_-30px_rgba(0,0,0,0.85)] backdrop-blur-[8px] sm:p-7">
          <p className="text-[0.64rem] font-extrabold uppercase tracking-[0.18em] text-cyan-300">
            Espace client sous contrat
          </p>
          <h1 className="mt-2 text-[1.5rem] font-bold leading-tight tracking-[-0.02em] text-white">
            Accéder à votre espace
          </h1>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
            Réservé aux clients sous contrat disposant déjà d&apos;un compte.
          </p>

          <form onSubmit={handleSubmit} className="mt-5 grid gap-3.5" noValidate>
            <label className="grid gap-1.5 text-[0.78rem] font-semibold text-slate-200">
              Identifiant / e-mail
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                placeholder="vous@exemple.dz"
                required
                className="h-12 w-full rounded-xl border border-white/15 bg-white/5 px-3.5 text-sm font-normal text-white outline-none transition placeholder:text-slate-400 focus:border-cyan-300/70 focus:ring-2 focus:ring-cyan-300/15"
              />
            </label>

            <label className="grid gap-1.5 text-[0.78rem] font-semibold text-slate-200">
              Mot de passe
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder="Votre mot de passe"
                required
                className="h-12 w-full rounded-xl border border-white/15 bg-white/5 px-3.5 text-sm font-normal text-white outline-none transition placeholder:text-slate-400 focus:border-cyan-300/70 focus:ring-2 focus:ring-cyan-300/15"
              />
            </label>

            {error ? (
              <p className="text-[0.78rem] font-medium text-rose-300" role="alert">
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={loading}
              className="mt-1 inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white shadow-lg shadow-blue-950/30 transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {loading ? "Connexion…" : "Se connecter"}
            </button>
          </form>

          <p className="mt-4 text-[0.72rem] leading-relaxed text-slate-400">
            Les personnes hors contrat n&apos;ont pas de compte et ne peuvent pas
            se connecter ici.
          </p>

          <div className="my-5 flex items-center gap-3 text-[0.62rem] font-extrabold uppercase tracking-[0.18em] text-slate-400">
            <span className="h-px flex-1 bg-white/15" />
            OU
            <span className="h-px flex-1 bg-white/15" />
          </div>

          <a
            href="/qr-appareil"
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 text-sm font-bold text-white transition hover:border-cyan-300/60 hover:bg-cyan-300/10 hover:text-cyan-200"
          >
            <QrCode className="h-4 w-4" aria-hidden="true" />
            Signaler une panne par QR Code
            <ArrowRight className="ml-auto h-4 w-4" aria-hidden="true" />
          </a>
        </section>
      </main>
    </div>
  );
}
