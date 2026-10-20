"use client";

/**
 * La reprise d'un appareil tiers, côté bureau.
 *
 * POURQUOI CET ÉCRAN EST À PART DU PARC
 * Un ascenseur Otis dont le contrat vient d'être repris n'est pas encore un
 * appareil RMASC : il est une fiche à visiter. L'enregistrer directement dans
 * le parc reviendrait à déclarer siennes des caractéristiques que personne n'a
 * vérifiées, et à lui attribuer un matricule avant même qu'un technicien n'ait
 * ouvert l'armoire.
 *
 * TROIS ÉTATS, DANS L'ORDRE
 *  1. La reprise est enregistrée, avec sa marque d'origine — celle du
 *     constructeur, pas notre énumération. Un bon d'inspection d'état des lieux
 *     est créé automatiquement, ouvert, pour que le bureau l'affecte.
 *  2. Le technicien visite et clôt le bon.
 *  3. Le bureau valide : le matricule `ASC-AAAA-NNNN` est attribué et son QR
 *     est généré. C'est ce QR qui se colle sur la machine et ouvre la page
 *     publique de demande d'accès.
 *
 * La validation refuse tant qu'un bon d'inspection est ouvert, et le dit.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import {
  Loader2,
  Plus,
  QrCode,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { enumLabel } from "@/lib/ui/enum-labels";
import { CONTROLLER_TYPES, MOTOR_TYPES } from "@/types";

interface TakeoverRow {
  id: string;
  elevatorCode: string;
  brand: string;
  originBrand: string | null;
  model: string;
  serialNumber: string | null;
  rmascCode: string | null;
  status: string;
  createdAt: string;
  building: { id: string; name: string; city: string };
  workOrders: {
    id: string;
    orderNumber: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
  }[];
}

interface BuildingOption {
  id: string;
  name: string;
  city: string;
}

/**
 * Les constructeurs que le bureau rencontre, proposés sans être imposés.
 *
 * Une liste fermée serait fausse : il existe des constructeurs locaux, et un
 * appareil dont la marque n'y figure pas doit pouvoir être enregistré. Le champ
 * reste du texte libre, avec ces noms en suggestion.
 */
const KNOWN_BRANDS = [
  "Otis",
  "KONE",
  "Schindler",
  "ThyssenKrupp",
  "Mitsubishi",
  "Hitachi",
  "Express",
  "Fujitec",
];

/** Ce que ces suggestions valent dans l'énumération fermée `ElevatorBrand`. */
const BRAND_ENUM: Record<string, string> = {
  otis: "OTIS",
  kone: "KONE",
  schindler: "SCHINDLER",
  thyssenkrupp: "THYSSENKRUPP",
  mitsubishi: "MITSUBISHI",
  hitachi: "HITACHI",
};

/** Un bon d'inspection encore ouvert : la validation est bloquée par lui. */
const OPEN_STATUSES = new Set(["OPEN", "ASSIGNED", "IN_PROGRESS", "ON_HOLD"]);

function formatDay(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return format(date, "d MMM yyyy", { locale: fr });
}

export default function TakeoverPage() {
  const [rows, setRows] = useState<TakeoverRow[]>([]);
  const [buildings, setBuildings] = useState<BuildingOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [buildingId, setBuildingId] = useState("");
  const [elevatorCode, setElevatorCode] = useState("");
  const [originBrand, setOriginBrand] = useState("");
  const [model, setModel] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [motorType, setMotorType] = useState<string>(MOTOR_TYPES[0]);
  const [controllerType, setControllerType] = useState<string>(
    CONTROLLER_TYPES[0]
  );
  const [maxPayloadKg, setMaxPayloadKg] = useState("450");
  const [floorsServed, setFloorsServed] = useState("8");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [takeoversResponse, buildingsResponse] = await Promise.all([
        fetch("/api/elevators/takeovers"),
        fetch("/api/buildings"),
      ]);
      if (!takeoversResponse.ok) {
        throw new Error(`Le registre a répondu ${takeoversResponse.status}.`);
      }
      const takeovers = await takeoversResponse.json();
      setRows(Array.isArray(takeovers?.data) ? takeovers.data : []);

      if (buildingsResponse.ok) {
        const payload = await buildingsResponse.json();
        setBuildings(Array.isArray(payload?.data) ? payload.data : []);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Impossible de charger les reprises d'appareils."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function resetForm() {
    setBuildingId("");
    setElevatorCode("");
    setOriginBrand("");
    setModel("");
    setSerialNumber("");
    setMotorType(MOTOR_TYPES[0]);
    setControllerType(CONTROLLER_TYPES[0]);
    setMaxPayloadKg("450");
    setFloorsServed("8");
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setNotice("");

    try {
      const normalized = originBrand.trim().toLowerCase().replace(/[\s-]/g, "");
      const brand = BRAND_ENUM[normalized] ?? "OTHER";

      const response = await fetch("/api/elevators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elevatorCode: elevatorCode.trim(),
          buildingId,
          brand,
          originBrand: originBrand.trim(),
          takeover: true,
          model: model.trim(),
          serialNumber: serialNumber.trim() || undefined,
          motorType,
          controllerType,
          maxPayloadKg: Number(maxPayloadKg),
          floorsServed: Number(floorsServed),
        }),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : payload?.error?.message;
        const issue = payload?.details?.issues?.[0]?.message;
        // Le détail de Zod d'abord : « Données invalides » ne dit pas quel champ
        // corriger, et le champ est la seule chose que l'administrateur puisse
        // réparer dans ce formulaire.
        throw new Error(
          issue ?? message ?? `L'enregistrement a échoué (${response.status}).`
        );
      }

      setNotice(
        payload?.auditWorkOrder
          ? `Reprise enregistrée. Bon d'inspection ${payload.auditWorkOrder.orderNumber} créé.`
          : "Reprise enregistrée. Le bon d'inspection n'a pas pu être créé : " +
              "à ouvrir depuis le tableau des bons de travail."
      );
      resetForm();
      setFormOpen(false);
      await load();
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : "L'enregistrement a échoué."
      );
    } finally {
      setSaving(false);
    }
  }

  async function validate(row: TakeoverRow) {
    setBusyId(row.id);
    setNotice("");
    try {
      const response = await fetch(`/api/elevators/${row.id}/takeover`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : payload?.error?.message;
        throw new Error(message ?? `La validation a échoué (${response.status}).`);
      }

      setNotice(
        `Matricule ${payload.data.rmascCode} attribué. Le QR est prêt à imprimer.`
      );
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "La validation a échoué.");
    } finally {
      setBusyId(null);
    }
  }

  const sortedBuildings = useMemo(
    () =>
      [...buildings].sort((a, b) => a.name.localeCompare(b.name, "fr")),
    [buildings]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            Reprises d&apos;appareils tiers
          </h2>
          <p className="mt-1 text-gray-500">
            Un appareil repris garde sa marque d&apos;origine, reçoit un bon
            d&apos;inspection d&apos;état des lieux, puis — une fois la visite
            faite — un matricule RMASC et son QR.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setFormOpen((open) => !open)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            {formOpen ? (
              <X className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Plus className="h-4 w-4" aria-hidden="true" />
            )}
            {formOpen ? "Fermer" : "Enregistrer une reprise"}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Actualiser
          </button>
        </div>
      </div>

      {notice && (
        <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
          {notice}
        </p>
      )}

      {formOpen && (
        <Card className="p-5">
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">
            Nouvelle reprise
          </h3>
          <p className="mt-1 text-xs text-gray-500">
            La marque d&apos;origine est celle du constructeur — « Otis »,
            « KONE », ou le nom local. Le référentiel interne est rempli
            automatiquement quand elle y figure.
          </p>

          <form onSubmit={submit} className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Immeuble
              </span>
              <select
                required
                value={buildingId}
                onChange={(event) => setBuildingId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-white"
              >
                <option value="">Choisir un immeuble…</option>
                {sortedBuildings.map((building) => (
                  <option key={building.id} value={building.id}>
                    {building.name} — {building.city}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Code appareil
              </span>
              <input
                required
                maxLength={50}
                pattern="[A-Za-z0-9_-]+"
                value={elevatorCode}
                onChange={(event) => setElevatorCode(event.target.value)}
                placeholder="EXT-OTIS-01"
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-white"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Marque d&apos;origine
              </span>
              <input
                required
                list="origin-brands"
                maxLength={80}
                value={originBrand}
                onChange={(event) => setOriginBrand(event.target.value)}
                placeholder="Otis"
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-white"
              />
              <datalist id="origin-brands">
                {KNOWN_BRANDS.map((brand) => (
                  <option key={brand} value={brand} />
                ))}
              </datalist>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Modèle
              </span>
              <input
                required
                maxLength={100}
                value={model}
                onChange={(event) => setModel(event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-white"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                N° de série
              </span>
              <input
                maxLength={100}
                value={serialNumber}
                onChange={(event) => setSerialNumber(event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-white"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Type de moteur
              </span>
              <select
                value={motorType}
                onChange={(event) => setMotorType(event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-white"
              >
                {MOTOR_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {enumLabel(type)}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Type de contrôleur
              </span>
              <select
                value={controllerType}
                onChange={(event) => setControllerType(event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-white"
              >
                {CONTROLLER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {enumLabel(type)}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Charge maximale (kg)
              </span>
              <input
                required
                type="number"
                min={1}
                max={10000}
                value={maxPayloadKg}
                onChange={(event) => setMaxPayloadKg(event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-white"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Niveaux desservis
              </span>
              <input
                required
                type="number"
                min={1}
                max={200}
                value={floorsServed}
                onChange={(event) => setFloorsServed(event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-white"
              />
            </label>

            <div className="sm:col-span-2">
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                )}
                Enregistrer et générer le bon d&apos;audit
              </button>
            </div>
          </form>
        </Card>
      )}

      {loading ? (
        <LoadingSkeleton rows={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Aucune reprise enregistrée"
          hint="Enregistrez un appareil tiers pour ouvrir son bon d'inspection d'état des lieux."
        />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const openAudit = row.workOrders.find((order) =>
              OPEN_STATUSES.has(order.status)
            );
            const lastAudit = row.workOrders[0];

            return (
              <Card key={row.id} className="p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-mono text-sm font-semibold text-gray-900 dark:text-white">
                        {row.rmascCode ?? row.elevatorCode}
                      </p>
                      {row.rmascCode ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                          Repris
                        </span>
                      ) : (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                          En attente d&apos;audit
                        </span>
                      )}
                    </div>

                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                      {row.originBrand} {row.model}
                      {row.serialNumber && ` · n° ${row.serialNumber}`}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                      {row.building.name}, {row.building.city} · enregistré le{" "}
                      {formatDay(row.createdAt)}
                    </p>

                    <p className="mt-2 text-xs text-gray-500">
                      {lastAudit ? (
                        <>
                          Bon d&apos;inspection{" "}
                          <span className="font-mono">
                            {lastAudit.orderNumber}
                          </span>{" "}
                          — {enumLabel(lastAudit.status)}
                          {lastAudit.completedAt &&
                            ` le ${formatDay(lastAudit.completedAt)}`}
                        </>
                      ) : (
                        "Aucun bon d'inspection rattaché."
                      )}
                    </p>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-2">
                    {row.rmascCode ? (
                      <div className="flex items-center gap-3 rounded-xl border border-gray-200 p-2 dark:border-gray-800">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/elevators/${row.id}/qr`}
                          alt={`QR de l'appareil ${row.rmascCode}`}
                          width={96}
                          height={96}
                          className="h-24 w-24"
                        />
                        <div className="text-xs text-gray-500">
                          <p className="flex items-center gap-1 font-medium text-gray-700 dark:text-gray-300">
                            <QrCode className="h-3.5 w-3.5" aria-hidden="true" />
                            QR de l&apos;appareil
                          </p>
                          <p className="mt-1">
                            À coller sur la machine : il ouvre la page
                            d&apos;accès client.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={busyId === row.id || Boolean(openAudit)}
                          onClick={() => void validate(row)}
                          title={
                            openAudit
                              ? `Le bon ${openAudit.orderNumber} doit être terminé.`
                              : undefined
                          }
                          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {busyId === row.id ? (
                            <Loader2
                              className="h-3.5 w-3.5 animate-spin"
                              aria-hidden="true"
                            />
                          ) : (
                            <ShieldCheck
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />
                          )}
                          Valider la reprise
                        </button>
                        {openAudit && (
                          <p className="max-w-[220px] text-right text-[11px] text-gray-400">
                            Validation possible une fois le bon{" "}
                            {openAudit.orderNumber} terminé.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
