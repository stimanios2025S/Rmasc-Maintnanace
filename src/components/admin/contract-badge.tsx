"use client";

import { useState } from "react";
import Link from "next/link";
import { FileSpreadsheet, Loader2 } from "lucide-react";

/**
 * Whether a reported fault comes from a contracted customer, and what the
 * technical file says about the installation.
 *
 * DERIVED, NOT STORED
 * The value is read from `client.clientType` — a relation one join away — and
 * never copied onto the incident. An earlier draft of this feature added a
 * `contractStatus` column to `IncidentReport`, which would have been a second
 * source of truth for a fact the `User` row already owns: change a customer's
 * contract and every incident they ever filed would still claim the old
 * answer, with nothing to reconcile them against.
 *
 * NULL MEANS CONTRACTED
 * A client account created before the distinction existed has no value at all.
 * Every such account was a contracted customer, so NULL is the historical
 * behaviour rather than an unanswered question — the same reading
 * `isNonContractedClient` applies on the server.
 *
 * WHY THE FILE IS FETCHED ON DEMAND
 * A technical sheet carries around forty columns. Inlining one per incident
 * would put forty times the row count of unused fields into a board that
 * re-polls every 45 seconds, to serve a panel the dispatcher usually does not
 * open. The badge itself costs nothing; the file is one request, made when
 * somebody actually asks for it.
 *
 * TODAY EVERY INCIDENT READS "SOUS CONTRAT". That is not a bug: a
 * non-contracted client has no elevator record, and an incident cannot be
 * filed without one, so their reports never reach this board. The badge is
 * here so the board states the fact rather than leaving it to be inferred,
 * and so the non-contracted branch is already correct if that rule changes.
 */

export type ClientContractType = "CONTRACTED" | "NON_CONTRACTED" | null;

interface SheetSummary {
  id: string;
  clientName: string;
  location: string;
  weightCapacity: string;
  numberOfFloors: string;
  createdAt: string;
  elevator: { elevatorCode: string } | null;
}

export function ContractBadge({
  clientId,
  clientType,
  clientName,
}: {
  clientId: string;
  clientType: ClientContractType;
  clientName: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sheet, setSheet] = useState<SheetSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nonContracted = clientType === "NON_CONTRACTED";

  async function toggle() {
    const next = !open;
    setOpen(next);

    // Fetched once and kept. Reopening the panel should not re-query, and the
    // board's 45-second poll does not touch this state at all.
    if (!next || sheet || loading) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/technical-sheets?clientId=${encodeURIComponent(clientId)}&limit=1`
      );
      if (!res.ok) throw new Error(`L'API a répondu ${res.status}`);
      const payload = await res.json();
      const sheets: SheetSummary[] = payload?.data?.sheets ?? [];
      setSheet(sheets[0] ?? null);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Impossible de charger la fiche technique."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <span className="inline-flex items-center gap-1.5">
        <span
          title={
            nonContracted
              ? "Client sans contrat d'entretien — la fiche technique est le seul document que nous détenons sur l'installation."
              : "Client suivi sous contrat d'entretien."
          }
          className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${
            nonContracted
              ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
              : "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300"
          }`}
        >
          {nonContracted ? "SANS CONTRAT" : "SOUS CONTRAT"}
        </span>

        <button
          type="button"
          onClick={() => void toggle()}
          aria-expanded={open}
          className="inline-flex items-center gap-1 rounded-full border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          <FileSpreadsheet className="h-3 w-3" aria-hidden="true" />
          Fiche technique
        </button>
      </span>

      {/*
        A sibling of the badge rather than a child of it, and `w-full`. The
        board's header is a wrapping flex container, so this puts the panel on
        a line of its own; nested inside the badge it would have been squeezed
        into whatever width the badge happened to take.
      */}
      {open && (
        <div className="mt-2 w-full rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs dark:border-gray-800 dark:bg-gray-800/40">
          {loading && (
            <p className="flex items-center gap-2 text-gray-500">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              Chargement de la fiche…
            </p>
          )}

          {!loading && error && (
            <p className="font-medium text-red-700 dark:text-red-400">
              {error}
            </p>
          )}

          {!loading && !error && !sheet && (
            <p className="text-gray-500 dark:text-gray-400">
              Aucune fiche technique transmise par {clientName}.{" "}
              {nonContracted
                ? "Ce client peut en remplir une depuis son espace."
                : "Les installations sous contrat sont documentées dans le dossier d'équipement."}
            </p>
          )}

          {!loading && !error && sheet && (
            <div className="space-y-1">
              <p className="font-semibold text-gray-900 dark:text-white">
                {sheet.clientName}
                {sheet.elevator ? ` · ${sheet.elevator.elevatorCode}` : ""}
              </p>
              <p className="text-gray-600 dark:text-gray-400">
                {sheet.location}
              </p>
              <p className="text-gray-600 dark:text-gray-400">
                Charge {sheet.weightCapacity} · {sheet.numberOfFloors} niveaux
              </p>
              <Link
                href="/fiches-techniques"
                className="mt-1 inline-block font-medium text-blue-600 underline decoration-dotted underline-offset-2 hover:text-blue-700 dark:text-blue-400"
              >
                Ouvrir dans le tableau des fiches
              </Link>
            </div>
          )}
        </div>
      )}
    </>
  );
}
