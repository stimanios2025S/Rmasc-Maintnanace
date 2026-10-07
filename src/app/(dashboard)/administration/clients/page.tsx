"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import {
  AlertTriangle,
  Building2,
  ChevronRight,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { CredentialsPanel } from "@/components/admin/credentials-panel";
import { parseDecimalInput } from "@/lib/ui/numbers";
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
  /**
   * L'accès engendré, gardé en mémoire le temps de la session d'écran.
   *
   * Le mot de passe n'est renvoyé qu'une fois par l'API et n'est stocké nulle
   * part en clair : ce state est la seule copie qui existe encore, et il
   * disparaît au rechargement de la page. C'est voulu — l'écran sert à le
   * transmettre tout de suite, pas à le retrouver plus tard.
   */
  const [created, setCreated] = useState<{
    email: string;
    password: string;
  } | null>(null);

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
        <CredentialsPanel
          email={created.email}
          password={created.password}
          onDismiss={() => setCreated(null)}
        />
      )}

      {formOpen && (
        <CreateClientForm
          onCreated={(credentials) => {
            setFormOpen(false);
            setCreated(credentials);
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
            {/* Le nom mène à la fiche du client, où vivent ses immeubles et ses
                appareils. La carte porte aussi un sélecteur de type : un lien
                qui envelopperait la carte entière transformerait chaque clic
                manqué sur le sélecteur en navigation. */}
            <Link
              href={`/administration/clients/${client.id}`}
              className="font-semibold text-gray-900 hover:text-blue-600 hover:underline dark:text-white dark:hover:text-blue-400"
            >
              {client.name}
            </Link>
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

      {/* La seule action de cette carte qui ne soit pas le sélecteur de type :
          on y va pour déclarer une adresse, un appareil, ou réémettre un accès.
          Le survol du nom y mène aussi, mais rien ne l'annonce. */}
      <Link
        href={`/administration/clients/${client.id}`}
        className="mt-3 inline-flex items-center gap-1 border-t border-gray-100 pt-3 text-sm font-medium text-blue-600 hover:text-blue-700 dark:border-gray-800 dark:text-blue-400"
      >
        <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
        Gérer le parc et l&apos;accès
        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </Card>
  );
}

// ─── Creation form ──────────────────────────────────────────

function CreateClientForm({
  onCreated,
  onCancel,
}: {
  onCreated: (credentials: { email: string; password: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [clientType, setClientType] = useState<ClientType>("CONTRACTED");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Le premier site, facultatif et replié par défaut.
   *
   * Replié parce qu'un client non contractuel n'en a aucun, et qu'un formulaire
   * qui ouvre sur six champs d'adresse pour un compte qui n'en veut pas est un
   * formulaire qu'on remplit mal. Ouvert, il n'ajoute qu'un aller-retour.
   */
  const [withBuilding, setWithBuilding] = useState(false);
  const [bName, setBName] = useState("");
  const [bAddress, setBAddress] = useState("");
  const [bCity, setBCity] = useState("");
  const [bContact, setBContact] = useState("");
  const [bPhone, setBPhone] = useState("");
  const [bLat, setBLat] = useState("");
  const [bLng, setBLng] = useState("");

  async function submit() {
    setError(null);

    /**
     * Les coordonnées sont validées ici avant l'envoi.
     *
     * L'API refuserait une latitude seule, mais son message parle de champs
     * `latitude` et `longitude` — deux noms qu'aucun libellé de ce formulaire ne
     * porte. Le dire ici évite un aller-retour réseau pour une phrase que
     * l'administrateur doit ensuite traduire.
     */
    let latitude: number | undefined;
    let longitude: number | undefined;
    if (withBuilding && (bLat.trim() !== "" || bLng.trim() !== "")) {
      const lat = parseDecimalInput(bLat, { allowNegative: true });
      const lng = parseDecimalInput(bLng, { allowNegative: true });
      if (lat === null || lng === null) {
        setError(
          "Renseignez la latitude et la longitude ensemble, ou laissez les deux vides."
        );
        return;
      }
      if (lat < -90 || lat > 90) {
        setError("La latitude doit être comprise entre -90 et 90.");
        return;
      }
      if (lng < -180 || lng > 180) {
        setError("La longitude doit être comprise entre -180 et 180.");
        return;
      }
      latitude = lat;
      longitude = lng;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          clientType,
          // Omitted rather than sent empty: the API's schema takes an optional
          // string and an empty one would be stored as "" instead of NULL.
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(address.trim() ? { address: address.trim() } : {}),
          ...(withBuilding
            ? {
                building: {
                  name: bName.trim(),
                  address: bAddress.trim(),
                  city: bCity.trim(),
                  contactPerson: bContact.trim(),
                  ...(bPhone.trim() ? { contactPhone: bPhone.trim() } : {}),
                  ...(latitude !== undefined && longitude !== undefined
                    ? { latitude, longitude }
                    : {}),
                },
              }
            : {}),
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
      const createdEmail: string = payload?.data?.client?.email ?? email;
      const password: string | undefined = payload?.data?.password;

      // Sans mot de passe dans la réponse, l'écran n'aurait rien à montrer et le
      // compte serait ouvert sans que personne ne puisse s'y connecter. Le dire
      // franchement vaut mieux que d'afficher un panneau vide.
      if (!password) {
        throw new Error(
          "Le compte a été créé mais l'accès n'a pas été renvoyé. Réémettre un mot de passe depuis la fiche du client."
        );
      }

      onCreated({ email: createdEmail, password });
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
        Le compte est ouvert avec l&apos;adresse e-mail saisie ici, et un mot de
        passe engendré par le système — affiché une seule fois, juste après la
        création.
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

          <div className="sm:col-span-2">
            <label
              htmlFor="client-adresse"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Adresse du client{" "}
              <span className="text-gray-400">(facultatif)</span>
            </label>
            <input
              id="client-adresse"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="Siège, adresse de facturation"
              aria-describedby="client-adresse-aide"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
            <p
              id="client-adresse-aide"
              className="mt-1 text-xs text-gray-500 dark:text-gray-400"
            >
              L&apos;adresse du client, pas celle de ses immeubles : c&apos;est
              ici qu&apos;une facture se poste, alors qu&apos;une intervention
              part à l&apos;adresse du site.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/30">
          <p className="flex items-start gap-2 text-xs text-blue-800 dark:text-blue-300">
            <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              Le mot de passe du client est engendré par le système et affiché
              une seule fois après la création. Il n&apos;est conservé nulle part
              en clair.
            </span>
          </p>
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

        {/* ─── Premier immeuble ─────────────────────────────── */}
        <fieldset className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
          <legend className="px-1 text-sm font-medium text-gray-700 dark:text-gray-300">
            Premier immeuble <span className="text-gray-400">(facultatif)</span>
          </legend>

          <label
            htmlFor="client-avec-immeuble"
            className="flex cursor-pointer items-start gap-3"
          >
            <input
              id="client-avec-immeuble"
              type="checkbox"
              checked={withBuilding}
              onChange={(event) => setWithBuilding(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-blue-600"
            />
            <span>
              <span className="block text-sm text-gray-900 dark:text-white">
                Déclarer une adresse de site maintenant
              </span>
              <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                Les appareils s&apos;ajouteront ensuite, depuis la fiche du
                client, quand leurs caractéristiques techniques seront relevées.
                Un ascenseur ne s&apos;enregistre pas sans sa plaque
                constructeur : les seuils d&apos;alerte et la durée de vie des
                pièces se calculent sur ces chiffres.
              </span>
            </span>
          </label>

          {withBuilding && (
            <div className="mt-4 grid gap-4 border-t border-gray-100 pt-4 sm:grid-cols-2 dark:border-gray-800">
              <div className="sm:col-span-2">
                <label
                  htmlFor="immeuble-nom"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  Nom de l&apos;immeuble
                </label>
                <input
                  id="immeuble-nom"
                  value={bName}
                  onChange={(event) => setBName(event.target.value)}
                  required={withBuilding}
                  placeholder="Résidence Les Oliviers"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                />
              </div>

              <div className="sm:col-span-2">
                <label
                  htmlFor="immeuble-adresse"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  Adresse du site
                </label>
                <input
                  id="immeuble-adresse"
                  value={bAddress}
                  onChange={(event) => setBAddress(event.target.value)}
                  required={withBuilding}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                />
              </div>

              <div>
                <label
                  htmlFor="immeuble-ville"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  Ville
                </label>
                <input
                  id="immeuble-ville"
                  value={bCity}
                  onChange={(event) => setBCity(event.target.value)}
                  required={withBuilding}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                />
              </div>

              <div>
                <label
                  htmlFor="immeuble-contact"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  Contact sur site
                </label>
                <input
                  id="immeuble-contact"
                  value={bContact}
                  onChange={(event) => setBContact(event.target.value)}
                  required={withBuilding}
                  placeholder="Le concierge, le syndic…"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                />
              </div>

              <div>
                <label
                  htmlFor="immeuble-telephone"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  Téléphone du contact{" "}
                  <span className="text-gray-400">(facultatif)</span>
                </label>
                <input
                  id="immeuble-telephone"
                  value={bPhone}
                  onChange={(event) => setBPhone(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="immeuble-latitude"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    Latitude
                  </label>
                  <input
                    id="immeuble-latitude"
                    value={bLat}
                    onChange={(event) => setBLat(event.target.value)}
                    inputMode="decimal"
                    placeholder="36.7538"
                    aria-describedby="immeuble-coordonnees-aide"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm tabular-nums text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                  />
                </div>
                <div>
                  <label
                    htmlFor="immeuble-longitude"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    Longitude
                  </label>
                  <input
                    id="immeuble-longitude"
                    value={bLng}
                    onChange={(event) => setBLng(event.target.value)}
                    inputMode="decimal"
                    placeholder="3.0588"
                    aria-describedby="immeuble-coordonnees-aide"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm tabular-nums text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                  />
                </div>
                <p
                  id="immeuble-coordonnees-aide"
                  className="col-span-2 text-xs text-gray-500 dark:text-gray-400"
                >
                  Facultatives, mais les deux ensemble ou aucune. Elles servent au
                  contrôle de distance lors du pointage d&apos;arrivée du
                  technicien : sans elles, un pointage est accepté sans
                  vérification.
                </p>
              </div>
            </div>
          )}
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
