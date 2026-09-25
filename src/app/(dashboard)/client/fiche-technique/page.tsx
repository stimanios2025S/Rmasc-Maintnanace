"use client";

import { useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { CheckCircle2, Loader2, Send } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { OPS_ROLES, isNonContractedClient } from "@/types";
import {
  TECHNICAL_SHEET_SECTIONS,
  REQUIRED_FIELD_NAMES,
  isRequiredField,
} from "@/lib/technical-sheets/fields";

/**
 * The « Fiche Technique » form — the digitised *Conception Etude & Maintenance
 * des Ascenseurs* sheet.
 *
 * BUILT FOR THE PERSON WHO HAS NEVER SEEN THE PAPER VERSION
 * This is filled in by a non-contract client: a building manager with no file
 * with us, standing in a machine room, reading plates off a motor. They are not
 * a technician. So the four fields they certainly know — their name, the
 * address, the capacity, the number of floors — are grouped first and marked
 * required, and everything technical is plainly labelled as optional and
 * completable later by our team.
 *
 * The temptation with a form like this is to make the technical columns
 * mandatory "for completeness". That is how you never receive a sheet at all.
 * The split is enforced in one place — `REQUIRED_FIELD_NAMES` in
 * `@/lib/technical-sheets/fields` — and this component reads it rather than
 * re-deciding which fields matter.
 *
 * NOTHING IS LOST BY LEAVING A FIELD BLANK
 * The API stores a blank as NULL, so "we did not have this information" stays
 * distinguishable from "we have it and it is empty" when the maintenance team
 * opens the sheet. Leaving a field alone costs the client nothing.
 */

type FormState = Record<string, string>;

interface FieldIssue {
  path: string;
  message: string;
}

export default function TechnicalSheetFormPage() {
  const { data: session, status } = useSession();
  const [form, setForm] = useState<FormState>({});
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(name: string, value: string) {
    setForm((current) => ({ ...current, [name]: value }));
    // Clear the error as soon as the field is touched — leaving a red message
    // under a field the user has since filled in reads as a refusal.
    setIssues((current) => {
      if (!current[name]) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  }

  async function submit() {
    setError(null);

    // Checked here purely to fail fast; the API validates the same four fields
    // and is the authority. This is a convenience, not a substitute.
    const missing: Record<string, string> = {};
    for (const section of TECHNICAL_SHEET_SECTIONS) {
      for (const field of section.fields) {
        if (isRequiredField(field.name) && !(form[field.name] ?? "").trim()) {
          missing[field.name] = `${field.label} est obligatoire`;
        }
      }
    }
    if (Object.keys(missing).length > 0) {
      setIssues(missing);
      setError("Veuillez renseigner les champs obligatoires.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/technical-sheets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => null);

        // A Zod failure comes back as `details.issues` (see `handleRouteError`
        // in `src/lib/api/http.ts`). Mapping them onto the fields is what turns
        // a wall of JSON into something the client can act on.
        const fieldIssues: FieldIssue[] = payload?.details?.issues ?? [];
        if (Array.isArray(fieldIssues) && fieldIssues.length > 0) {
          const mapped: Record<string, string> = {};
          for (const issue of fieldIssues) {
            if (issue?.path) mapped[issue.path] = issue.message;
          }
          setIssues(mapped);
          setError("Certains champs doivent être corrigés.");
          return;
        }

        throw new Error(payload?.error ?? "L'envoi de la fiche a échoué.");
      }

      setSubmitted(true);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "L'envoi de la fiche a échoué."
      );
    } finally {
      setSubmitting(false);
    }
  }

  // Nothing is rendered until the session resolves, so nobody sees a flash of
  // a form their account is not entitled to.
  if (status === "loading") return null;

  // The form belongs to customers with no contract. Staff are let through
  // because the maintenance team records a sheet on a prospect's behalf after a
  // site visit — a normal way for one to arrive. A contracted client is not,
  // and is told why here rather than shown a form whose submit would be
  // refused by the API.
  const role = session?.user?.role;
  const isStaff = !!role && OPS_ROLES.includes(role);
  if (!isStaff && !isNonContractedClient(session?.user)) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="p-8 text-center">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">
            Fiche technique
          </h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            Ce formulaire est réservé aux clients sans contrat
            d&apos;entretien. Votre compte est déjà suivi sous contrat : votre
            espace client vous permet de signaler une panne et de suivre vos
            interventions.
          </p>
          <Link
            href="/client"
            className="mt-6 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
          >
            Retour à l&apos;espace client
          </Link>
        </Card>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="p-8 text-center">
          <CheckCircle2
            className="mx-auto mb-3 h-10 w-10 text-emerald-500"
            aria-hidden="true"
          />
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">
            Fiche technique enregistrée
          </h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            Merci. Votre fiche a bien été transmise à notre équipe. Elle
            complétera les informations techniques restantes lors de la visite.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/client"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
            >
              Retour à l&apos;espace client
            </Link>
            <button
              type="button"
              onClick={() => {
                setForm({});
                setIssues({});
                setSubmitted(false);
              }}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Remplir une autre fiche
            </button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          Fiche technique
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Remplissez ce que vous savez. Les quatre premiers champs sont
          obligatoires ; tout le reste peut être complété par notre équipe
          technique lors de la visite.
        </p>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="space-y-6"
        noValidate
      >
        {TECHNICAL_SHEET_SECTIONS.map((section) => (
          <Card key={section.id}>
            <div className="p-5">
              <CardHeader title={section.title} subtitle={section.hint} />

              <div className="grid gap-5 sm:grid-cols-2">
                {section.fields.map((field) => {
                  const required = isRequiredField(field.name);
                  const inputId = `champ-${field.name}`;
                  const describedBy = field.hint ? `${inputId}-aide` : undefined;
                  const message = issues[field.name];

                  return (
                    <div
                      key={field.name}
                      // A required field spans both columns: it is the part of
                      // the form the client must not skim past, and the width
                      // gives it that weight.
                      className={required ? "sm:col-span-2" : undefined}
                    >
                      <label
                        htmlFor={inputId}
                        className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                      >
                        {field.label}
                        {required && (
                          <span
                            className="ml-1 text-red-600 dark:text-red-400"
                            aria-hidden="true"
                          >
                            *
                          </span>
                        )}
                      </label>

                      <input
                        id={inputId}
                        name={field.name}
                        type="text"
                        value={form[field.name] ?? ""}
                        onChange={(event) =>
                          update(field.name, event.target.value)
                        }
                        placeholder={field.placeholder}
                        required={required}
                        aria-required={required || undefined}
                        aria-invalid={message ? true : undefined}
                        aria-describedby={describedBy}
                        className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 dark:bg-gray-900 dark:text-white ${
                          message
                            ? "border-red-400 focus:border-red-500 focus:ring-red-500"
                            : "border-gray-300 focus:border-blue-500 focus:ring-blue-500 dark:border-gray-700"
                        }`}
                      />

                      {field.hint && (
                        <p
                          id={describedBy}
                          className="mt-1 text-xs text-gray-500 dark:text-gray-400"
                        >
                          {field.hint}
                        </p>
                      )}

                      {message && (
                        <p
                          role="alert"
                          className="mt-1 text-xs font-medium text-red-600 dark:text-red-400"
                        >
                          {message}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </Card>
        ))}

        {error && (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
          >
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Les champs marqués d&apos;un astérisque (*) sont obligatoires.
            {REQUIRED_FIELD_NAMES.length} champs sur{" "}
            {TECHNICAL_SHEET_SECTIONS.reduce(
              (total, section) => total + section.fields.length,
              0
            )}{" "}
            sont demandés — le reste est facultatif.
          </p>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4" aria-hidden="true" />
            )}
            Envoyer la fiche
          </button>
        </div>
      </form>
    </div>
  );
}
