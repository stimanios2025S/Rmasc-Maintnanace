"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CalendarCheck,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Wrench,
} from "lucide-react";
import { Card } from "@/components/ui/card";

/**
 * The two ways a client can ask us to attend, side by side.
 *
 * WHY THIS EXISTS
 * The portal previously offered one implicit path — the fault wizard — which
 * answers "my lift has stopped" and nothing else. A customer holding a
 * maintenance contract is also entitled to a *periodic review*, and there was
 * nowhere to ask for one: the only route to it was to telephone the office.
 * That is the gap this closes.
 *
 * The two actions are named after what the customer is entitled to, not after
 * what the system stores. « Maintenance » is corrective work (the existing
 * wizard and the red button, which are unchanged and stay where they were);
 * « Entretien » is the scheduled review. The second is offered only to a
 * contracted account, because that is what the contract buys.
 *
 * WHY THE MAINTENANCE TILE IS A LINK AND NOT A FORM
 * The wizard it opens is a few hundred pixels below, already rendered. A tile
 * that duplicated it would put two copies of the same three-step form on one
 * page and leave the reader to work out which is authoritative. So this tile
 * points at the real thing — and for a client with no contract there is no
 * wizard to point at, so it points at the technical sheet instead, which is
 * the only fault-adjacent action that account can actually complete.
 */

export interface ActionElevator {
  id: string;
  elevatorCode: string;
  buildingName: string;
}

export function InterventionActions({
  contracted,
  elevators,
  onRequested,
}: {
  contracted: boolean;
  elevators: ActionElevator[];
  onRequested: () => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<{
    orderNumber: string;
    elevatorCode: string;
  } | null>(null);

  async function requestVisit(elevatorId: string) {
    setSubmitting(elevatorId);
    setError(null);

    try {
      const res = await fetch("/api/preventive-visits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ elevatorId }),
      });

      const payload = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(
          payload?.error ?? "La demande n'a pas pu être enregistrée."
        );
      }

      setBooked({
        orderNumber: payload?.data?.orderNumber ?? "—",
        elevatorCode: payload?.data?.elevatorCode ?? "",
      });
      setChoosing(false);
      onRequested();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "La demande n'a pas pu être enregistrée."
      );
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <Card className="p-5">
      {/* With a contract this card is a choice, and says so. Without one there
          is a single action, and asking "what would you like to do?" over one
          button reads as a form that failed to load. */}
      <h2 className="text-lg font-bold text-gray-900 dark:text-white">
        {contracted
          ? "Que souhaitez-vous faire ?"
          : "Une intervention à demander ?"}
      </h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        {contracted
          ? "Votre contrat couvre la réparation des pannes et les visites de révision périodiques."
          : "La réparation des pannes est ouverte à tous. La visite de révision périodique est réservée aux clients sous contrat."}
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {/* ── Maintenance — corrective, open to everyone ─────────────── */}
        {contracted ? (
          <a
            href="#signaler"
            className="group flex flex-col gap-2 rounded-xl border border-gray-200 p-4 transition-colors hover:border-blue-400 hover:bg-blue-50/50 dark:border-gray-800 dark:hover:border-blue-800 dark:hover:bg-blue-950/20"
          >
            <div className="flex items-center gap-2">
              <Wrench
                className="h-5 w-5 text-blue-600 dark:text-blue-400"
                aria-hidden="true"
              />
              <span className="font-bold text-gray-900 dark:text-white">
                Démarrage Maintenance
              </span>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Réparation suite à une panne ou un problème signalé. Réponse
              immédiate, technicien envoyé sur place.
            </p>
            <span className="mt-auto inline-flex items-center gap-1.5 pt-2 text-sm font-semibold text-blue-700 dark:text-blue-400">
              Signaler une panne
              <ChevronDown
                className="h-4 w-4 transition-transform group-hover:translate-y-0.5"
                aria-hidden="true"
              />
            </span>
          </a>
        ) : (
          <Link
            href="/client/fiche-technique"
            className="group flex flex-col gap-2 rounded-xl border border-gray-200 p-4 transition-colors hover:border-blue-400 hover:bg-blue-50/50 dark:border-gray-800 dark:hover:border-blue-800 dark:hover:bg-blue-950/20"
          >
            <div className="flex items-center gap-2">
              <Wrench
                className="h-5 w-5 text-blue-600 dark:text-blue-400"
                aria-hidden="true"
              />
              <span className="font-bold text-gray-900 dark:text-white">
                Démarrage Maintenance
              </span>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Une panne à réparer. Nous n&apos;avons pas encore votre
              installation au dossier : la fiche technique est le point de
              départ, et notre équipe intervient de la même façon.
            </p>
            <span className="mt-auto inline-flex items-center gap-1.5 pt-2 text-sm font-semibold text-blue-700 dark:text-blue-400">
              Remplir la fiche technique
              <ArrowRight
                className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </span>
          </Link>
        )}

        {/* ── Entretien — preventive, contract only ──────────────────── */}
        {contracted && (
          <div className="flex flex-col gap-2 rounded-xl border border-gray-200 p-4 dark:border-gray-800">
            <div className="flex items-center gap-2">
              <CalendarCheck
                className="h-5 w-5 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
              <span className="font-bold text-gray-900 dark:text-white">
                Démarrage Entretien
              </span>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Visite de révision périodique et contrôle complet de
              l&apos;installation, sans panne déclarée.
            </p>

            {!booked && !choosing && (
              <button
                type="button"
                onClick={() => {
                  setChoosing(true);
                  setError(null);
                }}
                disabled={elevators.length === 0}
                className="mt-auto inline-flex items-center gap-1.5 self-start rounded-lg bg-emerald-600 px-3.5 py-2 pt-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Demander la visite
              </button>
            )}

            {choosing && (
              <div className="mt-auto">
                <p className="text-sm font-semibold text-gray-900 dark:text-white">
                  Quel ascenseur ?
                </p>
                <div className="mt-2 grid gap-2">
                  {elevators.map((elevator) => (
                    <button
                      key={elevator.id}
                      type="button"
                      onClick={() => void requestVisit(elevator.id)}
                      disabled={submitting !== null}
                      className="flex items-center justify-between gap-2 rounded-lg border border-emerald-300 px-3 py-2 text-left transition-colors hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-900 dark:hover:bg-emerald-950/30"
                    >
                      <span className="min-w-0">
                        <span className="block font-mono text-sm font-bold text-emerald-800 dark:text-emerald-300">
                          {elevator.elevatorCode}
                        </span>
                        <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                          {elevator.buildingName}
                        </span>
                      </span>
                      {submitting === elevator.id && (
                        <Loader2
                          className="h-4 w-4 flex-none animate-spin text-emerald-600"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setChoosing(false)}
                  disabled={submitting !== null}
                  className="mt-2 text-sm font-medium text-gray-600 hover:underline disabled:opacity-50 dark:text-gray-400"
                >
                  Annuler
                </button>
              </div>
            )}

            {booked && (
              <div className="mt-auto flex items-start gap-2 rounded-lg bg-emerald-50 p-3 dark:bg-emerald-950/30">
                <CheckCircle2
                  className="mt-0.5 h-4 w-4 flex-none text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                />
                <p className="text-sm text-emerald-800 dark:text-emerald-300">
                  Demande enregistrée sous le bon{" "}
                  <span className="font-mono font-semibold">
                    {booked.orderNumber}
                  </span>
                  {booked.elevatorCode ? ` (${booked.elevatorCode})` : ""}. Nous
                  vous contactons pour fixer la date.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      )}
    </Card>
  );
}
