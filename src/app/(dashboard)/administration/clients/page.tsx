"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Building2,
  ChevronRight,
  KeyRound,
  Loader2,
  Mail,
  Phone,
  Plus,
  RefreshCw,
  Search,
  UserRound,
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
  /** Le parc, pour la vue d'ensemble : immeubles, contacts et états. */
  ownedBuildings: {
    id: string;
    name: string;
    city: string;
    contactPerson: string;
    contactEmail: string | null;
    contactPhone: string | null;
    elevators: { status: string }[];
  }[];
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
  const [query, setQuery] = useState("");
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

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return clients
      .filter(
        (client) =>
          filter === "ALL" || effectiveType(client.clientType) === filter
      )
      .filter((client) => {
        if (!needle) return true;
        const buildings = client.ownedBuildings ?? [];
        return [
          client.name,
          client.email,
          client.phone ?? "",
          ...buildings.flatMap((building) => [
            building.name,
            building.city,
            building.contactPerson,
            building.contactPhone ?? "",
            building.contactEmail ?? "",
          ]),
        ].some((value) => value.toLowerCase().includes(needle));
      });
  }, [clients, filter, query]);

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
            Espace clients
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Gérez les comptes clients, leur parc sous contrat et l&apos;état de
            leurs appareils. Le type de compte détermine le portail que le
            client verra.
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
            Nouveau client
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
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
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

        <label className="relative block w-full lg:w-80">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Rechercher un client, un immeuble, un contact…"
            aria-label="Rechercher un client"
            className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          />
        </label>
      </div>

      {error && <ErrorState message={error} onRetry={() => void load()} />}

      {loading && <LoadingSkeleton rows={3} />}

      {!loading && !error && visible.length === 0 && (
        <EmptyState
          title={
            clients.length === 0
              ? "Aucun client pour le moment"
              : query.trim()
                ? "Aucun client ne correspond à la recherche"
                : "Aucun compte dans cette catégorie"
          }
          description={
            clients.length === 0
              ? "Un compte client donne accès à son portail : ses immeubles, ses appareils, ses contrats et ses factures. Ouvrez le premier compte, ou approuvez une demande d'accès reçue par QR."
              : query.trim()
                ? "Effacez la recherche ou changez de filtre pour retrouver le portefeuille."
                : "Changez de filtre pour voir les autres comptes."
          }
          action={
            clients.length === 0
              ? {
                  label: "Nouveau client",
                  onClick: () => setFormOpen(true),
                }
              : undefined
          }
        />
      )}

      {!loading && !error && visible.length > 0 && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-left text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-800/60 dark:text-gray-400">
                <tr>
                  <th className="px-5 py-3 font-semibold">Client</th>
                  <th className="px-5 py-3 font-semibold">Responsable du site</th>
                  <th className="px-5 py-3 font-semibold">Parc sous contrat</th>
                  <th className="px-5 py-3 font-semibold">État du parc</th>
                  <th className="px-5 py-3 font-semibold">Type</th>
                  <th className="px-5 py-3 text-right font-semibold">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {visible.map((client) => (
                  <ClientTableRow
                    key={client.id}
                    client={client}
                    onChangeType={(clientType) =>
                      void changeType(client, clientType)
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── Row ────────────────────────────────────────────────────

function ClientTableRow({
  client,
  onChangeType,
}: {
  client: ClientRow;
  onChangeType: (clientType: ClientType) => void;
}) {
  const type = effectiveType(client.clientType);

  /**
   * Le parc, résumé en trois chiffres.
   *
   * « En service » d'un côté, « à surveiller » (entretien à prévoir, anomalie
   * détectée) au milieu, « en panne » (arrêt critique, hors ligne) de l'autre :
   * c'est la lecture qu'un responsable fait d'un parc en un coup d'œil, et
   * elle tient sur une ligne.
   */
  const buildings = client.ownedBuildings ?? [];
  const elevators = buildings.flatMap((building) => building.elevators);
  const inService = elevators.filter((unit) => unit.status === "OPERATIONAL").length;
  const down = elevators.filter(
    (unit) => unit.status === "CRITICAL_SHUTDOWN" || unit.status === "OFFLINE"
  ).length;
  const watch = elevators.length - inService - down;

  const contact = buildings.find((building) => building.contactPerson?.trim());
  const buildingNames = buildings.map((building) => building.name);

  return (
    <tr className="align-top transition-colors hover:bg-gray-50/70 dark:hover:bg-gray-800/40">
      {/* ─── Identité du client ───────────────────────────── */}
      <td className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/administration/clients/${client.id}`}
            className="font-semibold text-gray-900 hover:text-blue-600 hover:underline dark:text-white dark:hover:text-blue-400"
          >
            {client.name}
          </Link>
          {!client.isActive && (
            <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[11px] font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-300">
              Désactivé
            </span>
          )}
        </div>
        <p className="mt-1 flex flex-col gap-0.5 text-xs text-gray-500 dark:text-gray-400">
          <span className="inline-flex items-center gap-1.5">
            <Mail className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
            {client.email}
          </span>
          {client.phone && (
            <span className="inline-flex items-center gap-1.5">
              <Phone className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
              {client.phone}
            </span>
          )}
        </p>
      </td>

      {/* ─── Responsable du site ──────────────────────────── */}
      <td className="px-5 py-4">
        {contact ? (
          <>
            <p className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-white">
              <UserRound className="h-3.5 w-3.5 flex-none text-gray-400" aria-hidden="true" />
              {contact.contactPerson}
            </p>
            <p className="mt-1 flex flex-col gap-0.5 text-xs text-gray-500 dark:text-gray-400">
              {contact.contactPhone && (
                <span className="inline-flex items-center gap-1.5">
                  <Phone className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
                  {contact.contactPhone}
                </span>
              )}
              {contact.contactEmail && (
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
                  {contact.contactEmail}
                </span>
              )}
            </p>
          </>
        ) : (
          <span className="text-sm text-gray-400 dark:text-gray-500">
            Non renseigné
          </span>
        )}
      </td>

      {/* ─── Parc sous contrat ────────────────────────────── */}
      <td className="px-5 py-4">
        <p className="inline-flex items-start gap-1.5 text-sm text-gray-900 dark:text-white">
          <Building2 className="mt-0.5 h-3.5 w-3.5 flex-none text-gray-400" aria-hidden="true" />
          <span>{buildingNames.length > 0 ? buildingNames.join(", ") : "Aucun immeuble"}</span>
        </p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {buildings.length} immeuble{buildings.length > 1 ? "s" : ""} ·{" "}
          {elevators.length} ascenseur{elevators.length > 1 ? "s" : ""}
        </p>
        {type === "CONTRACTED" && buildings.length === 0 && (
          <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3 w-3 flex-none" aria-hidden="true" />
            Aucun immeuble rattaché à ce compte.
          </p>
        )}
      </td>

      {/* ─── État synthétique du parc ─────────────────────── */}
      <td className="px-5 py-4">
        {elevators.length === 0 ? (
          <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold">
            <span className="rounded-full bg-green-50 px-2 py-0.5 text-green-700 dark:bg-green-950/40 dark:text-green-300">
              {inService} en service
            </span>
            {watch > 0 && (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                {watch} à surveiller
              </span>
            )}
            {down > 0 && (
              <span className="rounded-full bg-red-50 px-2 py-0.5 text-red-700 dark:bg-red-950/40 dark:text-red-300">
                {down} en panne
              </span>
            )}
          </div>
        )}
      </td>

      {/* ─── Type de compte ───────────────────────────────── */}
      <td className="px-5 py-4">
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
        {type === "NON_CONTRACTED" && buildings.length > 0 && (
          <p className="mt-1 flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3 w-3 flex-none" aria-hidden="true" />
            Parc rattaché sans contrat
          </p>
        )}
      </td>

      {/* ─── Action ───────────────────────────────────────── */}
      <td className="px-5 py-4 text-right">
        <Link
          href={`/administration/clients/${client.id}`}
          className="inline-flex items-center gap-1 whitespace-nowrap text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
        >
          Voir la fiche client
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </td>
    </tr>
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
        Nouveau client
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
