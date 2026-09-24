"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Search,
  Volume2,
  XCircle,
} from "lucide-react";
import { useSpeech } from "./use-speech";
import type { EmergencyElevator } from "./emergency-button";

/**
 * Guided troubleshooting for a building occupant.
 *
 * Three steps — which elevator, which code, follow these steps — and two ways
 * out: "the problem is fixed" or "it is not". The second is not a failure
 * state, it is the escalation path, and it is presented as an equal choice
 * rather than a discouraged one, because a client who cannot clear a fault
 * should not feel they have to keep trying.
 *
 * The whole flow is written in French. Its readers are tenants, not staff;
 * the staff-facing screens remain English.
 */

interface ErrorCodeOption {
  id: string;
  code: string;
  title: string;
  description: string;
  steps: string[];
  audioUrl: string | null;
}

type Step = "elevator" | "code" | "solution";

export function IncidentWizard({
  elevators,
  onSubmitted,
}: {
  elevators: EmergencyElevator[];
  onSubmitted: () => void;
}) {
  const { speak, supported, speaking, stop } = useSpeech();

  const [step, setStep] = useState<Step>("elevator");
  const [elevatorId, setElevatorId] = useState<string | null>(null);
  const [codes, setCodes] = useState<ErrorCodeOption[]>([]);
  const [loadingCodes, setLoadingCodes] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ErrorCodeOption | null>(null);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState<"resolved" | "escalated" | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  // The full code list is small (a few dozen at most) and is fetched once, so
  // filtering as the occupant types is instant and works with no round trip.
  // A per-keystroke search would be slower and would fail offline.
  useEffect(() => {
    let cancelled = false;
    setLoadingCodes(true);

    fetch("/api/error-codes")
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((payload) => {
        if (!cancelled && Array.isArray(payload?.data)) setCodes(payload.data);
      })
      .catch(() => {
        // Non-fatal: the occupant can still escalate without a code.
      })
      .finally(() => {
        if (!cancelled) setLoadingCodes(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return codes;
    return codes.filter(
      (c) =>
        c.code.toLowerCase().includes(q) ||
        c.title.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q)
    );
  }, [codes, query]);

  const elevator = elevators.find((e) => e.id === elevatorId) ?? null;

  function chooseElevator(id: string) {
    setElevatorId(id);
    setStep("code");
  }

  function chooseCode(code: ErrorCodeOption) {
    setSelected(code);
    setStep("solution");
    if (supported) {
      speak(`${code.title}. ${code.steps.join(". ")}`);
    }
  }

  function back() {
    stop();
    setError(null);
    if (step === "solution") {
      setSelected(null);
      setStep("code");
      return;
    }
    if (step === "code") {
      setStep("elevator");
    }
  }

  async function submit(outcome: "resolved" | "escalated") {
    if (!elevatorId) return;

    setSubmitting(outcome);
    setError(null);

    try {
      const res = await fetch("/api/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elevatorId,
          status: outcome === "resolved" ? "RESOLVED_BY_CLIENT" : "ESCALATED",
          isDirectTransfer: false,
          ...(selected ? { errorCodeId: selected.id } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error ?? "L'envoi a échoué.");
      }

      speak(
        outcome === "resolved"
          ? "Merci. Votre signalement est enregistré comme résolu."
          : "Merci. Un technicien va être envoyé."
      );

      // Back to the start, ready for the next problem.
      setStep("elevator");
      setElevatorId(null);
      setSelected(null);
      setQuery("");
      setNotes("");
      onSubmitted();
    } catch (err) {
      const message = err instanceof Error ? err.message : "L'envoi a échoué.";
      setError(message);
      speak("L'envoi a échoué. Veuillez réessayer.");
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <section
      aria-labelledby="signaler-heading"
      className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5"
    >
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2
            id="signaler-heading"
            className="text-lg font-bold text-gray-900 dark:text-white"
          >
            Signaler un problème
          </h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {step === "elevator" && "Étape 1 sur 3 — Quel ascenseur ?"}
            {step === "code" && "Étape 2 sur 3 — Quel code s'affiche ?"}
            {step === "solution" && "Étape 3 sur 3 — Suivez les instructions."}
          </p>
        </div>
        {step !== "elevator" && (
          <button
            type="button"
            onClick={back}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Retour
          </button>
        )}
      </header>

      {/* ── Step 1: which elevator ───────────────────────── */}
      {step === "elevator" && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {elevators.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Aucun ascenseur n&apos;est associé à votre compte.
            </p>
          ) : (
            elevators.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => chooseElevator(e.id)}
                className="rounded-xl border-2 border-gray-200 dark:border-gray-700 px-4 py-5 text-left transition-colors hover:border-blue-400 hover:bg-blue-50 dark:hover:border-blue-700 dark:hover:bg-blue-950/30"
              >
                <span className="block text-xl font-bold text-gray-900 dark:text-white">
                  {e.elevatorCode}
                </span>
                <span className="mt-0.5 block text-sm text-gray-600 dark:text-gray-400">
                  {e.buildingName}
                </span>
              </button>
            ))
          )}
        </div>
      )}

      {/* ── Step 2: which code ───────────────────────────── */}
      {step === "code" && (
        <div className="mt-4">
          <label htmlFor="code-search" className="sr-only">
            Rechercher un code
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400"
              aria-hidden="true"
            />
            <input
              id="code-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Exemple : E-101"
              autoComplete="off"
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 py-3 pl-10 pr-3 text-base text-gray-900 dark:text-white placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:focus:ring-blue-900"
            />
          </div>

          {loadingCodes && (
            <p className="mt-3 flex items-center gap-2 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Chargement…
            </p>
          )}

          <ul className="mt-4 space-y-2">
            {filtered.map((code) => (
              <li key={code.id}>
                <button
                  type="button"
                  onClick={() => chooseCode(code)}
                  className="w-full rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 text-left transition-colors hover:border-blue-400 hover:bg-blue-50 dark:hover:border-blue-700 dark:hover:bg-blue-950/30"
                >
                  <span className="font-mono text-sm font-bold text-blue-700 dark:text-blue-400">
                    {code.code}
                  </span>
                  <span className="mt-0.5 block font-medium text-gray-900 dark:text-white">
                    {code.title}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {!loadingCodes && filtered.length === 0 && (
            <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
              Aucun code ne correspond. Vous pouvez tout de même signaler le
              problème avec le bouton rouge ci-dessus.
            </p>
          )}

          <button
            type="button"
            onClick={() => {
              setSelected(null);
              setStep("solution");
            }}
            className="mt-4 text-sm font-medium text-blue-700 hover:underline dark:text-blue-400"
          >
            Je ne connais pas le code
          </button>
        </div>
      )}

      {/* ── Step 3: the instructions ─────────────────────── */}
      {step === "solution" && (
        <div className="mt-4">
          {selected ? (
            <>
              <div className="rounded-xl bg-gray-50 dark:bg-gray-950 p-4">
                <p className="font-mono text-sm font-bold text-blue-700 dark:text-blue-400">
                  {selected.code}
                </p>
                <h3 className="mt-1 text-base font-bold text-gray-900 dark:text-white">
                  {selected.title}
                </h3>
                <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                  {selected.description}
                </p>
              </div>

              <ol className="mt-4 space-y-3">
                {selected.steps.map((instruction, index) => (
                  <li key={index} className="flex gap-3">
                    <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-sm font-bold text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">
                      {index + 1}
                    </span>
                    <span className="pt-0.5 text-base leading-relaxed text-gray-800 dark:text-gray-200">
                      {instruction}
                    </span>
                  </li>
                ))}
              </ol>

              {supported && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      speak(`${selected.title}. ${selected.steps.join(". ")}`)
                    }
                    className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    <Volume2 className="h-4 w-4" aria-hidden="true" />
                    Écouter les instructions
                  </button>
                  {speaking && (
                    <button
                      type="button"
                      onClick={stop}
                      className="inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                    >
                      Arrêter la lecture
                    </button>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="rounded-xl bg-gray-50 dark:bg-gray-950 p-4 text-sm text-gray-700 dark:text-gray-300">
              Décrivez le problème ci-dessous, puis choisissez si vous avez
              réussi à le résoudre.
            </p>
          )}

          <label
            htmlFor="incident-notes"
            className="mt-5 block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Décrivez le problème (facultatif)
          </label>
          <textarea
            id="incident-notes"
            rows={3}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Exemple : les portes restent ouvertes au rez-de-chaussée."
            className="mt-1.5 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-2.5 text-base text-gray-900 dark:text-white placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:focus:ring-blue-900"
          />

          <p className="mt-5 text-base font-semibold text-gray-900 dark:text-white">
            Le problème est-il résolu ?
          </p>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => void submit("resolved")}
              disabled={submitting !== null}
              className="flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-4 text-base font-bold text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
            >
              {submitting === "resolved" ? (
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
              )}
              Problème Résolu
            </button>

            <button
              type="button"
              onClick={() => void submit("escalated")}
              disabled={submitting !== null}
              className="flex items-center justify-center gap-2 rounded-xl bg-red-600 px-5 py-4 text-base font-bold text-white transition-colors hover:bg-red-700 disabled:opacity-60"
            >
              {submitting === "escalated" ? (
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
              ) : (
                <XCircle className="h-5 w-5" aria-hidden="true" />
              )}
              Non Résolu
            </button>
          </div>

          {elevator && (
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              Ascenseur concerné : {elevator.elevatorCode} —{" "}
              {elevator.buildingName}
            </p>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
