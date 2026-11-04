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
import { useSession } from "next-auth/react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
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
import { SectionTabs, PARC_TABS } from "@/components/layout/section-tabs";
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
  /** La fiche d'état des lieux, étape 1 de l'audit. */
  installationDate: string | null;
  motorType: string;
  controllerType: string;
  maxPayloadKg: number;
  floorsServed: number;
  building: { id: string; name: string; city: string };
  workOrders: {
    id: string;
    orderNumber: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
    /** Le relevé de non-conformités, étape 2 de l'audit. */
    description: string | null;
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

/**
 * Les trois temps de l'audit de reprise.
 *
 * Nommés ici plutôt qu'écrits dans le rendu : l'indicateur d'étape, les titres
 * de section et le récapitulatif lisent la même liste, donc aucun des trois ne
 * peut annoncer un parcours que les autres ne décrivent pas.
 */
const AUDIT_STEPS = [
  { number: 1, label: "État des lieux" },
  { number: 2, label: "Non-conformités" },
  { number: 3, label: "Intégration au parc" },
] as const;

function formatDay(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return format(date, "d MMM yyyy", { locale: fr });
}

/**
 * Extraire le relevé de non-conformités de la description du bon.
 *
 * Le bon porte le texte de la visite puis, sous un intitulé, les remarques de
 * sécurité et les photos. L'écran d'audit montre ce relevé seul : réafficher la
 * consigne générale du bon à chaque ligne noierait la seule information qu'il
 * ajoute. L'intitulé est écrit au même endroit que le document qui le produit
 * (`POST /api/elevators`) ; s'il change là-bas, il change ici.
 */
function auditFindingsFrom(description: string | null | undefined): string | null {
  if (!description) return null;
  const marker = "Non-conformités et remarques de sécurité relevées :";
  const at = description.indexOf(marker);
  if (at === -1) return null;

  const rest = description.slice(at + marker.length).trim();
  const photosAt = rest.indexOf("Photos du relevé :");
  const findings = (photosAt === -1 ? rest : rest.slice(0, photosAt)).trim();
  return findings || null;
}

export default function TakeoverPage() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "ADMIN";
  const [rows, setRows] = useState<TakeoverRow[]>([]);
  const [buildings, setBuildings] = useState<BuildingOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Vrai quand le registre vient de la fixture (pas de PostgreSQL). */
  const [demoMode, setDemoMode] = useState(false);

  const [buildingId, setBuildingId] = useState("");
  const [elevatorCode, setElevatorCode] = useState("");
  const [originBrand, setOriginBrand] = useState("");
  const [model, setModel] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [installationDate, setInstallationDate] = useState("");
  const [motorType, setMotorType] = useState<string>(MOTOR_TYPES[0]);
  const [controllerType, setControllerType] = useState<string>(
    CONTROLLER_TYPES[0]
  );
  const [maxPayloadKg, setMaxPayloadKg] = useState("450");
  const [floorsServed, setFloorsServed] = useState("8");
  const [saving, setSaving] = useState(false);

  /**
   * L'audit se saisit en trois étapes, comme il se lit.
   *
   * `step` n'est pas décoratif : il sépare la fiche d'état des lieux du relevé
   * de non-conformités, deux documents que le bureau remplit à des moments
   * différents et qu'un formulaire unique aurait mélangés.
   */
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [auditNotes, setAuditNotes] = useState("");
  /** Une URL par champ ; les vides sont ignorées à l'envoi. */
  const [photoUrls, setPhotoUrls] = useState<string[]>([""]);

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
      setDemoMode(takeovers?.demo === true);

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
    setInstallationDate("");
    setMotorType(MOTOR_TYPES[0]);
    setControllerType(CONTROLLER_TYPES[0]);
    setMaxPayloadKg("450");
    setFloorsServed("8");
    setStep(1);
    setAuditNotes("");
    setPhotoUrls([""]);
  }

  /**
   * Franchir une étape, en refusant de passer avec une fiche incomplète.
   *
   * Le contrôle est ici et non dans le `required` du champ : à l'étape 3, les
   * champs de l'étape 1 ne sont plus montés, donc la validation native du
   * navigateur ne les verrait plus et enregistrerait un appareil sans
   * immeuble. Le message nomme ce qui manque plutôt que de laisser un bouton
   * qui ne répond pas.
   */
  function goNext() {
    if (step === 1) {
      const missing: string[] = [];
      if (!buildingId) missing.push("l'immeuble");
      if (!elevatorCode.trim()) missing.push("le code appareil");
      if (!originBrand.trim()) missing.push("la marque d'origine");
      if (!model.trim()) missing.push("le modèle");
      if (!Number.isFinite(Number(maxPayloadKg)) || Number(maxPayloadKg) <= 0) {
        missing.push("la charge maximale");
      }
      if (!Number.isFinite(Number(floorsServed)) || Number(floorsServed) <= 0) {
        missing.push("les niveaux desservis");
      }
      if (missing.length > 0) {
        setNotice(`Fiche incomplète : renseignez ${missing.join(", ")}.`);
        return;
      }
      setNotice("");
    }
    setStep((current) => (current < 3 ? ((current + 1) as 1 | 2 | 3) : current));
  }

  function goBack() {
    setNotice("");
    setStep((current) => (current > 1 ? ((current - 1) as 1 | 2 | 3) : current));
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
          // La vétusté se lit par la date de mise en service ; un champ
          // « ancienneté » en années serait une seconde mesure de la même
          // chose, et les deux finiraient par se contredire.
          installationDate: installationDate
            ? new Date(`${installationDate}T00:00:00`).toISOString()
            : undefined,
          motorType,
          controllerType,
          maxPayloadKg: Number(maxPayloadKg),
          floorsServed: Number(floorsServed),
          auditNotes: auditNotes.trim() || undefined,
          auditPhotoUrls: photoUrls
            .map((url) => url.trim())
            .filter((url) => url.length > 0),
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

      if (payload?.demo === true) {
        setNotice(
          `Audit enregistré en mode démonstration. Bon d'inspection ${
            payload.auditWorkOrder?.orderNumber ?? "simulé"
          } — aucun appareil n'a été écrit en base.`
        );
      } else {
        setNotice(
          payload?.auditWorkOrder
            ? `Audit enregistré. Bon d'inspection ${payload.auditWorkOrder.orderNumber} créé.`
            : "Audit enregistré. Le bon d'inspection n'a pas pu être créé : " +
                "à ouvrir depuis le tableau des interventions."
        );
      }
      resetForm();
      setFormOpen(false);
      // En démonstration, recharger ramènerait la fixture intacte : le
      // message d'acquittement suffit, et la ligne créée n'existe pas.
      if (payload?.demo !== true) await load();
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : "L'enregistrement a échoué."
      );
    } finally {
      setSaving(false);
    }
  }

  async function validate(row: TakeoverRow, options?: { force?: boolean }) {
    setBusyId(row.id);
    setNotice("");
    try {
      const response = await fetch(`/api/elevators/${row.id}/takeover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: options?.force === true }),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : payload?.error?.message;
        throw new Error(message ?? `La validation a échoué (${response.status}).`);
      }

      const closed: string[] = Array.isArray(payload?.closedWorkOrders)
        ? payload.closedWorkOrders
        : [];
      setNotice(
        payload?.demo === true
          ? `Validation simulée en mode démonstration : matricule ${payload.data.rmascCode} attribué fictivement, rien n'est enregistré en base.`
          : options?.force
            ? `Intégration forcée : matricule ${payload.data.rmascCode} attribué${
                closed.length > 0
                  ? `, bon${closed.length > 1 ? "s" : ""} ${closed.join(", ")} clôturé${closed.length > 1 ? "s" : ""} automatiquement`
                  : ""
              }.`
            : `Matricule ${payload.data.rmascCode} attribué. Le QR est prêt à imprimer.`
      );
      if (payload?.demo !== true) await load();
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
      <SectionTabs tabs={PARC_TABS} ariaLabel="Parc ascenseurs" />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            Audit de Reprise &amp; Prise en Contrat
          </h2>
          <p className="mt-1 max-w-3xl text-gray-500">
            Un appareil tiers n&apos;entre au parc qu&apos;en trois temps :
            fiche d&apos;état des lieux, relevé des non-conformités, puis
            validation d&apos;intégration — qui attribue le matricule RMASC et
            son QR.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setFormOpen((open) => !open);
              setStep(1);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            {formOpen ? (
              <X className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Plus className="h-4 w-4" aria-hidden="true" />
            )}
            {formOpen ? "Fermer" : "Ouvrir un audit"}
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

      {demoMode && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          Mode démonstration : les trois audits d&apos;exemple sont affichés.
          Le formulaire est utilisable, mais rien n&apos;est enregistré en base.
        </p>
      )}

      {formOpen && (
        <Card className="p-5">
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">
            Nouvel audit de reprise
          </h3>
          <p className="mt-1 text-xs text-gray-500">
            Fiche d&apos;état des lieux, relevé des non-conformités, puis
            récapitulatif. Le bon d&apos;inspection est créé à
            l&apos;enregistrement, pas à la validation.
          </p>

          <ol
            className="mt-4 flex flex-wrap items-center gap-2"
            aria-label="Étapes de l'audit"
          >
            {AUDIT_STEPS.map((item) => {
              const active = step === item.number;
              const done = step > item.number;
              return (
                <li key={item.number} className="flex items-center gap-2">
                  <span
                    className={`flex h-6 w-6 flex-none items-center justify-center rounded-full text-[11px] font-bold ${
                      done
                        ? "bg-emerald-600 text-white"
                        : active
                          ? "bg-blue-600 text-white"
                          : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                    }`}
                    aria-current={active ? "step" : undefined}
                  >
                    {done ? "✓" : item.number}
                  </span>
                  <span
                    className={`text-xs font-semibold ${
                      active
                        ? "text-gray-900 dark:text-white"
                        : "text-gray-500 dark:text-gray-400"
                    }`}
                  >
                    {item.label}
                  </span>
                  {item.number < AUDIT_STEPS.length && (
                    <span
                      className="mx-1 h-px w-6 bg-gray-200 dark:bg-gray-700"
                      aria-hidden="true"
                    />
                  )}
                </li>
              );
            })}
          </ol>

          <form onSubmit={submit} className="mt-4">
            {step === 1 && (
              <div className="grid gap-4 sm:grid-cols-2">
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
                Date de mise en service (vétusté)
              </span>
              <input
                type="date"
                value={installationDate}
                onChange={(event) => setInstallationDate(event.target.value)}
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

              </div>
            )}

            {step === 2 && (
              <div className="space-y-4">
                <div>
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
                    Relevé des non-conformités
                  </h4>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    Remarques de sécurité et photos prises à l&apos;état des
                    lieux. Elles sont consignées dans le bon d&apos;inspection,
                    sous les yeux du technicien qui monte sur site.
                  </p>
                </div>

                <label className="block">
                  <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                    Remarques sécurité / non-conformités
                  </span>
                  <textarea
                    rows={4}
                    maxLength={2000}
                    value={auditNotes}
                    onChange={(event) => setAuditNotes(event.target.value)}
                    placeholder="Éclairage de machinerie défaillant, panneau de secours hors service, gaine à compléter…"
                    className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                  />
                  <span className="mt-1 block text-[11px] text-gray-400">
                    {auditNotes.length} / 2000 caractères
                  </span>
                </label>

                <div>
                  <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                    Photos du relevé (URL)
                  </span>
                  <div className="mt-1 space-y-2">
                    {photoUrls.map((url, index) => (
                      <div key={index} className="flex gap-2">
                        <input
                          type="url"
                          value={url}
                          onChange={(event) =>
                            setPhotoUrls((previous) =>
                              previous.map((current, position) =>
                                position === index ? event.target.value : current
                              )
                            )
                          }
                          placeholder="https://…"
                          className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setPhotoUrls((previous) =>
                              previous.length === 1
                                ? [""]
                                : previous.filter((_, position) => position !== index)
                            )
                          }
                          aria-label={`Retirer la photo ${index + 1}`}
                          className="rounded-lg border border-gray-200 px-2.5 text-sm text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setPhotoUrls((previous) => [...previous, ""])}
                    disabled={photoUrls.length >= 8}
                    className="mt-2 inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    <Camera className="h-3.5 w-3.5" aria-hidden="true" />
                    Ajouter une photo
                  </button>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-4">
                <div>
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
                    Récapitulatif de l&apos;audit
                  </h4>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    Vérifiez la fiche avant de l&apos;enregistrer. Le bon
                    d&apos;inspection est ouvert immédiatement ; la validation
                    viendra après la visite.
                  </p>
                </div>

                <dl className="grid gap-x-6 gap-y-2 rounded-xl border border-gray-200 p-3 text-sm sm:grid-cols-2 dark:border-gray-800">
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-gray-400">
                      Appareil
                    </dt>
                    <dd className="font-mono font-semibold text-gray-900 dark:text-white">
                      {elevatorCode || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-gray-400">
                      Immeuble
                    </dt>
                    <dd className="text-gray-900 dark:text-white">
                      {sortedBuildings.find((b) => b.id === buildingId)?.name ??
                        "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-gray-400">
                      Marque et modèle
                    </dt>
                    <dd className="text-gray-900 dark:text-white">
                      {originBrand || "—"} · {model || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-gray-400">
                      Mise en service
                    </dt>
                    <dd className="text-gray-900 dark:text-white">
                      {installationDate
                        ? formatDay(
                            new Date(`${installationDate}T00:00:00`).toISOString()
                          )
                        : "Non renseignée"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-gray-400">
                      Armoire de commande
                    </dt>
                    <dd className="text-gray-900 dark:text-white">
                      {enumLabel(controllerType)} · {enumLabel(motorType)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-gray-400">
                      Charge / niveaux
                    </dt>
                    <dd className="text-gray-900 dark:text-white">
                      {maxPayloadKg || "—"} kg · {floorsServed || "—"} niveaux
                    </dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-[11px] uppercase tracking-wide text-gray-400">
                      Non-conformités
                    </dt>
                    <dd className="whitespace-pre-line text-gray-900 dark:text-white">
                      {auditNotes.trim() || "Aucune remarque saisie."}
                    </dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-[11px] uppercase tracking-wide text-gray-400">
                      Photos
                    </dt>
                    <dd className="text-gray-900 dark:text-white">
                      {photoUrls.filter((url) => url.trim()).length || "Aucune"}
                    </dd>
                  </div>
                </dl>

                <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
                  À l&apos;enregistrement, un bon d&apos;inspection d&apos;état
                  des lieux est ouvert et affectable. Le matricule RMASC et son
                  QR ne sont attribués qu&apos;à la validation, une fois la
                  visite terminée.
                </p>
              </div>
            )}

            <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 pt-4 dark:border-gray-800">
              <div>
                {step > 1 && (
                  <button
                    type="button"
                    onClick={goBack}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    Précédent
                  </button>
                )}
              </div>

              <div className="flex items-center gap-3">
                <span className="text-[11px] text-gray-400">
                  Étape {step} sur {AUDIT_STEPS.length}
                </span>
                {step < 3 ? (
                  <button
                    type="button"
                    onClick={goNext}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
                  >
                    Suivant
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : (
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
                    Enregistrer l&apos;audit
                  </button>
                )}
              </div>
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
          icon={ShieldCheck}
          title="Aucun audit de reprise"
          description="Un appareil tiers n'entre au parc qu'après un audit : fiche d'état des lieux, relevé des non-conformités, puis validation d'intégration. Ouvrez un audit pour commencer."
          action={{
            label: "Ouvrir un audit",
            onClick: () => setFormOpen(true),
          }}
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
                      ) : openAudit ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                          En attente d&apos;audit
                        </span>
                      ) : lastAudit ? (
                        <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-bold text-sky-800 dark:bg-sky-950 dark:text-sky-300">
                          Inspecté — à valider
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

                    {/*
                      Les trois temps de l'audit, dans l'ordre où ils se
                      franchissent. La ligne indique ce qui est fait, ce qui
                      reste à relever et ce qui bloque l'intégration — c'est la
                      seule décision que cette carte demande.
                    */}
                    <ol className="mt-3 space-y-2.5 border-l border-gray-200 pl-3 dark:border-gray-800">
                      <li>
                        <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 dark:text-gray-200">
                          <span className="flex h-4 w-4 flex-none items-center justify-center rounded-full bg-emerald-600 text-[9px] font-bold text-white">
                            ✓
                          </span>
                          1. État des lieux
                        </p>
                        <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                          {row.originBrand ?? "—"} {row.model} · mise en service{" "}
                          {formatDay(row.installationDate)} · armoire{" "}
                          {enumLabel(row.controllerType)} · {row.maxPayloadKg} kg
                          · {row.floorsServed} niveaux
                        </p>
                      </li>

                      <li>
                        <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 dark:text-gray-200">
                          <span
                            className={`flex h-4 w-4 flex-none items-center justify-center rounded-full text-[9px] font-bold ${
                              lastAudit
                                ? "bg-emerald-600 text-white"
                                : "bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-300"
                            }`}
                          >
                            {lastAudit ? "✓" : "2"}
                          </span>
                          2. Relevé des non-conformités
                        </p>
                        <p className="mt-0.5 whitespace-pre-line text-[11px] text-gray-500 dark:text-gray-400">
                          {lastAudit
                            ? (auditFindingsFrom(lastAudit.description) ??
                              "Aucune non-conformité consignée.")
                            : "En attente de la visite d'état des lieux."}
                        </p>
                      </li>

                      <li>
                        <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 dark:text-gray-200">
                          <span
                            className={`flex h-4 w-4 flex-none items-center justify-center rounded-full text-[9px] font-bold ${
                              row.rmascCode
                                ? "bg-emerald-600 text-white"
                                : "bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-300"
                            }`}
                          >
                            {row.rmascCode ? "✓" : "3"}
                          </span>
                          3. Intégration au parc
                        </p>
                        <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                          {row.rmascCode
                            ? `Matricule ${row.rmascCode} attribué — QR prêt à imprimer.`
                            : openAudit
                              ? `Validation possible une fois le bon ${openAudit.orderNumber} terminé.`
                              : lastAudit
                                ? `Bon ${lastAudit.orderNumber} — ${enumLabel(
                                    lastAudit.status
                                  )}${
                                    lastAudit.completedAt
                                      ? ` le ${formatDay(lastAudit.completedAt)}`
                                      : ""
                                  }, prêt à valider.`
                                : "Aucun bon d'inspection rattaché."}
                        </p>
                      </li>
                    </ol>
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
                          Valider pour intégration au parc
                        </button>
                        {openAudit && (
                          <p className="max-w-[220px] text-right text-[11px] text-gray-400">
                            Validation possible une fois le bon{" "}
                            {openAudit.orderNumber} terminé.
                          </p>
                        )}
                        {isAdmin && (
                          <>
                            <button
                              type="button"
                              disabled={busyId === row.id}
                              onClick={() => {
                                if (
                                  !window.confirm(
                                    "Forcer l'intégration au parc ? Le bon d'audit ouvert sera clôturé automatiquement et un matricule sera attribué sans attendre la visite."
                                  )
                                ) {
                                  return;
                                }
                                void validate(row, { force: true });
                              }}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
                            >
                              <ShieldCheck
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                              Forcer l&apos;intégration au parc (Mode Admin)
                            </button>
                            <p className="max-w-[240px] text-right text-[11px] text-red-700/80 dark:text-red-300/80">
                              Contourne l&apos;audit et clôture automatiquement
                              le bon WO-AUD sous-jacent.
                            </p>
                          </>
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
