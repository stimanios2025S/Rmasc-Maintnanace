"use client";

/**
 * Le formulaire de demande d'accès, sur la page publique du QR.
 *
 * TROIS CHAMPS DE PLUS QUE LE STRICT NÉCESSAIRE, ET AUCUN DE PLUS
 * Nom, téléphone, e-mail et rôle déclaré. Le rôle est une liste plutôt qu'un
 * texte libre : le bureau trie les demandes par ce qu'elles sont — un syndic
 * n'appelle pas pour les mêmes raisons qu'un propriétaire —, et une saisie
 * libre donnerait « syndic », « Syndic », « SYNDIC » et « gestionnaire ».
 *
 * CE QU'IL NE FAIT PAS
 * Il n'ouvre aucun compte. Il dépose une ligne PENDING et le dit à l'écran :
 * laisser croire à un accès immédiat ferait scanner à nouveau, ou appeler le
 * bureau pour demander pourquoi rien ne s'ouvre.
 */

import { useState } from "react";
import { CheckCircle2, Loader2, Send } from "lucide-react";

/** Les trois qualités que le bureau distingue à la réception. */
const ROLES = ["Syndic", "Promoteur", "Propriétaire"] as const;

export function AccessRequestForm({ elevatorId }: { elevatorId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>(ROLES[0]);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");

    try {
      const response = await fetch("/api/access-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elevatorId,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          phone: phone.trim(),
          email: email.trim(),
          role,
        }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        // `jsonError` rend `{ error: "…" }` — une phrase, pas un objet. Les
        // deux formes sont lues parce que ce n'est pas à l'écran de deviner
        // laquelle la route a choisie.
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : payload?.error?.message;
        throw new Error(
          message ??
            payload?.message ??
            `La demande n'a pas pu être enregistrée (${response.status}).`
        );
      }

      setSent(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "La demande n'a pas pu être enregistrée."
      );
    } finally {
      setPending(false);
    }
  }

  if (!expanded) {
    return (
      <section className="rounded-2xl border border-gray-200 bg-white p-5 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">
          Vous gérez cet appareil ?
        </h2>
        <p className="mt-1 text-xs text-gray-500">
          Syndic, promoteur ou propriétaire : demandez un accès client. Le
          bureau vérifie la demande avant de l&apos;ouvrir.
        </p>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-4 inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          Demander un accès client
        </button>
      </section>
    );
  }

  if (sent) {
    return (
      <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center dark:border-emerald-900 dark:bg-emerald-950/40">
        <CheckCircle2
          className="mx-auto h-8 w-8 text-emerald-600"
          aria-hidden="true"
        />
        <h2 className="mt-3 text-base font-semibold text-emerald-900 dark:text-emerald-200">
          Demande enregistrée
        </h2>
        <p className="mt-2 text-sm text-emerald-800 dark:text-emerald-300">
          Le bureau va vérifier votre demande et vous transmettre vos accès. Vous
          n&apos;avez rien d&apos;autre à faire.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <h2 className="text-base font-semibold text-gray-900 dark:text-white">
        Demander un accès client
      </h2>
      <p className="mt-1 text-xs text-gray-500">
        Vos accès sont ouverts après vérification par le bureau. Aucun mot de
        passe n&apos;est choisi ici : le système en engendre un.
      </p>

      <form onSubmit={submit} className="mt-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Prénom
            </span>
            <input
              required
              maxLength={80}
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Nom
            </span>
            <input
              required
              maxLength={80}
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
            />
          </label>
        </div>

        <label className="block">
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
            Téléphone
          </span>
          <input
            required
            type="tel"
            maxLength={40}
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="0661 23 45 67"
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
            E-mail
          </span>
          <input
            required
            type="email"
            maxLength={200}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
            Rôle
          </span>
          <select
            value={role}
            onChange={(event) => setRole(event.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
          >
            {ROLES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="h-4 w-4" aria-hidden="true" />
          )}
          {pending ? "Envoi…" : "Envoyer la demande"}
        </button>
      </form>
    </section>
  );
}
