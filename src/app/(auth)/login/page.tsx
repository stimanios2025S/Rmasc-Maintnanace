"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Activity, Eye, EyeOff, LogIn } from "lucide-react";

const QUICK_ACCESS = [
  {
    role: "Admin",
    email: "admin@elevatorpulse.com",
    color:
      "bg-purple-50 border-purple-200 text-purple-700 hover:bg-purple-100 dark:bg-purple-900/20 dark:border-purple-800 dark:text-purple-300",
  },
  {
    role: "Manager",
    email: "manager@elevatorpulse.com",
    color:
      "bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/20 dark:border-blue-800 dark:text-blue-300",
  },
  {
    role: "Technician",
    email: "tech1@elevatorpulse.com",
    color:
      "bg-green-50 border-green-200 text-green-700 hover:bg-green-100 dark:bg-green-900/20 dark:border-green-800 dark:text-green-300",
  },
  {
    role: "Building Owner",
    email: "owner@metroplaza.com",
    color:
      "bg-orange-50 border-orange-200 text-orange-700 hover:bg-orange-100 dark:bg-orange-900/20 dark:border-orange-800 dark:text-orange-300",
  },
];

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState<string | null>(null);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");

    const result = await signIn("credentials", {
      email: email.trim().toLowerCase(),
      password,
      redirect: false,
    });

    setIsLoading(false);

    if (result?.error) {
      if (result.error.includes("AuthServiceUnavailable")) {
        setError(
          "Auth service unavailable — the database may be down or unseeded. Run the backend first, then retry."
        );
      } else {
        setError("Invalid email or password. Please try again.");
      }
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
      if (result.error.includes("AuthServiceUnavailable")) {
        setError(
          "Auth service unavailable — the database may be down or unseeded. Run: npx prisma db push && npm run db:seed, then restart npm run dev."
        );
      } else {
        setError(
          "Demo account not found or password mismatch. Run npm run db:seed, then tap Admin again."
        );
      }
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
            ElevatorPulse
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Predictive Maintenance Platform
          </p>
        </div>

        {/* Login Card */}
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-xl p-8">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-6">
            Sign in to your account
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
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="w-full px-4 py-2.5 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5"
              >
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-4 py-2.5 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent pr-10"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
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
                  Sign In
                </>
              )}
            </button>
          </form>
        </div>

        {/* Quick Access — one tap signs you in directly */}
        <div className="mt-6 bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <p className="text-xs text-gray-500 text-center mb-3 font-medium uppercase tracking-wider">
            Quick Demo Access — tap to sign in instantly
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
                  {busy ? "Signing in…" : `Sign in as ${item.role}`}
                </button>
              );
            })}
          </div>
          <p className="text-[10px] text-gray-400 text-center mt-2">
            Demo password for all accounts: password123
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
