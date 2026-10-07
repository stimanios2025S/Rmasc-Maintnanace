"use client";

import { useState } from "react";
import { AlertTriangle, Check, Copy, KeyRound, X } from "lucide-react";
import { Card } from "@/components/ui/card";

/**
 * Le panneau qui montre un mot de passe engendré — une fois, et jamais plus.
 *
 * POURQUOI IL EST PARTAGÉ
 * L'ouverture d'un compte client et celle d'un compte salarié produisent la
 * même chose : un secret tiré au hasard, haché en base, et affiché le temps
 * d'une réponse. Le panneau qui le présente portait donc deux copies de la même
 * logique — dont un repli sur `navigator.clipboard` absent hors contexte
 * sécurisé, qui est exactement le genre de détail qu'on ne veut pas avoir à
 * corriger deux fois.
 *
 * CE QU'IL DIT, ET POURQUOI IL LE DIT
 * La phrase d'avertissement n'est pas décorative : c'est la seule occasion de
 * faire comprendre que le mot de passe n'est pas relisible. Un administrateur
 * qui ferme le panneau sans l'avoir noté devra en engendrer un nouveau, et il
 * vaut mieux qu'il l'apprenne ici qu'au téléphone.
 */

export function CredentialsPanel({
  email,
  password,
  /** Le mot qui désigne la personne : « client », « salarié ». */
  subject = "client",
  /** Ce qu'on nomme comme l'endroit où régénérer l'accès. */
  regenerateFrom = "la fiche du client",
  onDismiss,
}: {
  email: string;
  password: string;
  subject?: string;
  regenerateFrom?: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // `navigator.clipboard` n'existe pas hors contexte sécurisé — un accès par
      // IP sur http, par exemple. Le mot de passe reste à l'écran, sélectionnable
      // à la main ; inutile d'alerter pour une commodité qui n'a pas marché.
    }
  };

  return (
    <Card className="border-emerald-300 p-5 dark:border-emerald-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <KeyRound
            className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              Accès créé
            </h2>
            <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
              Compte <strong className="text-gray-900 dark:text-white">{email}</strong>
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Masquer l'accès"
          className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <code className="flex-1 select-all rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 font-mono text-base tracking-wide text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-white">
          {password}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          {copied ? (
            <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" />
          ) : (
            <Copy className="h-4 w-4" aria-hidden="true" />
          )}
          {copied ? "Copié" : "Copier"}
        </button>
      </div>

      <p className="mt-3 flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Ce mot de passe ne sera plus jamais affiché — il n&apos;est conservé nulle
        part en clair. Notez-le maintenant, et transmettez-le au {subject} par un
        autre canal que cette application. S&apos;il est perdu, un nouveau pourra
        être engendré depuis {regenerateFrom}.
      </p>
    </Card>
  );
}

/**
 * Le bouton de copie d'une valeur isolée.
 *
 * Le repli silencieux est le même que ci-dessus, et pour la même raison : hors
 * contexte sécurisé l'API n'existe pas, et la valeur reste sélectionnable à la
 * main.
 */
export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void (async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2500);
          } catch {
            // Hors contexte sécurisé (accès par IP en http), l'API n'existe pas.
            // La valeur reste sélectionnable à la main.
          }
        })();
      }}
      aria-label="Copier le mot de passe"
      className="rounded-lg border border-gray-300 p-2 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
    >
      {copied ? (
        <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" />
      ) : (
        <Copy className="h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );
}
