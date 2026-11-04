"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * « Déclarer un incident », depuis le terrain.
 *
 * POURQUOI UNE BOÎTE DE DIALOGUE ET PAS UN ÉCRAN
 * Un technicien déclare une panne debout, dans une gaine ou devant une cabine
 * bloquée, souvent d'une seule main. L'écran d'administration des incidents est
 * un poste de bureau. Cette boîte ne demande que trois choses — quel appareil,
 * ce qui se passe, est-ce urgent — et poste sur la même route que le portail
 * client, avec le même cloisonnement par rôle.
 *
 * ELLE N'INVENTE RIEN
 * `status: "ESCALATED"` est le seul état qu'un signalement de terrain produise :
 * une panne déclarée n'est pas une panne résolue. C'est le bureau qui décide de
 * l'affectation, et l'API le fait déjà.
 */

interface ElevatorOption {
  id: string;
  elevatorCode: string;
  building: { name: string };
}

export function IncidentDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Appelé après un enregistrement réussi, pour rafraîchir la file. */
  onCreated?: () => void;
}) {
  const [elevators, setElevators] = useState<ElevatorOption[]>([]);
  const [loadingElevators, setLoadingElevators] = useState(false);
  const [elevatorId, setElevatorId] = useState("");
  const [notes, setNotes] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [createdNumber, setCreatedNumber] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);

  // Ouverture : on repart d'un formulaire vide et on relit le parc.
  useEffect(() => {
    if (!open) return;

    setElevatorId("");
    setNotes("");
    setUrgent(false);
    setError("");
    setCreatedNumber("");
    setLoadingElevators(true);

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/elevators");
        if (!res.ok) throw new Error(`Parc indisponible (${res.status})`);
        const json = await res.json();
        if (cancelled) return;
        setElevators(Array.isArray(json.data) ? json.data : []);
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error
              ? e.message
              : "Impossible de charger la liste des appareils."
          );
        }
      } finally {
        if (!cancelled) setLoadingElevators(false);
      }
    })();

    const focusTimer = window.setTimeout(() => {
      dialogRef.current?.querySelector<HTMLElement>("select")?.focus();
    }, 30);

    return () => {
      cancelled = true;
      window.clearTimeout(focusTimer);
    };
  }, [open]);

  // Échap ferme, comme partout.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const submit = useCallback(async () => {
    setError("");

    if (!elevatorId) {
      setError("Choisissez l'appareil concerné.");
      return;
    }
    if (notes.trim().length < 5) {
      setError("Décrivez le problème en quelques mots (5 caractères minimum).");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elevatorId,
          notes: notes.trim(),
          status: "ESCALATED",
          isDirectTransfer: urgent,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          json?.error ?? `L'API a refusé le signalement (${res.status})`
        );
      }

      setCreatedNumber(json?.data?.incidentNumber ?? "");
      onCreated?.();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Le signalement n'a pas pu être enregistré."
      );
    } finally {
      setBusy(false);
    }
  }, [elevatorId, notes, urgent, onCreated]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-end justify-center bg-gray-900/50 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="incident-dialog-title"
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white shadow-2xl dark:bg-gray-900 sm:max-w-lg sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4 dark:border-gray-800">
          <div>
            <h2
              id="incident-dialog-title"
              className="flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-white"
            >
              <AlertTriangle
                className="h-5 w-5 text-red-500"
                aria-hidden="true"
              />
              Déclarer un incident
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Le bureau reçoit le signalement immédiatement.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {createdNumber ? (
          <div className="px-5 py-8 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-green-500" />
            <p className="mt-3 text-base font-semibold text-gray-900 dark:text-white">
              Signalement enregistré
            </p>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Référence{" "}
              <span className="font-mono font-semibold text-gray-900 dark:text-white">
                {createdNumber}
              </span>
              . Le bureau est prévenu.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
            >
              Fermer
            </button>
          </div>
        ) : (
          <div className="space-y-4 px-5 py-5">
            <div>
              <label
                htmlFor="incident-elevator"
                className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Appareil concerné
              </label>
              <select
                id="incident-elevator"
                value={elevatorId}
                onChange={(event) => setElevatorId(event.target.value)}
                disabled={loadingElevators}
                className="w-full rounded-xl border border-gray-300 bg-white px-3 py-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
              >
                <option value="">
                  {loadingElevators
                    ? "Chargement du parc…"
                    : "Choisir un appareil"}
                </option>
                {elevators.map((elevator) => (
                  <option key={elevator.id} value={elevator.id}>
                    {elevator.elevatorCode} — {elevator.building.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="incident-notes"
                className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Que se passe-t-il ?
              </label>
              <textarea
                id="incident-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={4}
                placeholder="Ex. : la cabine s'arrête entre deux étages, bruit anormal au démarrage…"
                className="w-full rounded-xl border border-gray-300 bg-white px-3 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
              />
            </div>

            <label className="flex items-start gap-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
              <input
                type="checkbox"
                checked={urgent}
                onChange={(event) => setUrgent(event.target.checked)}
                className="mt-0.5 h-5 w-5 flex-none rounded border-gray-300 text-red-600 focus:ring-red-500"
              />
              <span className="text-sm">
                <span className="block font-medium text-gray-900 dark:text-white">
                  Traiter en urgence
                </span>
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  Une intervention d&apos;urgence est ouverte et priorisée.
                </span>
              </span>
            </label>

            {error && (
              <p
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
              >
                {error}
              </p>
            )}
          </div>
        )}

        {!createdNumber && (
          <div className="sticky bottom-0 flex gap-3 border-t border-gray-200 bg-white px-5 py-4 dark:border-gray-800 dark:bg-gray-900">
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 flex-1 rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Annuler
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || loadingElevators}
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Envoyer
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
