"use client";

import { useState } from "react";
import { AlertOctagon, Loader2, PhoneCall, Volume2 } from "lucide-react";
import { useSpeech } from "./use-speech";

/**
 * The accessibility path: one press, no reading, a technician is dispatched.
 *
 * WHY THERE IS A CHOOSER AT ALL
 * The specification is "press the red button and an incident is created". That
 * works when the caller has one elevator — and this component fires
 * immediately in that case. It cannot work verbatim for a building with
 * three: an incident must name a unit, and guessing wrong sends a technician
 * to the wrong machine. The compromise is that the second step is a row of
 * *large buttons carrying only the elevator code*, which is a plate number,
 * not prose — the same thing the occupant would read off the controller. No
 * sentence has to be read to complete the report.
 *
 * WHAT IT DELIBERATELY OMITS
 * No fault description, no error code, no confirmation dialog. The whole point
 * is that someone in distress is not asked to type. The dispatcher gets the
 * elevator and the reporter's name; everything else is established by the
 * technician on site.
 */

export interface EmergencyElevator {
  id: string;
  elevatorCode: string;
  buildingName: string;
}

export function EmergencyButton({
  elevators,
  onEscalated,
}: {
  elevators: EmergencyElevator[];
  onEscalated: () => void;
}) {
  const { speak, supported } = useSpeech();
  const [choosing, setChoosing] = useState(false);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function escalate(elevatorId: string) {
    setSubmitting(elevatorId);
    setError(null);

    try {
      const res = await fetch("/api/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elevatorId,
          status: "ESCALATED",
          isDirectTransfer: true,
          notes: "Demande d'assistance immédiate — envoi direct, sans description.",
        }),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(
          payload?.error ?? "L'envoi a échoué. Veuillez réessayer."
        );
      }

      speak(
        "Votre demande d'assistance est enregistrée. Un technicien va être envoyé."
      );
      setChoosing(false);
      onEscalated();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "L'envoi a échoué.";
      setError(message);
      speak("L'envoi a échoué. Veuillez réessayer.");
    } finally {
      setSubmitting(null);
    }
  }

  function handlePress() {
    // One elevator: no question to ask, so don't ask one.
    if (elevators.length === 1) {
      void escalate(elevators[0].id);
      return;
    }
    setChoosing(true);
    speak("Quel ascenseur ? Touchez son numéro.");
  }

  return (
    <section
      aria-labelledby="urgence-heading"
      className="rounded-2xl border-2 border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-5"
    >
      <div className="flex items-start gap-3">
        <AlertOctagon
          className="h-6 w-6 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5"
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">
          <h2
            id="urgence-heading"
            className="text-lg font-bold text-red-900 dark:text-red-200"
          >
            Besoin d&apos;aide immédiate ?
          </h2>
          <p className="mt-1 text-sm text-red-800 dark:text-red-300">
            Appuyez sur le bouton rouge. Aucune explication n&apos;est
            nécessaire.
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={handlePress}
        disabled={submitting !== null || elevators.length === 0}
        className="mt-4 flex w-full items-center justify-center gap-3 rounded-xl bg-red-600 px-6 py-6 text-xl font-bold text-white shadow-sm transition-colors hover:bg-red-700 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:cursor-not-allowed disabled:bg-red-300 dark:disabled:bg-red-900"
      >
        {submitting ? (
          <Loader2 className="h-7 w-7 animate-spin" aria-hidden="true" />
        ) : (
          <PhoneCall className="h-7 w-7" aria-hidden="true" />
        )}
        Aide immédiate / Urgence
      </button>

      {supported && (
        <button
          type="button"
          onClick={() =>
            speak(
              "Besoin d'aide immédiate ? Appuyez sur le bouton rouge. Aucune explication n'est nécessaire."
            )
          }
          className="mt-3 inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-red-800 hover:bg-red-100 dark:text-red-300 dark:hover:bg-red-900/40"
        >
          <Volume2 className="h-4 w-4" aria-hidden="true" />
          Écouter
        </button>
      )}

      {choosing && (
        <div className="mt-4 rounded-xl border border-red-300 dark:border-red-900 bg-white dark:bg-gray-900 p-4">
          <p className="text-base font-semibold text-gray-900 dark:text-white">
            Quel ascenseur ?
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {elevators.map((elevator) => (
              <button
                key={elevator.id}
                type="button"
                onClick={() => void escalate(elevator.id)}
                disabled={submitting !== null}
                className="rounded-xl border-2 border-red-300 dark:border-red-900 px-4 py-5 text-center transition-colors hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
              >
                <span className="block text-2xl font-bold tracking-wide text-red-800 dark:text-red-300">
                  {elevator.elevatorCode}
                </span>
                <span className="mt-1 block text-sm text-gray-600 dark:text-gray-400">
                  {elevator.buildingName}
                </span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setChoosing(false)}
            className="mt-3 text-sm font-medium text-gray-600 hover:underline dark:text-gray-400"
          >
            Annuler
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-red-800 dark:text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}
