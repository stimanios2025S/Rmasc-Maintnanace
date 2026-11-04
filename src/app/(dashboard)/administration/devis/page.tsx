"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { FileText, Loader2, Plus, RefreshCw, Search, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { enumLabel } from "@/lib/ui/enum-labels";
import { computeQuoteTotals, formatDa, parseAmountInput } from "@/lib/quotes/totals";
import { QUOTE_STATUSES } from "@/types";
import type { QuoteStatus } from "@/types";

/**
 * Le registre des devis.
 *
 * CE QU'IL AJOUTE
 * Le module devis savait ouvrir une demande, la chiffrer et imprimer l'offre,
 * et **aucun écran ne l'appelait** : `/api/quotes` n'avait pas un seul
 * consommateur. Un devis ne se lisait donc qu'en connaissant son adresse.
 *
 * CE QU'IL MONTRE EN PREMIER
 * Ce qui n'est pas fait. Le tableau s'ouvre sur toutes les offres, triées par
 * date — mais l'état est la première colonne, et les deux états qui attendent
 * une action sont les seuls à porter une couleur franche : « à chiffrer »
 * attend le bureau, « envoyé » attend le client. Les trois autres sont des
 * issues, et une issue n'appelle rien.
 *
 * LE REGISTRE N'EST PAS UNE FILE DE TRAVAIL
 * Il n'acquitte rien, ne relance personne et ne décide rien. Les décisions se
 * prennent sur la fiche d'un devis, où l'on voit ce qui a été demandé — décider
 * d'un prix depuis une ligne de tableau, sans les lignes sous les yeux, est
 * exactement ce qu'un chiffrage ne doit pas permettre.
 */

interface QuoteRow {
  id: string;
  number: string;
  status: QuoteStatus;
  createdAt: string;
  sentAt: string | null;
  decidedAt: string | null;
  need: string;
  client: { id: string; name: string } | null;
  building: { id: string; name: string; city: string };
  elevator: { id: string; elevatorCode: string } | null;
  totals: { totalHt: number; vatAmount: number; totalTtc: number };
  lineCount: number;
}

/** Un immeuble proposé au formulaire de création. */
interface BuildingOption {
  id: string;
  name: string;
  city: string;
  /** Le titulaire du site : c'est lui qui recevra le devis. */
  owner: { id: string; name: string } | null;
}

/** Un appareil du parc, filtré sur l'immeuble choisi. */
interface UnitOption {
  id: string;
  elevatorCode: string;
}

/**
 * Le formulaire de création, vide.
 *
 * Déclaré hors du composant : le remettre à zéro après un envoi réussi est le
 * même objet, et une réinitialisation champ par champ finit toujours par en
 * oublier un.
 */
const EMPTY_QUOTE_FORM = {
  buildingId: "",
  elevatorId: "",
  need: "",
  validityDays: "30",
  designation: "",
  quantity: "1",
  unitPrice: "",
  sendNow: true,
};

/** Le style des champs du formulaire, une fois pour toutes. */
const INPUT_CLASS =
  "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:disabled:bg-gray-800";

/**
 * Les onglets de filtrage, dans l'ordre du travail.
 *
 * « Tous » d'abord parce qu'un registre s'ouvre sur l'ensemble ; puis les deux
 * états qui attendent quelqu'un, dans l'ordre où ils se produisent ; puis les
 * issues. Le même ordre que le poids de tri du module d'état, pour qu'un devis
 * ne change pas de place selon l'écran.
 */
const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: "", label: "Tous" },
  { key: "REQUESTED", label: "À chiffrer" },
  { key: "SENT", label: "Chez le client" },
  { key: "ACCEPTED", label: "Acceptés" },
  { key: "REFUSED", label: "Refusés" },
  { key: "CANCELLED", label: "Annulés" },
];

/**
 * Les teintes d'état.
 *
 * L'ambre et le bleu disent qu'il manque une action ; le vert, le gris et le
 * rouge pâle sont des issues. C'est la seule couleur du tableau qui porte une
 * information — voir l'en-tête.
 */
const STATUS_BADGE: Record<QuoteStatus, string> = {
  REQUESTED:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  SENT: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  ACCEPTED:
    "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  REFUSED: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
  CANCELLED: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
};

/** Le délai avant qu'une frappe ne déclenche la requête. Même valeur qu'ailleurs. */
const SEARCH_DEBOUNCE_MS = 300;

export default function DevisRegisterPage() {
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");

  const [rows, setRows] = useState<QuoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  /** Le formulaire de création : ouvert, en cours d'envoi, ou en erreur. */
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_QUOTE_FORM);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [buildings, setBuildings] = useState<BuildingOption[]>([]);
  const [units, setUnits] = useState<UnitOption[]>([]);

  useEffect(() => {
    const id = setTimeout(() => setTerm(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search]);

  const params = useMemo(() => {
    const search = new URLSearchParams();
    if (status) search.set("status", status);
    if (term) search.set("q", term);
    return search;
  }, [status, term]);

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!silent) setLoading(true);
      setError("");
      try {
        const res = await fetch(`/api/quotes?${params.toString()}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          throw new Error(`L'API des devis a répondu ${res.status}`);
        }
        const json = await res.json();
        setRows(Array.isArray(json.data) ? json.data : []);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Échec du chargement des devis"
        );
      } finally {
        setLoading(false);
      }
    },
    [params]
  );

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Le chiffrage du formulaire, réduit à une ligne.
   *
   * Les montants se lisent avec `parseAmountInput` — virgule décimale et
   * espaces de milliers — et non avec `Number()`, qui rendrait `NaN` sur
   * « 12 500 ».
   */
  const draftQuantity = parseAmountInput(form.quantity) ?? 0;
  const draftPrice = parseAmountInput(form.unitPrice) ?? 0;
  const hasLine =
    form.designation.trim().length > 0 && draftQuantity > 0 && draftPrice > 0;
  const draftTotals = computeQuoteTotals(
    hasLine ? [{ quantity: draftQuantity, unitPrice: draftPrice }] : []
  );

  /**
   * Le titulaire du site choisi : le serveur adresse le devis à lui, pas au
   * compte qui le saisit. L'afficher évite de découvrir après coup qu'une offre
   * a été créée sur un immeuble sans propriétaire — donc visible nulle part.
   */
  const selectedBuilding =
    buildings.find((building) => building.id === form.buildingId) ?? null;

  // Le parc ne se charge qu'à l'ouverture du formulaire : une liste complète
  // d'immeubles et d'appareils sur un écran de registre serait du poids pour un
  // formulaire que la plupart des visites n'ouvrent pas.
  useEffect(() => {
    if (!formOpen || buildings.length > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/buildings");
        if (!res.ok) {
          throw new Error(`L'API des immeubles a répondu ${res.status}`);
        }
        const json = await res.json();
        if (cancelled) return;
        const list = Array.isArray(json?.data) ? json.data : [];
        setBuildings(
          list.map((b: BuildingOption) => ({
            id: b.id,
            name: b.name,
            city: b.city,
            owner: b.owner ?? null,
          }))
        );
      } catch (e) {
        if (!cancelled) {
          setFormError(
            e instanceof Error ? e.message : "Immeubles indisponibles."
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [formOpen, buildings.length]);

  useEffect(() => {
    if (!form.buildingId) {
      setUnits([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/elevators");
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        const list = Array.isArray(json?.data) ? json.data : [];
        setUnits(
          list
            .filter(
              (unit: { building?: { id: string } }) =>
                unit.building?.id === form.buildingId
            )
            .map((unit: { id: string; elevatorCode: string }) => ({
              id: unit.id,
              elevatorCode: unit.elevatorCode,
            }))
        );
      } catch {
        if (!cancelled) setUnits([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [form.buildingId]);

  /**
   * Crée le devis, avec sa ligne et, si demandé, sa remise au client.
   *
   * Une seule requête : la route écrit l'en-tête, les lignes et le statut dans
   * le même `create`, donc un devis « envoyé » ne peut pas exister un instant
   * sans son prix, ni l'inverse.
   */
  async function submitQuote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    setNotice("");

    if (!form.buildingId) {
      setFormError("Choisissez l'immeuble concerné.");
      return;
    }
    if (form.need.trim().length < 10) {
      setFormError(
        "Décrivez l'objet du devis en quelques mots (10 caractères minimum)."
      );
      return;
    }
    if (form.sendNow && !hasLine) {
      setFormError(
        "Une offre envoyée doit porter une ligne chiffrée : désignation, quantité et prix unitaire."
      );
      return;
    }
    if (!form.sendNow && form.designation.trim() && !hasLine) {
      setFormError(
        "Complétez la ligne : quantité et prix unitaire strictement positifs."
      );
      return;
    }

    setSaving(true);
    try {
      const payload = {
        buildingId: form.buildingId,
        ...(form.elevatorId ? { elevatorId: form.elevatorId } : {}),
        need: form.need.trim(),
        validityDays: Number(form.validityDays) || 30,
        ...(hasLine
          ? {
              lines: [
                {
                  designation: form.designation.trim(),
                  quantity: draftQuantity,
                  unitPrice: draftPrice,
                },
              ],
            }
          : {}),
        ...(form.sendNow ? { status: "SENT" } : {}),
      };

      const res = await fetch("/api/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          json?.error ?? `La création a été refusée (${res.status}).`
        );
      }

      setNotice(
        `Devis ${json?.data?.number ?? ""} créé${
          form.sendNow ? " et envoyé au client" : " (à chiffrer)"
        }.`
      );
      setFormOpen(false);
      setForm(EMPTY_QUOTE_FORM);
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "La création a échoué.");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Met à jour un champ du formulaire sans relire la valeur du rendu courant :
   * deux frappes rapprochées seraient sinon fusionnées sur le même état et la
   * première serait perdue.
   */
  function updateForm(patch: Partial<typeof EMPTY_QUOTE_FORM>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  const hasFilters = [...params.keys()].length > 0;

  /** La somme des offres encore vivantes — ni refusées, ni annulées. */
  const openTtc = rows
    .filter((row) => row.status === "REQUESTED" || row.status === "SENT")
    .reduce((sum, row) => sum + row.totals.totalTtc, 0);

  if (loading && rows.length === 0) {
    return (
      <div className="space-y-6">
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  if (error && rows.length === 0) {
    return <ErrorState message={error} onRetry={load} />;
  }

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-20 flex-none text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              État
            </span>
            <div
              role="tablist"
              aria-label="Filtrer par état"
              className="flex flex-wrap gap-1.5"
            >
              {STATUS_FILTERS.map((option) => (
                <button
                  key={option.key || "tous"}
                  type="button"
                  role="tab"
                  aria-selected={status === option.key}
                  onClick={() => setStatus(option.key)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    status === option.key
                      ? "bg-blue-600 text-white"
                      : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="w-20 flex-none text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Recherche
            </span>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
                aria-hidden="true"
              />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Numéro, client, immeuble, besoin…"
                aria-label="Rechercher dans les devis"
                className="w-80 rounded-lg border border-gray-300 bg-white py-1.5 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-gray-200 pt-4 dark:border-gray-800">
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {rows.length} devis{rows.length > 1 ? "" : ""}
            {hasFilters ? " dans ce filtre" : ""}
            {openTtc > 0 ? ` · ${formatDa(openTtc)} en attente` : ""}
          </span>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => void load({ silent: true })}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Actualiser
            </button>

            <button
              type="button"
              onClick={() => {
                setNotice("");
                setFormError("");
                // Repartir du formulaire vide à chaque ouverture : l'état
                // précédent (case « Envoyer » décochée, ancienne ligne) ne doit
                // pas survivre à une fermeture, sinon la création suivante
                // part en `REQUESTED` sans que personne ne l'ait demandé.
                setForm(EMPTY_QUOTE_FORM);
                setFormOpen(true);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Nouveau devis
            </button>
          </div>
        </div>

        {notice && (
          <p className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950/40 dark:text-green-300">
            {notice}
          </p>
        )}
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          title="Aucun devis dans ce filtre"
          hint={
            hasFilters
              ? "Élargissez l'état ou effacez la recherche."
              : "Une demande de devis arrive depuis le portail client."
          }
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.id}>
              <Card className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                      STATUS_BADGE[row.status] ?? STATUS_BADGE.REFUSED
                    }`}
                  >
                    {enumLabel(row.status)}
                  </span>

                  <Link
                    href={`/administration/devis/${row.id}`}
                    className="font-mono text-sm font-semibold text-blue-700 underline decoration-dotted underline-offset-2 dark:text-blue-400"
                  >
                    {row.number}
                  </Link>

                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {format(new Date(row.createdAt), "d MMMM yyyy", {
                      locale: fr,
                    })}
                  </span>

                  <span className="ml-auto text-sm font-semibold tabular-nums text-gray-900 dark:text-white">
                    {row.lineCount === 0
                      ? "à chiffrer"
                      : formatDa(row.totals.totalTtc)}
                  </span>
                </div>

                <p className="mt-2 text-sm text-gray-900 dark:text-white">
                  {row.client?.name ?? "Sans compte client"} ·{" "}
                  {row.building.name}
                  {row.elevator ? (
                    <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                      {" "}
                      ({row.elevator.elevatorCode})
                    </span>
                  ) : null}
                </p>

                <p className="mt-1 line-clamp-2 text-sm text-gray-600 dark:text-gray-400">
                  {row.need}
                </p>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Link
                    href={`/administration/devis/${row.id}`}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
                  >
                    {row.status === "REQUESTED" ? "Chiffrer" : "Ouvrir"}
                  </Link>

                  {row.lineCount > 0 && (
                    <a
                      href={`/api/quotes/${row.id}/pdf`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                      Télécharger le PDF
                    </a>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {formOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="quote-create-heading"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setFormOpen(false);
          }}
        >
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white shadow-xl dark:bg-gray-900">
            <header className="flex items-start justify-between gap-4 border-b border-gray-200 p-5 dark:border-gray-800">
              <div>
                <h2
                  id="quote-create-heading"
                  className="text-lg font-bold text-gray-900 dark:text-white"
                >
                  Nouveau devis
                </h2>
                <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
                  L&apos;immeuble, l&apos;objet, une ligne chiffrée. L&apos;offre
                  peut partir au client dans le même geste.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                aria-label="Fermer"
                className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </header>

            <form onSubmit={submitQuote} className="space-y-4 p-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="font-medium text-gray-700 dark:text-gray-300">
                    Immeuble *
                  </span>
                  <select
                    value={form.buildingId}
                    onChange={(event) =>
                      updateForm({
                        buildingId: event.target.value,
                        elevatorId: "",
                      })
                    }
                    className={INPUT_CLASS}
                  >
                    <option value="">— Choisir —</option>
                    {buildings.map((building) => (
                      <option key={building.id} value={building.id}>
                        {building.name} — {building.city}
                      </option>
                    ))}
                  </select>
                  {selectedBuilding &&
                    (selectedBuilding.owner ? (
                      <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                        Client facturé :{" "}
                        <span className="font-medium text-gray-700 dark:text-gray-300">
                          {selectedBuilding.owner.name}
                        </span>
                      </span>
                    ) : (
                      <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400">
                        Aucun compte client sur ce site : le devis restera
                        visible du bureau seulement.
                      </span>
                    ))}
                </label>

                <label className="block text-sm">
                  <span className="font-medium text-gray-700 dark:text-gray-300">
                    Appareil (facultatif)
                  </span>
                  <select
                    value={form.elevatorId}
                    disabled={!form.buildingId}
                    onChange={(event) =>
                      updateForm({ elevatorId: event.target.value })
                    }
                    className={INPUT_CLASS}
                  >
                    <option value="">Tout l&apos;immeuble</option>
                    {units.map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.elevatorCode}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="block text-sm">
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  Objet / description du devis *
                </span>
                <textarea
                  rows={3}
                  value={form.need}
                  onChange={(event) =>
                    updateForm({ need: event.target.value })
                  }
                  placeholder="Remplacement du tube d'éclairage de cabine et mise en conformité de l'éclairage de secours."
                  className={INPUT_CLASS}
                />
              </label>

              <fieldset className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Ligne de prestation / pièce
                </legend>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_90px_130px]">
                  <input
                    value={form.designation}
                    onChange={(event) =>
                      updateForm({ designation: event.target.value })
                    }
                    placeholder="Désignation (ex. tube LED 1200 mm)"
                    aria-label="Désignation de la ligne"
                    className={INPUT_CLASS}
                  />
                  <input
                    value={form.quantity}
                    inputMode="decimal"
                    onChange={(event) =>
                      updateForm({ quantity: event.target.value })
                    }
                    placeholder="Qté"
                    aria-label="Quantité"
                    className={`${INPUT_CLASS} text-right tabular-nums`}
                  />
                  <input
                    value={form.unitPrice}
                    inputMode="decimal"
                    onChange={(event) =>
                      updateForm({ unitPrice: event.target.value })
                    }
                    placeholder="Prix unitaire HT"
                    aria-label="Prix unitaire hors taxes"
                    className={`${INPUT_CLASS} text-right tabular-nums`}
                  />
                </div>
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  Total HT {formatDa(draftTotals.totalHt)} · TVA 19 %{" "}
                  {formatDa(draftTotals.vatAmount)} · TTC{" "}
                  <span className="font-semibold text-gray-700 dark:text-gray-300">
                    {formatDa(draftTotals.totalTtc)}
                  </span>
                </p>
              </fieldset>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="font-medium text-gray-700 dark:text-gray-300">
                    Validité (jours)
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={form.validityDays}
                    onChange={(event) =>
                      updateForm({ validityDays: event.target.value })
                    }
                    className={INPUT_CLASS}
                  />
                </label>

                <label className="flex items-start gap-2 rounded-xl border border-gray-200 p-3 text-sm dark:border-gray-800">
                  <input
                    type="checkbox"
                    checked={form.sendNow}
                    onChange={(event) =>
                      updateForm({ sendNow: event.target.checked })
                    }
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-gray-700 dark:text-gray-300">
                    Envoyer directement au client
                    <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                      Le devis passe au statut « Envoyé » et devient décidable
                      dans son espace client.
                    </span>
                  </span>
                </label>
              </div>

              {formError && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300">
                  {formError}
                </p>
              )}

              <div className="flex flex-wrap justify-end gap-2 border-t border-gray-200 pt-4 dark:border-gray-800">
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  {form.sendNow ? "Créer et envoyer" : "Créer le devis"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
