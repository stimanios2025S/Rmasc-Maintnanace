"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, Plus, Trash2, X } from "lucide-react";
import { enumLabel } from "@/lib/ui/enum-labels";

/**
 * The report a technician files to finish a job.
 *
 * WHY A SECOND STEP
 * The checklist says what was inspected; it says nothing about what was done,
 * what was fitted, or what it cost. Those three answers are what the office
 * needs to close the order and invoice it, and they are only knowable standing
 * in the plant room. Asking for them here — at the one moment the technician is
 * on site with the parts in hand — is the difference between a report and a
 * reconstruction.
 *
 * WHY IT DOES NOT CLOSE THE JOB
 * Submitting this does not complete the work order; it moves it to
 * PENDING_APPROVAL and hands it to the office. An amount a technician typed on
 * a phone, read by nobody, is a number that reaches a client unchallenged.
 */

/** A part as the form holds it: every field is a string while it is being typed. */
interface PartLine {
  name: string;
  partNumber: string;
  qty: string;
}

export interface CompletionReport {
  description: string;
  parts: Array<{ name: string; partNumber?: string; qty: number }>;
  isBillable: boolean;
  /** Null when the job is not billable — the flag and the amount travel together. */
  invoiceAmount: number | null;
}

export interface CompletionReportJob {
  orderNumber: string;
  type: string;
  elevator: string;
  building: string;
}

/**
 * The heading, and therefore the button, the technician actually reads.
 *
 * A planned service and a breakdown are different jobs to the person doing
 * them: one is « Entretien », the other is « Maintenance ». The schema types
 * are not those words, so the translation lives here rather than in the
 * schema — renaming a stored enum value to match a button would break every
 * row already written under the old name.
 */
export function completionActionLabel(type: string): string {
  return type === "PREVENTIVE" ? "Fin d'Entretien" : "Fin de Maintenance";
}

const DESCRIPTION_MAX = 5000;

export function CompletionReportForm({
  job,
  initialDescription,
  initialParts,
  initialIsBillable,
  initialAmount,
  busy,
  serverError,
  onCancel,
  onSubmit,
}: {
  job: CompletionReportJob;
  initialDescription: string;
  initialParts: Array<{ name: string; partNumber?: string; qty: number }> | null;
  initialIsBillable: boolean;
  initialAmount: number | null;
  busy: boolean;
  serverError: string;
  onCancel: () => void;
  onSubmit: (report: CompletionReport) => void;
}) {
  const [description, setDescription] = useState(initialDescription);
  const [parts, setParts] = useState<PartLine[]>(() =>
    (initialParts ?? []).map((p) => ({
      name: p.name,
      partNumber: p.partNumber ?? "",
      qty: String(p.qty),
    }))
  );
  const [isBillable, setIsBillable] = useState(initialIsBillable);
  const [amount, setAmount] = useState(
    initialAmount === null ? "" : String(initialAmount)
  );
  const [error, setError] = useState("");

  const heading = completionActionLabel(job.type);

  const patchPart = (index: number, patch: Partial<PartLine>) => {
    setParts((prev) =>
      prev.map((line, i) => (i === index ? { ...line, ...patch } : line))
    );
  };

  /**
   * Reads the amount the way a person types one.
   *
   * A phone keyboard set to `decimal` produces a comma on a French handset, and
   * "18500,50" is not a number `Number()` will accept. Spaces are stripped too:
   * "18 500" is how the same amount is written on an invoice, and refusing it
   * would be the form being pedantic about the thing it exists to collect.
   */
  const parseAmount = (raw: string): number | null => {
    const cleaned = raw.replace(/\s/g, "").replace(",", ".");
    if (cleaned === "") return null;
    const value = Number(cleaned);
    if (!Number.isFinite(value) || value < 0) return null;
    return value;
  };

  const submit = () => {
    const trimmed = description.trim();
    if (trimmed === "") {
      setError("Décrivez les travaux effectués avant de valider le rapport.");
      return;
    }
    if (trimmed.length > DESCRIPTION_MAX) {
      setError("La description est trop longue.");
      return;
    }

    // A line with no name is an empty row somebody opened and did not need.
    // Dropping it silently is the right call; refusing the report over it would
    // punish a technician for a stray tap.
    const lines = parts.filter((p) => p.name.trim() !== "");
    const cleanedParts: CompletionReport["parts"] = [];
    for (const line of lines) {
      const qty = Number(line.qty.replace(",", "."));
      if (!Number.isFinite(qty) || qty <= 0) {
        setError(
          `Indiquez une quantité valide pour « ${line.name.trim()} ».`
        );
        return;
      }
      const partNumber = line.partNumber.trim();
      cleanedParts.push({
        name: line.name.trim(),
        // Omitted rather than sent as "": the column holds
        // `{name, partNumber, qty}` and a reference nobody knows is absent,
        // not empty.
        ...(partNumber ? { partNumber } : {}),
        qty,
      });
    }

    let invoiceAmount: number | null = null;
    if (isBillable) {
      const parsedAmount = parseAmount(amount);
      if (parsedAmount === null) {
        setError(
          "Indiquez le montant total à facturer, ou décochez « intervention payante »."
        );
        return;
      }
      invoiceAmount = Math.round(parsedAmount * 100) / 100;
    }

    setError("");
    onSubmit({
      description: trimmed,
      parts: cleanedParts,
      isBillable,
      invoiceAmount,
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="completion-report-heading"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
      // Click-outside closes on the backdrop only: a drag that starts on a
      // label and ends out here must not throw away a typed report.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div className="w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-white dark:bg-gray-900 shadow-xl">
        <header className="flex items-start justify-between gap-4 border-b border-gray-200 dark:border-gray-800 p-5">
          <div>
            <h2
              id="completion-report-heading"
              className="text-lg font-bold text-gray-900 dark:text-white"
            >
              {heading}
            </h2>
            <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
              <span className="font-mono">{job.orderNumber}</span> ·{" "}
              {enumLabel(job.type)}
            </p>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              <span className="font-mono">{job.elevator}</span> — {job.building}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Fermer"
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="space-y-6 p-5">
            {/* ── Rapport d'intervention ───────────────────────── */}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                Rapport d&apos;intervention
              </h3>
              <label
                htmlFor="completion-description"
                className="block text-xs font-medium text-gray-600 dark:text-gray-300"
              >
                Travaux effectués
              </label>
              <textarea
                id="completion-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
                maxLength={DESCRIPTION_MAX}
                placeholder="Ce qui a été fait, ce qui a été trouvé, ce qui reste à surveiller."
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <p className="text-[11px] text-gray-400">
                Ce texte est joint au rapport d&apos;inspection et lu par le
                bureau avant validation.
              </p>
            </section>

            {/* ── Pièces ───────────────────────────────────────── */}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                Pièces remplacées
              </h3>
              {parts.length === 0 ? (
                <p className="text-xs text-gray-500">
                  Aucune pièce. À remplir seulement si quelque chose a été
                  remplacé.
                </p>
              ) : (
                <ul className="space-y-2">
                  {parts.map((line, index) => (
                    <li
                      key={index}
                      className="grid grid-cols-[1fr_4.5rem_auto] gap-2 items-start"
                    >
                      <div className="space-y-1.5">
                        <label className="sr-only" htmlFor={`part-name-${index}`}>
                          Nom de la pièce {index + 1}
                        </label>
                        <input
                          id={`part-name-${index}`}
                          value={line.name}
                          onChange={(e) =>
                            patchPart(index, { name: e.target.value })
                          }
                          placeholder="Nom de la pièce"
                          className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2.5 py-2 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                        <label className="sr-only" htmlFor={`part-ref-${index}`}>
                          Référence de la pièce {index + 1}
                        </label>
                        <input
                          id={`part-ref-${index}`}
                          value={line.partNumber}
                          onChange={(e) =>
                            patchPart(index, { partNumber: e.target.value })
                          }
                          placeholder="Référence (facultatif)"
                          className="w-full rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-2.5 py-1.5 text-xs text-gray-700 dark:text-gray-200 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      </div>
                      <div>
                        <label className="sr-only" htmlFor={`part-qty-${index}`}>
                          Quantité {index + 1}
                        </label>
                        <input
                          id={`part-qty-${index}`}
                          value={line.qty}
                          onChange={(e) =>
                            patchPart(index, { qty: e.target.value })
                          }
                          inputMode="numeric"
                          placeholder="Qté"
                          className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-2 text-sm tabular-nums text-gray-900 dark:text-white focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setParts((prev) => prev.filter((_, i) => i !== index))
                        }
                        aria-label={`Retirer la pièce ${index + 1}`}
                        className="mt-1 rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                onClick={() =>
                  setParts((prev) => [
                    ...prev,
                    { name: "", partNumber: "", qty: "1" },
                  ])
                }
                className="flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 dark:border-gray-700 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:border-blue-400 hover:text-blue-600"
              >
                <Plus className="h-3.5 w-3.5" />
                Ajouter une pièce
              </button>
            </section>

            {/* ── Facturation ──────────────────────────────────── */}
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                Facturation
              </h3>
              <label
                htmlFor="completion-billable"
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 dark:border-gray-800 p-3"
              >
                <input
                  id="completion-billable"
                  type="checkbox"
                  checked={isBillable}
                  onChange={(e) => setIsBillable(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span>
                  <span className="block text-sm font-medium text-gray-900 dark:text-white">
                    Intervention payante
                  </span>
                  <span className="block text-xs text-gray-500">
                    Nécessite une facturation au client.
                  </span>
                </span>
              </label>

              {/* Rendered only when the box is ticked: an amount field sitting
                  greyed out on every job is a question the technician has to
                  answer by ignoring it. */}
              {isBillable && (
                <div className="space-y-1.5">
                  <label
                    htmlFor="completion-amount"
                    className="block text-xs font-medium text-gray-600 dark:text-gray-300"
                  >
                    Montant total à facturer (DZD)
                  </label>
                  <input
                    id="completion-amount"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder="18500"
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-2 text-sm tabular-nums text-gray-900 dark:text-white placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <p className="text-[11px] text-gray-400">
                    Main-d&apos;œuvre et pièces compris. Le bureau peut corriger
                    ce montant avant d&apos;établir la facture.
                  </p>
                </div>
              )}
            </section>

            {(error || serverError) && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-900/20 dark:text-red-300"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {error || serverError}
              </p>
            )}
          </div>

          <footer className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 border-t border-gray-200 dark:border-gray-800 p-5">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-lg bg-gray-100 px-4 py-2.5 text-sm font-medium text-gray-700 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-300"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={busy}
              className="flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              {busy ? "Enregistrement…" : "Valider le rapport et terminer"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
