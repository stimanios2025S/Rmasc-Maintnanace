"use client";

import { useEffect, useState } from "react";
import { Loader2, UserCheck, X } from "lucide-react";
import type { TechnicianStatus } from "@/types";

/**
 * Pick the engineer who attends an escalated incident.
 *
 * A deliberate dialog rather than a one-click "auto-dispatch": the incidents
 * this opens on are the ones a client could not clear themselves, and an
 * emergency sent from the red button arrives with no fault description at all.
 * Someone has to decide who goes, and that decision is worth a second of
 * attention. The list is ordered by current workload so the reasonable choice
 * is also the first one.
 *
 * The roster is already filtered to dispatchable technicians by the API — an
 * OFF_DUTY or ON_LEAVE engineer never reaches this list. `status` is carried
 * anyway so the dialog can show it, because "Free" and "available" are not the
 * same claim: a technician marked ON_JOB whose counted queue happens to be
 * empty would otherwise be offered as idle when they are standing in a machine
 * room.
 */

export interface RosterTechnician {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: TechnicianStatus;
  openWorkOrders: number;
  openIncidents: number;
}

export function DispatchModal({
  incident,
  onClose,
  onDispatched,
}: {
  /** The incident being dispatched, or null when the dialog is closed. */
  incident: { id: string; incidentNumber: string; elevatorCode: string } | null;
  onClose: () => void;
  onDispatched: () => void;
}) {
  const [roster, setRoster] = useState<RosterTechnician[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = incident !== null;

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelected(null);

    fetch("/api/technicians")
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((payload) => {
        if (cancelled) return;
        const rows: RosterTechnician[] = payload?.data ?? [];
        setRoster(rows);
        // Pre-select the least-loaded engineer. It is the recommendation, not
        // the decision — the dispatcher still has to press the button.
        if (rows.length > 0) setSelected(rows[0].id);
      })
      .catch(() => {
        if (!cancelled)
          setError("Impossible de charger la liste des techniciens.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  // Escape closes. A modal a keyboard user cannot dismiss is a trap.
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!incident) return null;

  async function confirm() {
    if (!selected || !incident) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/incidents/${incident.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dispatch", technicianId: selected }),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(
          payload?.error ?? payload?.message ?? "L'affectation a échoué."
        );
      }

      onDispatched();
    } catch (e) {
      setError(e instanceof Error ? e.message : "L'affectation a échoué.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="dispatch-heading"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      // Click-outside closes, but only on the backdrop itself — a click that
      // started inside the panel and ended on the backdrop (a drag across a
      // text selection) must not discard the dialog.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-gray-900 shadow-xl">
        <header className="flex items-start justify-between gap-4 border-b border-gray-200 dark:border-gray-800 p-5">
          <div>
            <h2
              id="dispatch-heading"
              className="text-lg font-bold text-gray-900 dark:text-white"
            >
              Affecter un technicien
            </h2>
            <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
              <span className="font-mono">{incident.incidentNumber}</span> ·{" "}
              {incident.elevatorCode}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="max-h-[60vh] overflow-y-auto p-5">
          {loading && (
            <p className="flex items-center gap-2 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Chargement de la liste…
            </p>
          )}

          {!loading && roster.length === 0 && !error && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Aucun technicien de terrain actif n&apos;est enregistré. Ajoutez-en un
              avant de procéder à une affectation.
            </p>
          )}

          {!loading && roster.length > 0 && (
            <ul className="space-y-2">
              {roster.map((technician) => {
                const load = technician.openWorkOrders + technician.openIncidents;
                const isSelected = selected === technician.id;

                return (
                  <li key={technician.id}>
                    <label
                      className={`flex cursor-pointer items-center gap-3 rounded-xl border-2 p-3 transition-colors ${
                        isSelected
                          ? "border-blue-500 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/30"
                          : "border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600"
                      }`}
                    >
                      <input
                        type="radio"
                        name="technician"
                        value={technician.id}
                        checked={isSelected}
                        onChange={() => setSelected(technician.id)}
                        className="h-4 w-4 accent-blue-600"
                      />
                      <span className="flex-1 min-w-0">
                        <span className="block font-medium text-gray-900 dark:text-white">
                          {technician.name}
                        </span>
                        <span className="block text-xs text-gray-500 dark:text-gray-400">
                          {technician.email}
                          {technician.phone ? ` · ${technician.phone}` : ""}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        {technician.status === "ON_JOB" && (
                          <span className="whitespace-nowrap rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                            En intervention
                          </span>
                        )}
                        <span
                          className={`whitespace-nowrap rounded-full px-2 py-1 text-xs font-semibold ${
                            load === 0
                              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                              : load <= 2
                                ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                                : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
                          }`}
                        >
                          {load === 0
                            ? technician.status === "ON_JOB"
                              ? "Aucune file"
                              : "Disponible"
                            : `${load} en cours`}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {error && (
            <p
              role="alert"
              className="mt-3 text-sm font-medium text-red-700 dark:text-red-400"
            >
              {error}
            </p>
          )}

          <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
            L&apos;affectation fait aussi passer le bon de travail lié au statut
            « Assigné » et notifie le technicien.
          </p>
        </div>

        <footer className="flex justify-end gap-2 border-t border-gray-200 dark:border-gray-800 p-5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={!selected || submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <UserCheck className="h-4 w-4" aria-hidden="true" />
            )}
            Affecter
          </button>
        </footer>
      </div>
    </div>
  );
}
