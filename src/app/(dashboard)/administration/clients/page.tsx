"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { AlertTriangle, CheckCircle2, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { CLIENT_TYPE_LABELS } from "@/types";
import type { ClientType } from "@/types";

/**
 * Client account administration.
 *
 * WHY THIS SCREEN IS THE ONE THAT SPLITS THE CUSTOMER BASE
 * The contract status is not a label — it decides which portal the account
 * gets. A contracted customer reports faults against elevators we already know
 * about; a non-contracted one has no file with us at all and their portal is
 * the « Fiche Technique » form. So the type is chosen here, once, by the
 * administrator, and the choice is required rather than defaulted: silently
 * defaulting it would hand someone the wrong portal and neither they nor we
 * would notice until they could not find the thing they were looking for.
 *
 * The type stays editable afterwards. A choice made at account creation that
 * could never be corrected would turn one mis-click into a support call and a
 * database edit.
 */

interface ClientRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  clientType: ClientType | null;
  isActive: boolean;
  createdAt: string;
  _count: { ownedBuildings: number; technicalSheets: number };
}

/** A NULL type reads as contracted — see `isNonContractedClient` in `@/types`. */
function effectiveType(clientType: ClientType | null): ClientType {
  return clientType === "NON_CONTRACTED" ? "NON_CONTRACTED" : "CONTRACTED";
}

type Filter = "ALL" | ClientType;

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: "ALL", label: "Tous" },
  { id: "CONTRACTED", label: CLIENT_TYPE_LABELS.CONTRACTED },
  { id: "NON_CONTRACTED", label: CLIENT_TYPE_LABELS.NON_CONTRACTED },
];

export default function ClientsAdminPage() {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [formOpen, setFormOpen] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/clients");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      setClients(payload?.data?.clients ?? []);
    } catch {
      setError("Impossible de charger les comptes clients.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () =>
      filter === "ALL"
        ? clients
        : clients.filter((client) => effectiveType(client.clientType) === filter),
    [clients, filter]
  );

  const counts = useMemo(
    () => ({
      ALL: clients.length,
      CONTRACTED: clients.filter(
        (c) => effectiveType(c.clientType) === "CONTRACTED"
      ).length,
      NON_CONTRACTED: clients.filter(
        (c) => effectiveType(c.clientType) === "NON_CONTRACTED"
      ).length,
    }),
    [clients]
  );

  async function changeType(client: ClientRow, clientType: ClientType) {
    setError(null);
    try {
      const res = await fetch("/api/clients", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: client.id, clientType }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error ?? "Le changement de type a échoué.");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Le changement de type a échoué.");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Comptes clients
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Ouvrez un compte pour un client, avec ou sans contrat de
            maintenance. Le type choisi détermine le portail que le client
            verra.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            )}
            Actualiser
          </button>
          <button
            type="button"
            onClick={() => {
              setFormOpen((open) => !open);
              setCreated(null);
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
          >
            {formOpen ? (
              <X className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Plus className="h-4 w-4" aria-hidden="true" />
            )}
            Nouveau compte client
          </button>
        </div>
      </div>

      {created && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Le compte <strong>{created}</strong> a été créé. Communiquez le mot
            de passe au client par un autre canal que cette application.
          </span>
        </p>
      )}

      {formOpen && (
        <CreateClientForm
          onCreated={(email) => {
            setFormOpen(false);
            setCreated(email);
            void load();
          }}
          onCancel={() => setFormOpen(false)}
        />
      )}

      {/* Tabs rather than a single list: the whole point of this screen is that
          the two categories are different, so they are separated in the
          interface and not only in the database. */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filtrer les comptes">
        {FILTERS.map((entry) => {
          const active = filter === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(entry.id)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              }`}
            >
              {entry.label}
              <span className={active ? "ml-2 opacity-80" : "ml-2 text-gray-500"}>
                {counts[entry.id]}
              </span>
            </button>
          );
        })}
      </div>

      {error && <ErrorState message={error} onRetry={() => void load()} />}

      {loading && <LoadingSkeleton rows={3} />}

      {!loading && !error && visible.length === 0 && (
        <EmptyState
          title={
            clients.length === 0
              ? "Aucun compte client pour le moment"
              : "Aucun compte dans cette catégorie"
          }
          hint={
            clients.length === 0
              ? "Ouvrez le premier compte avec le bouton ci-dessus."
              : "Changez de filtre pour voir les autres comptes."
          }
        />
      )}

      {!loading && !error && visible.length > 0 && (
        <div className="space-y-3">
          {visible.map((client) => (
            <ClientCard
              key={client.id}
              client={client}
              onChangeType={(clientType) => void changeType(client, clientType)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Row ────────────────────────────────────────────────────

function ClientCard({
  client,
  onChangeType,
}: {
  client: ClientRow;
  onChangeType: (clientType: ClientType) => void;
}) {
  const type = effectiveType(client.clientType);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-gray-900 dark:text-white">
              {client.name}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                type === "CONTRACTED"
                  ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
                  : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
              }`}
            >
              {CLIENT_TYPE_LABELS[type]}
            </span>
            {!client.isActive && (
              <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                Désactivé
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            {client.email}
            {client.phone ? ` · ${client.phone}` : ""}
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {client._count.ownedBuildings} immeuble
            {client._count.ownedBuildings > 1 ? "s" : ""} ·{" "}
            {client._count.technicalSheets} fiche
            {client._count.technicalSheets > 1 ? "s" : ""} technique
            {client._count.technicalSheets > 1 ? "s" : ""} · créé le{" "}
            {format(new Date(client.createdAt), "d MMMM yyyy", { locale: fr })}
          </p>
        </div>

        <label className="flex shrink-0 flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
          Type de client
          <select
            value={type}
            onChange={(event) => onChangeType(event.target.value as ClientType)}
            aria-label={`Type de client pour ${client.name}`}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          >
            <option value="CONTRACTED">{CLIENT_TYPE_LABELS.CONTRACTED}</option>
            <option value="NON_CONTRACTED">
              {CLIENT_TYPE_LABELS.NON_CONTRACTED}
            </option>
          </select>
        </label>
      </div>

      {/* A non-contracted client with buildings, or a contracted one with none,
          is a contradiction worth flagging on the row rather than leaving for
          someone to discover through a support call. */}
      {type === "NON_CONTRACTED" && client._count.ownedBuildings > 0 && (
        <p className="mt-3 flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Ce compte est marqué « sans contrat » mais des immeubles lui sont
          rattachés.
        </p>
      )}
      {type === "CONTRACTED" && client._count.ownedBuildings === 0 && (
        <p className="mt-3 flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Aucun immeuble rattaché à ce compte.
        </p>
      )}
    </Card>
  );
}

// ─── Creation form ──────────────────────────────────────────

function CreateClientForm({
  onCreated,
  onCancel,
}: {
  onCreated: (email: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [clientType, setClientType] = useState<ClientType>("CONTRACTED");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          password,
          clientType,
          // Omitted rather than sent empty: the API's schema takes an optional
          // string and an empty one would be stored as "" instead of NULL.
          ...(phone.trim() ? { phone: phone.trim() } : {}),
        }),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        const issues = payload?.details?.issues ?? [];
        if (Array.isArray(issues) && issues.length > 0) {
          throw new Error(issues.map((i: { message: string }) => i.message).join(" "));
        }
        throw new Error(payload?.error ?? "La création du compte a échoué.");
      }

      const payload = await res.json();
      onCreated(payload?.data?.email ?? email);
    } catch (e) {
      setError(e instanceof Error ? e.message : "La création du compte a échoué.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
        Nouveau compte client
      </h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Le client se connecte avec l&apos;adresse e-mail et le mot de passe
        définis ici.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="mt-4 space-y-4"
        noValidate
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="client-nom"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Nom
            </label>
            <input
              id="client-nom"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
          </div>

          <div>
            <label
              htmlFor="client-email"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Adresse e-mail
            </label>
            <input
              id="client-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
          </div>

          <div>
            <label
              htmlFor="client-telephone"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Téléphone <span className="text-gray-400">(facultatif)</span>
            </label>
            <input
              id="client-telephone"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
          </div>

          <div>
            <label
              htmlFor="client-mot-de-passe"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Mot de passe
            </label>
            <input
              id="client-mot-de-passe"
              type="text"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              aria-describedby="client-mot-de-passe-aide"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
            <p
              id="client-mot-de-passe-aide"
              className="mt-1 text-xs text-gray-500 dark:text-gray-400"
            >
              Au moins 8 caractères. Affiché en clair pour que vous puissiez le
              transmettre — ne le laissez pas à l&apos;écran.
            </p>
          </div>
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Type de client
          </legend>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {(["CONTRACTED", "NON_CONTRACTED"] as const).map((value) => {
              const selected = clientType === value;
              return (
                <label
                  key={value}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3 transition-colors ${
                    selected
                      ? "border-blue-500 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/30"
                      : "border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600"
                  }`}
                >
                  <input
                    type="radio"
                    name="clientType"
                    value={value}
                    checked={selected}
                    onChange={() => setClientType(value)}
                    className="mt-0.5 h-4 w-4 accent-blue-600"
                  />
                  <span>
                    <span className="block text-sm font-medium text-gray-900 dark:text-white">
                      {CLIENT_TYPE_LABELS[value]}
                    </span>
                    <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                      {value === "CONTRACTED"
                        ? "Portail de signalement habituel : urgence, assistant de dépannage, suivi des incidents. Pas de fiche technique."
                        : "Le client remplit la fiche technique de son installation. Aucun signalement d'incident."}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {error && (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
          >
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Annuler
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
          >
            {submitting && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            Créer le compte
          </button>
        </div>
      </form>
    </Card>
  );
}
