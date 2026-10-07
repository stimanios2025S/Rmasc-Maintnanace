"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  ChevronRight,
  Gauge,
  KeyRound,
  Link2,
  Loader2,
  MapPin,
  Plus,
  Unlink,
  Wrench,
  X,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { CopyButton } from "@/components/admin/credentials-panel";
import { enumLabel } from "@/lib/ui/enum-labels";
import { parseDecimalInput } from "@/lib/ui/numbers";
import {
  CLIENT_TYPE_LABELS,
  CONTROLLER_TYPES,
  ELEVATOR_BRANDS,
  MOTOR_TYPES,
  SLA_TIERS,
} from "@/types";
import type { ClientType } from "@/types";

/**
 * Fiche d'un compte client : son parc, ses appareils, son accès.
 *
 * POURQUOI CET ÉCRAN EXISTE
 * L'ouverture d'un compte ne dit qu'une chose : qui est le client. Tout le reste
 * — l'adresse d'un site, son contact, la position GPS qui sert au contrôle de
 * distance des pointages, les ascenseurs et leurs caractéristiques — arrive
 * après, au rythme des visites. Sans cet écran, la seule façon de compléter un
 * dossier était `POST /api/buildings` à la main, et la page `/ascenseurs` le dit
 * elle-même : « Enregistrez des ascenseurs via POST /api/elevators ».
 *
 * ON N'Y CRÉE PAS D'ASCENSEUR SANS SES CARACTÉRISTIQUES
 * Le formulaire les demande toutes. Ce n'est pas de la rigidité : les seuils
 * d'alerte, le calcul de durée de vie des pièces et le moteur prédictif lisent
 * la marque, le moteur, la charge et le nombre de niveaux. Une valeur inventée
 * pour remplir un champ produirait des alertes calculées sur du faux, ce que le
 * mode démonstration de ce produit refuse déjà par principe.
 *
 * CE QU'ON PEUT FAIRE ICI
 *  - créer un immeuble pour ce client (adresse, contact, GPS, palier de service)
 *  - lui rattacher un immeuble déjà en base, y compris détenu par un autre
 *  - détacher un immeuble, sans jamais le supprimer
 *  - ajouter un ascenseur à un immeuble
 *  - réémettre son mot de passe d'accès
 */

// ─── Types ──────────────────────────────────────────────────

interface ElevatorRow {
  id: string;
  elevatorCode: string;
  brand: string;
  model: string;
  serialNumber: string | null;
  motorType: string;
  controllerType: string;
  floorsServed: number;
  maxPayloadKg: number;
  installationDate: string | null;
  status: string;
  overallHealth: number;
  nextMaintenance: string | null;
}

interface BuildingRow {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string | null;
  zipCode: string | null;
  contactPerson: string;
  contactEmail: string | null;
  contactPhone: string | null;
  slaTier: string;
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusM: number | null;
  elevators: ElevatorRow[];
}

interface ClientDetail {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  address: string | null;
  clientType: ClientType | null;
  isActive: boolean;
  createdAt: string;
  ownedBuildings: BuildingRow[];
}

interface AttachableRow {
  id: string;
  name: string;
  address: string;
  city: string;
  owner: { id: string; name: string } | null;
  elevatorCount: number;
}

/** A NULL type reads as contracted — the rule `@/types` documents. */
function effectiveType(clientType: ClientType | null): ClientType {
  return clientType === "NON_CONTRACTED" ? "NON_CONTRACTED" : "CONTRACTED";
}

const FIELD =
  "mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white";

const FIELD_NUM = `${FIELD} tabular-nums`;

const LABEL = "block text-sm font-medium text-gray-700 dark:text-gray-300";

// ─── Page ───────────────────────────────────────────────────

export default function ClientDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const [client, setClient] = useState<ClientDetail | null>(null);
  const [attachable, setAttachable] = useState<AttachableRow[]>([]);
  const [attachableTruncated, setAttachableTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [panel, setPanel] = useState<"building" | "attach" | null>(null);
  const [elevatorFor, setElevatorFor] = useState<string | null>(null);
  const [attachQuery, setAttachQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  /** Le mot de passe réémis, gardé le temps de l'écran — voir le panneau. */
  const [issuedPassword, setIssuedPassword] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${id}`);
      if (res.status === 404) throw new Error("Compte client introuvable");
      if (!res.ok) throw new Error(`La fiche a renvoyé ${res.status}`);
      const payload = await res.json();
      setClient(payload?.data?.client ?? null);
      setAttachable(payload?.data?.attachable ?? []);
      setAttachableTruncated(Boolean(payload?.data?.attachableTruncated));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Impossible de charger la fiche");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * La recherche d'immeubles à rattacher interroge le serveur, pas la liste
   * déjà reçue.
   *
   * La réponse est bornée à cinquante immeubles : filtrer localement
   * chercherait donc dans un échantillon arbitraire, et un immeuble existant
   * mais absent des cinquante premiers serait déclaré introuvable. Le délai
   * évite une requête par frappe.
   */
  useEffect(() => {
    if (panel !== "attach") return;
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(
            `/api/clients/${id}?q=${encodeURIComponent(attachQuery)}`
          );
          if (!res.ok) return;
          const payload = await res.json();
          setAttachable(payload?.data?.attachable ?? []);
          setAttachableTruncated(Boolean(payload?.data?.attachableTruncated));
        } catch {
          // Une recherche qui échoue n'efface pas la liste : l'administrateur
          // garde ce qu'il avait sous les yeux et peut réessayer en tapant.
        }
      })();
    }, 300);
    return () => window.clearTimeout(handle);
  }, [attachQuery, panel, id]);

  async function detach(building: BuildingRow) {
    setActionError("");
    if (
      !window.confirm(
        `Détacher « ${building.name} » de ${client?.name ?? "ce client"} ?\n\n` +
          "L'immeuble, ses appareils et son historique sont conservés ; il " +
          "cesse simplement d'apparaître dans le portail de ce client."
      )
    ) {
      return;
    }

    setBusyId(building.id);
    try {
      const res = await fetch(
        `/api/clients/${id}/buildings?buildingId=${encodeURIComponent(building.id)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error ?? "Le détachement a échoué.");
      }
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Le détachement a échoué.");
    } finally {
      setBusyId(null);
    }
  }

  async function regeneratePassword() {
    setActionError("");
    setIssuedPassword(null);
    if (
      !window.confirm(
        "Réémettre l'accès de ce client ?\n\n" +
          "Son mot de passe actuel cessera immédiatement de fonctionner, et " +
          "toutes ses sessions ouvertes seront fermées."
      )
    ) {
      return;
    }

    setBusyId("password");
    try {
      const res = await fetch(`/api/clients/${id}/password`, { method: "POST" });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.error ?? "La réémission a échoué.");
      }
      setIssuedPassword(payload?.data?.password ?? null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "La réémission a échoué.");
    } finally {
      setBusyId(null);
    }
  }

  if (loading && !client) {
    return (
      <div className="space-y-4">
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  if (error && !client) {
    return <ErrorState message={error} onRetry={() => void load()} />;
  }

  if (!client) {
    return (
      <EmptyState
        title="Compte client introuvable"
        hint="Il a peut-être été désactivé, ou le lien est incomplet."
      />
    );
  }

  const type = effectiveType(client.clientType);
  const elevatorTotal = client.ownedBuildings.reduce(
    (sum, building) => sum + building.elevators.length,
    0
  );

  return (
    <div className="space-y-6">
      <Link
        href="/administration/clients"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Comptes clients
      </Link>

      {/* ── En-tête ──────────────────────────────────────────── */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-gray-900 dark:text-white">
                {client.name}
              </h1>
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
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {client.email}
              {client.phone ? ` · ${client.phone}` : ""}
            </p>
            {client.address && (
              <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
                {client.address}
              </p>
            )}
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {client.ownedBuildings.length} immeuble
              {client.ownedBuildings.length > 1 ? "s" : ""} · {elevatorTotal}{" "}
              appareil{elevatorTotal > 1 ? "s" : ""} · compte ouvert le{" "}
              {format(new Date(client.createdAt), "d MMMM yyyy", { locale: fr })}
            </p>
          </div>
        </div>

        {type === "CONTRACTED" && client.ownedBuildings.length === 0 && (
          <p className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            Ce client a un contrat mais aucun immeuble : son portail n&apos;a
            aucun appareil à lui proposer pour signaler une panne.
          </p>
        )}
      </Card>

      {actionError && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-900/20 dark:text-red-300"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {actionError}
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* ── Parc ───────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Immeubles et appareils
            </h2>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setPanel(panel === "attach" ? null : "attach");
                  setElevatorFor(null);
                }}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <Link2 className="h-4 w-4" aria-hidden="true" />
                Rattacher un immeuble
              </button>
              <button
                type="button"
                onClick={() => {
                  setPanel(panel === "building" ? null : "building");
                  setElevatorFor(null);
                }}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Nouvel immeuble
              </button>
            </div>
          </div>

          {panel === "attach" && (
            <AttachBuildingPanel
              clientId={id}
              clientName={client.name}
              buildings={attachable}
              truncated={attachableTruncated}
              query={attachQuery}
              onQueryChange={setAttachQuery}
              onDone={async () => {
                setPanel(null);
                setAttachQuery("");
                await load();
              }}
              onCancel={() => {
                setPanel(null);
                setAttachQuery("");
              }}
            />
          )}

          {panel === "building" && client && (
            <AddBuildingForm
              clientId={id}
              clientName={client.name}
              clientPhone={client.phone}
              onDone={async () => {
                setPanel(null);
                await load();
              }}
              onCancel={() => setPanel(null)}
            />
          )}

          {client.ownedBuildings.length === 0 && panel === null && (
            <EmptyState
              title="Aucun immeuble rattaché"
              hint="Déclarez une adresse de site, ou rattachez un immeuble déjà en base."
            />
          )}

          <div className="space-y-4">
            {client.ownedBuildings.map((building) => (
              <Card key={building.id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Building2
                        className="h-4 w-4 shrink-0 text-gray-400"
                        aria-hidden="true"
                      />
                      <h3 className="font-semibold text-gray-900 dark:text-white">
                        {building.name}
                      </h3>
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                        {enumLabel(building.slaTier)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      {building.address}, {building.city}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                      Contact : {building.contactPerson}
                      {building.contactPhone ? ` · ${building.contactPhone}` : ""}
                    </p>
                    <p className="mt-1 flex items-center gap-1.5 text-xs">
                      <MapPin
                        className="h-3.5 w-3.5 shrink-0 text-gray-400"
                        aria-hidden="true"
                      />
                      {building.latitude !== null &&
                      building.longitude !== null ? (
                        <span className="tabular-nums text-gray-500 dark:text-gray-400">
                          {building.latitude.toFixed(4)},{" "}
                          {building.longitude.toFixed(4)}
                          {building.geofenceRadiusM !== null
                            ? ` · rayon ${building.geofenceRadiusM} m`
                            : " · rayon par défaut"}
                        </span>
                      ) : (
                        // Une position absente n'est pas une erreur, mais elle a
                        // une conséquence qu'il faut nommer : sans coordonnées,
                        // le pointage d'arrivée du technicien n'est pas
                        // contrôlé.
                        <span className="text-amber-700 dark:text-amber-400">
                          Position inconnue — les pointages ne sont pas
                          contrôlés en distance.
                        </span>
                      )}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => void detach(building)}
                    disabled={busyId === building.id}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:border-red-900 dark:hover:bg-red-900/20 dark:hover:text-red-300"
                  >
                    {busyId === building.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    Détacher
                  </button>
                </div>

                {/* ── Appareils ─────────────────────────────────── */}
                <div className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-800">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
                      Appareils{" "}
                      <span className="font-normal text-gray-500 dark:text-gray-400">
                        ({building.elevators.length})
                      </span>
                    </h4>
                    <button
                      type="button"
                      onClick={() =>
                        setElevatorFor(
                          elevatorFor === building.id ? null : building.id
                        )
                      }
                      className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400"
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                      Ajouter un ascenseur
                    </button>
                  </div>

                  {building.elevators.length === 0 ? (
                    <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                      Aucun appareil déclaré à cette adresse.
                    </p>
                  ) : (
                    <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-800">
                      {building.elevators.map((elevator) => (
                        <li
                          key={elevator.id}
                          className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5"
                        >
                          <div className="min-w-0">
                            <p className="flex flex-wrap items-baseline gap-2">
                              <span className="font-mono text-sm font-medium text-gray-900 dark:text-white">
                                {elevator.elevatorCode}
                              </span>
                              <span className="text-sm text-gray-600 dark:text-gray-300">
                                {enumLabel(elevator.brand)} {elevator.model}
                              </span>
                            </p>
                            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                              {enumLabel(elevator.motorType)} ·{" "}
                              {enumLabel(elevator.controllerType)} ·{" "}
                              {elevator.floorsServed} niveaux ·{" "}
                              {elevator.maxPayloadKg} kg
                              {elevator.serialNumber
                                ? ` · n° ${elevator.serialNumber}`
                                : ""}
                            </p>
                          </div>
                          <div className="flex items-center gap-3 text-xs">
                            <span className="inline-flex items-center gap-1 tabular-nums text-gray-500 dark:text-gray-400">
                              <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
                              {Math.round(elevator.overallHealth)} %
                            </span>
                            <span
                              className={`rounded-full px-2 py-0.5 font-medium ${
                                elevator.status === "OPERATIONAL"
                                  ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                                  : elevator.status === "OFFLINE"
                                    ? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                                    : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                              }`}
                            >
                              {enumLabel(elevator.status)}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}

                  {elevatorFor === building.id && (
                    <AddElevatorForm
                      buildingId={building.id}
                      buildingName={building.name}
                      onDone={async () => {
                        setElevatorFor(null);
                        await load();
                      }}
                      onCancel={() => setElevatorFor(null)}
                    />
                  )}
                </div>
              </Card>
            ))}
          </div>
        </div>

        {/* ── Accès ────────────────────────────────────────────── */}
        <div className="lg:col-span-1">
          <Card className="p-5">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-gray-400" aria-hidden="true" />
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">
                Accès au portail
              </h2>
            </div>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
              Identifiant :{" "}
              <span className="font-medium text-gray-900 dark:text-white">
                {client.email}
              </span>
            </p>

            {issuedPassword && (
              <div className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950/30">
                <p className="text-xs font-medium uppercase tracking-wide text-emerald-800 dark:text-emerald-300">
                  Nouveau mot de passe
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="flex-1 select-all rounded-lg border border-emerald-200 bg-white px-3 py-2 font-mono text-sm tracking-wide text-gray-900 dark:border-emerald-900 dark:bg-gray-900 dark:text-white">
                    {issuedPassword}
                  </code>
                  <CopyButton value={issuedPassword} />
                </div>
                <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400">
                  Affiché une seule fois, conservé nulle part en clair. Les
                  sessions ouvertes du client ont été fermées.
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={() => void regeneratePassword()}
              disabled={busyId === "password"}
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {busyId === "password" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <KeyRound className="h-4 w-4" aria-hidden="true" />
              )}
              Réémettre le mot de passe
            </button>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              À utiliser quand le client a perdu son mot de passe. L&apos;ancien
              cesse immédiatement de fonctionner.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ─── Nouvel immeuble ────────────────────────────────────────

function AddBuildingForm({
  clientId,
  clientName,
  clientPhone,
  onDone,
  onCancel,
}: {
  clientId: string;
  clientName: string;
  clientPhone: string | null;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  // Le contact sur site est obligatoire côté API, et à l'ouverture d'un dossier
  // c'est le client lui-même. Le pré-remplir évite de faire retaper ce que
  // l'écran vient d'afficher, sans l'imposer : le champ reste modifiable.
  const [contactPerson, setContactPerson] = useState(clientName);
  const [contactPhone, setContactPhone] = useState(clientPhone ?? "");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [slaTier, setSlaTier] = useState("STANDARD");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setError("");

    let latitude: number | undefined;
    let longitude: number | undefined;
    if (lat.trim() !== "" || lng.trim() !== "") {
      const parsedLat = parseDecimalInput(lat, { allowNegative: true });
      const parsedLng = parseDecimalInput(lng, { allowNegative: true });
      if (
        parsedLat === null ||
        parsedLng === null ||
        parsedLat < -90 ||
        parsedLat > 90 ||
        parsedLng < -180 ||
        parsedLng > 180
      ) {
        setError(
          "Renseignez la latitude et la longitude ensemble, dans leurs bornes, ou laissez les deux vides."
        );
        return;
      }
      latitude = parsedLat;
      longitude = parsedLng;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/buildings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          address: address.trim(),
          city: city.trim(),
          contactPerson: contactPerson.trim(),
          ...(contactPhone.trim() ? { contactPhone: contactPhone.trim() } : {}),
          slaTier,
          ...(latitude !== undefined && longitude !== undefined
            ? { latitude, longitude }
            : {}),
          ownerId: clientId,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        const issues = payload?.details?.issues ?? [];
        if (Array.isArray(issues) && issues.length > 0) {
          throw new Error(
            issues.map((i: { message: string }) => i.message).join(" ")
          );
        }
        throw new Error(payload?.error ?? "La création de l'immeuble a échoué.");
      }
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "La création de l'immeuble a échoué.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold text-gray-900 dark:text-white">
          Nouvel immeuble
        </h3>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Fermer"
          className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="mt-4 space-y-4"
        noValidate
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="b-name" className={LABEL}>
              Nom de l&apos;immeuble
            </label>
            <input
              id="b-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              placeholder="Résidence Les Oliviers"
              className={FIELD}
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="b-address" className={LABEL}>
              Adresse du site
            </label>
            <input
              id="b-address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              required
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor="b-city" className={LABEL}>
              Ville
            </label>
            <input
              id="b-city"
              value={city}
              onChange={(event) => setCity(event.target.value)}
              required
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor="b-sla" className={LABEL}>
              Palier de service
            </label>
            <select
              id="b-sla"
              value={slaTier}
              onChange={(event) => setSlaTier(event.target.value)}
              className={FIELD}
            >
              {SLA_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {enumLabel(tier)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="b-contact" className={LABEL}>
              Contact sur site
            </label>
            <input
              id="b-contact"
              value={contactPerson}
              onChange={(event) => setContactPerson(event.target.value)}
              required
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor="b-phone" className={LABEL}>
              Téléphone du contact{" "}
              <span className="text-gray-400">(facultatif)</span>
            </label>
            <input
              id="b-phone"
              value={contactPhone}
              onChange={(event) => setContactPhone(event.target.value)}
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor="b-lat" className={LABEL}>
              Latitude <span className="text-gray-400">(facultatif)</span>
            </label>
            <input
              id="b-lat"
              value={lat}
              onChange={(event) => setLat(event.target.value)}
              inputMode="decimal"
              placeholder="36.7538"
              aria-describedby="b-coords-aide"
              className={FIELD_NUM}
            />
          </div>
          <div>
            <label htmlFor="b-lng" className={LABEL}>
              Longitude <span className="text-gray-400">(facultatif)</span>
            </label>
            <input
              id="b-lng"
              value={lng}
              onChange={(event) => setLng(event.target.value)}
              inputMode="decimal"
              placeholder="3.0588"
              aria-describedby="b-coords-aide"
              className={FIELD_NUM}
            />
          </div>
          <p
            id="b-coords-aide"
            className="text-xs text-gray-500 sm:col-span-2 dark:text-gray-400"
          >
            Les deux ensemble ou aucune. Elles servent au contrôle de distance
            lors du pointage d&apos;arrivée du technicien.
          </p>
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
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
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            Créer l&apos;immeuble
          </button>
        </div>
      </form>
    </Card>
  );
}

// ─── Rattacher un immeuble existant ─────────────────────────

function AttachBuildingPanel({
  clientId,
  clientName,
  buildings,
  truncated,
  query,
  onQueryChange,
  onDone,
  onCancel,
}: {
  clientId: string;
  clientName: string;
  buildings: AttachableRow[];
  truncated: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const attach = async (building: AttachableRow) => {
    setError("");

    /**
     * Déplacer un immeuble qui appartient déjà à quelqu'un d'autre se confirme.
     * Le rattachement d'un immeuble sans propriétaire, non : c'est l'acte normal
     * d'ouverture d'un dossier, et le faire confirmer apprendrait à valider sans
     * lire — ce qui est exactement ce qu'on ne veut pas le jour où il y a
     * vraiment quelque chose à lire.
     */
    if (
      building.owner &&
      !window.confirm(
        `« ${building.name} » appartient actuellement à ${building.owner.name}.\n\n` +
          `Le rattacher à ${clientName} ? ${building.owner.name} perdra l'accès à ce site.`
      )
    ) {
      return;
    }

    setBusyId(building.id);
    try {
      const res = await fetch(`/api/clients/${clientId}/buildings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buildingId: building.id }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.error ?? "Le rattachement a échoué.");
      }
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Le rattachement a échoué.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">
            Rattacher un immeuble existant
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Pour un site déjà en base — parc saisi avant l&apos;ouverture du
            compte, ou immeuble qui change de gestionnaire.
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Fermer"
          className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-4">
        <label htmlFor="attach-search" className="sr-only">
          Rechercher un immeuble
        </label>
        <input
          id="attach-search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Rechercher par nom, adresse ou ville…"
          className={FIELD}
        />
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
        >
          {error}
        </p>
      )}

      {buildings.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
          {query.trim()
            ? "Aucun immeuble ne correspond à cette recherche."
            : "Aucun autre immeuble disponible."}
        </p>
      ) : (
        <>
          <ul className="mt-4 divide-y divide-gray-100 dark:divide-gray-800">
            {buildings.map((building) => (
              <li
                key={building.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    {building.name}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {building.address}, {building.city} · {building.elevatorCount}{" "}
                    appareil{building.elevatorCount > 1 ? "s" : ""}
                  </p>
                  {building.owner && (
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                      Actuellement rattaché à {building.owner.name}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void attach(building)}
                  disabled={busyId === building.id}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  {busyId === building.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  Rattacher
                </button>
              </li>
            ))}
          </ul>
          {truncated && (
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              Seuls les cinquante premiers résultats sont affichés — affinez la
              recherche pour trouver un autre site.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

// ─── Nouvel ascenseur ───────────────────────────────────────

function AddElevatorForm({
  buildingId,
  buildingName,
  onDone,
  onCancel,
}: {
  buildingId: string;
  buildingName: string;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [elevatorCode, setElevatorCode] = useState("");
  const [brand, setBrand] = useState<string>(ELEVATOR_BRANDS[0]);
  const [model, setModel] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [motorType, setMotorType] = useState<string>(MOTOR_TYPES[0]);
  const [controllerType, setControllerType] = useState<string>(
    CONTROLLER_TYPES[0]
  );
  const [maxPayloadKg, setMaxPayloadKg] = useState("400");
  const [floorsServed, setFloorsServed] = useState("");
  const [installationDate, setInstallationDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setError("");

    const payload = parseDecimalInput(maxPayloadKg);
    if (payload === null || payload <= 0 || payload > 10000) {
      setError("La charge maximale doit être un nombre de kilos entre 1 et 10 000.");
      return;
    }
    const floors = parseDecimalInput(floorsServed);
    if (floors === null || floors < 1 || floors > 200 || !Number.isInteger(floors)) {
      setError("Le nombre de niveaux doit être un entier entre 1 et 200.");
      return;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(elevatorCode.trim())) {
      setError(
        "Le code de l'appareil ne peut contenir que des lettres, des chiffres, - et _."
      );
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/elevators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elevatorCode: elevatorCode.trim(),
          buildingId,
          brand,
          model: model.trim(),
          ...(serialNumber.trim() ? { serialNumber: serialNumber.trim() } : {}),
          // L'API attend une date ISO complète ; le champ `date` du navigateur
          // rend « 2024-05-12 », qui n'est pas un `datetime`.
          ...(installationDate
            ? {
                installationDate: new Date(
                  `${installationDate}T00:00:00.000Z`
                ).toISOString(),
              }
            : {}),
          motorType,
          maxPayloadKg: payload,
          controllerType,
          floorsServed: floors,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const issues = body?.details?.issues ?? [];
        if (Array.isArray(issues) && issues.length > 0) {
          throw new Error(
            issues.map((i: { message: string }) => i.message).join(" ")
          );
        }
        throw new Error(body?.error ?? "La création de l'appareil a échoué.");
      }
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "La création de l'appareil a échoué.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="mt-3 space-y-4 rounded-lg border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-900 dark:bg-blue-950/20"
      noValidate
    >
      <div className="flex items-start justify-between gap-3">
        <h5 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
          <Wrench className="h-4 w-4 text-gray-400" aria-hidden="true" />
          Nouvel appareil — {buildingName}
        </h5>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Fermer"
          className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      <p className="text-xs text-gray-600 dark:text-gray-300">
        Toutes les caractéristiques sont demandées : les seuils d&apos;alerte et
        la durée de vie des pièces se calculent dessus. Relevez-les sur la plaque
        constructeur.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="e-code" className={LABEL}>
            Code de l&apos;appareil
          </label>
          <input
            id="e-code"
            value={elevatorCode}
            onChange={(event) => setElevatorCode(event.target.value)}
            required
            placeholder="MPT-04"
            className={`${FIELD} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="e-serial" className={LABEL}>
            N° de série <span className="text-gray-400">(facultatif)</span>
          </label>
          <input
            id="e-serial"
            value={serialNumber}
            onChange={(event) => setSerialNumber(event.target.value)}
            className={FIELD}
          />
        </div>
        <div>
          <label htmlFor="e-brand" className={LABEL}>
            Marque
          </label>
          <select
            id="e-brand"
            value={brand}
            onChange={(event) => setBrand(event.target.value)}
            className={FIELD}
          >
            {ELEVATOR_BRANDS.map((value) => (
              <option key={value} value={value}>
                {enumLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="e-model" className={LABEL}>
            Modèle
          </label>
          <input
            id="e-model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            required
            className={FIELD}
          />
        </div>
        <div>
          <label htmlFor="e-motor" className={LABEL}>
            Type de moteur
          </label>
          <select
            id="e-motor"
            value={motorType}
            onChange={(event) => setMotorType(event.target.value)}
            className={FIELD}
          >
            {MOTOR_TYPES.map((value) => (
              <option key={value} value={value}>
                {enumLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="e-controller" className={LABEL}>
            Type de commande
          </label>
          <select
            id="e-controller"
            value={controllerType}
            onChange={(event) => setControllerType(event.target.value)}
            className={FIELD}
          >
            {CONTROLLER_TYPES.map((value) => (
              <option key={value} value={value}>
                {enumLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="e-payload" className={LABEL}>
            Charge maximale (kg)
          </label>
          <input
            id="e-payload"
            value={maxPayloadKg}
            onChange={(event) => setMaxPayloadKg(event.target.value)}
            inputMode="numeric"
            required
            className={FIELD_NUM}
          />
        </div>
        <div>
          <label htmlFor="e-floors" className={LABEL}>
            Niveaux desservis
          </label>
          <input
            id="e-floors"
            value={floorsServed}
            onChange={(event) => setFloorsServed(event.target.value)}
            inputMode="numeric"
            required
            className={FIELD_NUM}
          />
        </div>
        <div>
          <label htmlFor="e-installed" className={LABEL}>
            Mise en service{" "}
            <span className="text-gray-400">(facultatif)</span>
          </label>
          <input
            id="e-installed"
            type="date"
            value={installationDate}
            onChange={(event) => setInstallationDate(event.target.value)}
            className={FIELD}
          />
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
        >
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          Annuler
        </button>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          Enregistrer l&apos;appareil
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}
