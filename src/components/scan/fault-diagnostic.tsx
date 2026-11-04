"use client";

/**
 * Le guide d'autodiagnostic du QR public, et le signalement.
 *
 * PARCOURS PUBLIC, SANS COMPTE
 * La personne qui scanne la plaque n'a pas de compte et n'en aura pas. Le
 * formulaire ne demande donc que ce qu'elle est seule à savoir : son prénom,
 * son nom, son téléphone et ce qui se passe. L'appareil et l'adresse sont déjà
 * dans l'URL du QR et dans la fiche de l'immeuble — les redemander serait faire
 * ressaisir ce que le scan vient de fournir.
 *
 * LA SÉCURITÉ AVANT LA RÉSOLUTION
 * Les codes E-201 et E-202 concernent une personne dans une cabine. Le guide
 * dit d'abord de ne pas forcer les portes et d'utiliser le bouton d'appel.
 *
 * DEUX CHEMINS, DANS CET ORDRE
 * D'abord les gestes simples — c'est ce qui règle la majorité des appels. Puis,
 * si le problème persiste, le signalement : il part directement au tableau de
 * bord du bureau et sur la carte, sans créer de compte.
 */

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Send,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";
import { ELEVATOR_ERROR_CODES } from "@/lib/incidents/error-code-catalogue";

/** Les codes les plus fréquents sur le terrain, dans l'ordre où on les lit. */
const COMMON_CODES = ["E-101", "E-102", "E-201", "E-202", "E-301", "E-302"];

interface Result {
  number: string;
  demo: boolean;
  assignedTo: string | null;
}

const INPUT =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 " +
  "placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 " +
  "focus:ring-blue-200 dark:border-gray-700 dark:bg-gray-800 dark:text-white";

export function FaultDiagnostic({
  elevatorId,
  elevatorCode,
}: {
  elevatorId: string;
  elevatorCode: string;
}) {
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  const codes = useMemo(() => {
    const known = ELEVATOR_ERROR_CODES.filter((entry) =>
      COMMON_CODES.includes(entry.code)
    );
    // Si le catalogue change, on montre au moins les six premiers plutôt que
    // rien : une liste vide ferait croire qu'il n'y a pas de guide.
    return known.length > 0 ? known : ELEVATOR_ERROR_CODES.slice(0, 6);
  }, []);

  async function submit() {
    setError("");

    if (!firstName.trim() || !lastName.trim()) {
      setError("Indiquez votre prénom et votre nom.");
      return;
    }
    if (phone.trim().length < 5) {
      setError("Indiquez un numéro de téléphone pour que le bureau vous rappelle.");
      return;
    }
    if (notes.trim().length < 10) {
      setError("Décrivez la panne en quelques mots (10 caractères minimum).");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`/api/scan/${elevatorId}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          phone: phone.trim(),
          notes: notes.trim(),
        }),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          payload?.error ?? `Le signalement a été refusé (${response.status}).`
        );
      }

      setResult({
        number: payload?.data?.incidentNumber ?? "—",
        demo: payload?.demo === true,
        assignedTo: payload?.data?.assignedTo ?? null,
      });
      setFirstName("");
      setLastName("");
      setPhone("");
      setNotes("");
      setFormOpen(false);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Le signalement n'a pas pu être envoyé."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <h2 className="flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-white">
        <Wrench className="h-5 w-5 text-blue-600" aria-hidden="true" />
        Un problème avec cet ascenseur ?
      </h2>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        Cherchez le code affiché sur l&apos;écran de la cabine, puis suivez les
        étapes. La plupart des pannes se règlent sans intervention.
      </p>

      <div className="mt-4 divide-y divide-gray-100 dark:divide-gray-800">
        {codes.map((entry) => {
          const expanded = openCode === entry.code;
          const steps = entry.solution
            .split("\n")
            .map((step) => step.trim())
            .filter(Boolean);

          return (
            <div key={entry.code} className="py-2">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpenCode(expanded ? null : entry.code)}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-800/60"
              >
                <span className="flex-none rounded-md bg-gray-100 px-2 py-1 font-mono text-xs font-bold text-gray-800 dark:bg-gray-800 dark:text-gray-200">
                  {entry.code}
                </span>
                <span className="min-w-0 flex-1 text-sm font-medium text-gray-900 dark:text-white">
                  {entry.title}
                </span>
                <ChevronDown
                  className={`h-4 w-4 flex-none text-gray-400 transition-transform ${
                    expanded ? "rotate-180" : ""
                  }`}
                  aria-hidden="true"
                />
              </button>

              {expanded && (
                <div className="px-2 pb-3 pt-1">
                  <p className="text-sm text-gray-600 dark:text-gray-300">
                    {entry.description}
                  </p>
                  <ol className="mt-2 space-y-1.5">
                    {steps.map((step, index) => (
                      <li
                        key={index}
                        className="flex gap-2 text-sm text-gray-700 dark:text-gray-300"
                      >
                        <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-blue-50 text-[11px] font-bold text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
                          {index + 1}
                        </span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
        <span>
          Une personne est bloquée dans la cabine ? Ne forcez jamais les portes.
          Utilisez le bouton d&apos;alarme ou le téléphone de cabine, puis
          signalez la panne ci-dessous.
        </span>
      </p>

      {result ? (
        <div
          role="status"
          className="mt-4 rounded-xl border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950/40"
        >
          <p className="flex items-center gap-2 text-sm font-semibold text-green-800 dark:text-green-300">
            <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
            Panne transmise au bureau
          </p>
          <p className="mt-1 text-sm text-green-700 dark:text-green-300">
            Référence{" "}
            <span className="font-mono font-semibold">{result.number}</span>.
            {result.assignedTo
              ? ` Un technicien a été affecté : ${result.assignedTo}.`
              : " Le bureau va affecter un technicien."}
          </p>
          {result.demo && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              Mode démonstration : le signalement n&apos;a pas été enregistré en
              base.
            </p>
          )}
          <button
            type="button"
            onClick={() => setResult(null)}
            className="mt-3 text-sm font-medium text-green-800 underline underline-offset-2 dark:text-green-300"
          >
            Signaler un autre problème
          </button>
        </div>
      ) : (
        <>
          {!formOpen && (
            <button
              type="button"
              onClick={() => setFormOpen(true)}
              className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-base font-semibold text-white transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
            >
              <Send className="h-5 w-5" aria-hidden="true" />
              Le problème persiste — prévenir le bureau
            </button>
          )}

          {formOpen && (
            <div className="mt-4 space-y-3 rounded-xl border border-gray-200 p-4 dark:border-gray-800">
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-white">
                  Signaler la panne
                </p>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  Appareil <span className="font-mono">{elevatorCode}</span> —
                  l&apos;adresse est déjà connue par le QR. Aucun compte n&apos;est
                  nécessaire.
                </p>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="scan-first-name"
                    className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
                  >
                    Prénom
                  </label>
                  <input
                    id="scan-first-name"
                    value={firstName}
                    onChange={(event) => setFirstName(event.target.value)}
                    autoComplete="given-name"
                    required
                    className={INPUT}
                  />
                </div>
                <div>
                  <label
                    htmlFor="scan-last-name"
                    className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
                  >
                    Nom
                  </label>
                  <input
                    id="scan-last-name"
                    value={lastName}
                    onChange={(event) => setLastName(event.target.value)}
                    autoComplete="family-name"
                    required
                    className={INPUT}
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="scan-phone"
                  className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
                >
                  Téléphone
                </label>
                <input
                  id="scan-phone"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  autoComplete="tel"
                  inputMode="tel"
                  required
                  placeholder="Ex. 0661 12 34 56"
                  className={INPUT}
                />
              </div>

              <div>
                <label
                  htmlFor="scan-notes"
                  className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
                >
                  Description de la panne
                </label>
                <textarea
                  id="scan-notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={3}
                  required
                  placeholder="Ex. : la porte reste ouverte au 3e étage, la cabine ne répond plus…"
                  className={INPUT}
                />
              </div>

              {error && (
                <p
                  role="alert"
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
                >
                  {error}
                </p>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setFormOpen(false);
                    setError("");
                  }}
                  className="min-h-11 flex-1 rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  Annuler
                </button>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={busy}
                  className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Envoyer
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
