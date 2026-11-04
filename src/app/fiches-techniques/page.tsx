"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { useSession } from "next-auth/react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { SectionTabs, PARC_TABS } from "@/components/layout/section-tabs";
import {
  OPTIONAL_FIELD_NAMES,
  TECHNICAL_SHEET_SECTIONS,
  isEditableField,
} from "@/lib/technical-sheets/fields";

/**
 * The maintenance team's board of « Fiches Techniques ».
 *
 * WHY THIS SCREEN IS MOSTLY ABOUT WHAT IS *MISSING*
 * A sheet arrives from a non-contract client who filled in what the caretaker
 * could see from the machine room. The four identifying fields are always
 * present; the forty-odd technical ones mostly are not, and that is by design —
 * the technician completes them on site. So the board's real job is not to
 * display the data, it is to answer "which sheet still needs a visit, and what
 * exactly does that visit have to record?".
 *
 * That is why every row carries a completeness count and why the expanded view
 * lists the sections rather than dumping a flat table: a technician scrolling
 * this list is picking their next job, not auditing a database.
 *
 * Read-only on purpose. The columns are completed by the maintenance team, but
 * they do it on paper and in the machine room; an inline editor here would let
 * anyone overwrite a client's own submission from an office desk, with no
 * record of who changed what. Editing is a deliberate follow-up, not an
 * oversight — see the deployment notes.
 */

interface TechnicalSheetRow {
  id: string;
  elevatorId: string | null;
  clientId: string;
  clientName: string;
  location: string;
  weightCapacity: string;
  numberOfFloors: string;
  /** Compléments saisis au bureau pour une demande téléphonique. */
  buildingName?: string | null;
  contactPhone?: string | null;
  /** Marque et modèle relevés ou déclarés. */
  brand?: string | null;
  model?: string | null;
  createdAt: string;
  client: {
    id: string;
    name: string | null;
    email: string;
    phone: string | null;
  };
  elevator: {
    id: string;
    elevatorCode: string;
    model: string | null;
    building: { id: string; name: string; city: string } | null;
  } | null;
  /** Every other column is an optional free-text field, read by name. */
  [key: string]: unknown;
}

/** The value of an optional column, or null when it was left blank. */
function optionalValue(sheet: TechnicalSheetRow, name: string): string | null {
  const raw = sheet[name];
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}

function filledOptionalCount(sheet: TechnicalSheetRow): number {
  return OPTIONAL_FIELD_NAMES.reduce(
    (total, name) => total + (optionalValue(sheet, name) ? 1 : 0),
    0
  );
}

export default function TechnicalSheetsPage() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "ADMIN";

  const [sheets, setSheets] = useState<TechnicalSheetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  /** Vrai quand la liste vient de la fixture (pas de PostgreSQL). */
  const [demoMode, setDemoMode] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    clientName: "",
    buildingName: "",
    location: "",
    contactPhone: "",
  });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createNotice, setCreateNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/technical-sheets?limit=200");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      // The API wraps every response in `{ data }`; see `jsonOk` in
      // `src/lib/api/http.ts`.
      setSheets(payload?.data?.sheets ?? []);
      setDemoMode(payload?.demo === true);
    } catch {
      setError("Impossible de charger les fiches techniques.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Filtered in the browser rather than by the API: the board loads up to 200
  // sheets at once and a maintenance team's volume does not justify a
  // server-side search round trip on every keystroke.
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sheets;
    return sheets.filter(
      (sheet) =>
        sheet.clientName.toLowerCase().includes(needle) ||
        sheet.location.toLowerCase().includes(needle) ||
        (sheet.buildingName ?? "").toLowerCase().includes(needle) ||
        (sheet.contactPhone ?? "").toLowerCase().includes(needle) ||
        (sheet.elevator?.elevatorCode ?? "").toLowerCase().includes(needle) ||
        (sheet.elevator?.building?.name ?? "").toLowerCase().includes(needle)
    );
  }, [sheets, query]);

  /**
   * Ouvre une fiche de demande hors contrat saisie au bureau.
   *
   * Quatre champs suffisent : le client n'a pas encore de dossier, et les
   * mesures techniques seront relevées à la visite. Les deux colonnes
   * obligatoires du modèle sont posées à « À renseigner » pour que la fiche
   * soit créée sans inventer une charge ou un nombre d'étages.
   */
  async function createSheet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateError("");
    setCreateNotice("");

    const payload = {
      clientName: createForm.clientName.trim(),
      buildingName: createForm.buildingName.trim(),
      location: createForm.location.trim(),
      contactPhone: createForm.contactPhone.trim(),
    };

    if (Object.values(payload).some((value) => value.length === 0)) {
      setCreateError("Les quatre champs d'identification sont obligatoires.");
      return;
    }

    setCreating(true);
    try {
      const res = await fetch("/api/technical-sheets/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          typeof body?.error === "string"
            ? body.error
            : body?.error?.message;
        throw new Error(message ?? `La création a échoué (${res.status}).`);
      }

      const created = body?.data?.sheet as TechnicalSheetRow | undefined;
      if (created) setSheets((current) => [created, ...current]);
      setShowCreate(false);
      setCreateForm({
        clientName: "",
        buildingName: "",
        location: "",
        contactPhone: "",
      });
      setCreateNotice(
        body?.demo === true
          ? "Fiche créée en mode démonstration : elle est visible dans le tableau, mais rien n'a été enregistré en base."
          : "Fiche technique créée. Les colonnes techniques peuvent être complétées dès maintenant."
      );
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "La création a échoué."
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionTabs tabs={PARC_TABS} ariaLabel="Parc ascenseurs" />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Fiches techniques
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Les fiches reçues des clients sans contrat. Les quatre champs
            d&apos;identification sont fournis par le client ; les colonnes
            techniques sont à compléter lors de la visite.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isAdmin && (
            <button
              type="button"
              onClick={() => {
                setShowCreate(true);
                setCreateError("");
                setCreateNotice("");
              }}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Nouvelle fiche technique
            </button>
          )}
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
        </div>
      </div>

      {demoMode && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          Mode démonstration : les fiches viennent du jeu d&apos;exemple. Les
          champs techniques peuvent être complétés, mais la saisie n&apos;est pas
          enregistrée en base.
        </p>
      )}

      {createNotice && (
        <p
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
        >
          {createNotice}
        </p>
      )}

      {showCreate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="nouvelle-fiche-titre"
          onClick={() => setShowCreate(false)}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-800 dark:bg-gray-900"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2
                  id="nouvelle-fiche-titre"
                  className="text-lg font-semibold text-gray-900 dark:text-white"
                >
                  Nouvelle fiche technique
                </h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  Demande d&apos;un client hors contrat, saisie au bureau.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                aria-label="Fermer"
                className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <form onSubmit={createSheet} className="space-y-3">
              {[
                {
                  name: "clientName" as const,
                  label: "Nom du client",
                  placeholder: "ex. : Nadia Boumediene",
                },
                {
                  name: "buildingName" as const,
                  label: "Immeuble",
                  placeholder: "ex. : Syndic Les Oliviers",
                },
                {
                  name: "location" as const,
                  label: "Adresse",
                  placeholder: "ex. : 45 boulevard de la Soummam, Oran",
                },
                {
                  name: "contactPhone" as const,
                  label: "Téléphone",
                  placeholder: "ex. : 0770 12 45 67",
                },
              ].map((field) => (
                <label key={field.name} className="block">
                  <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                    {field.label} <span className="text-red-500">*</span>
                  </span>
                  <input
                    value={createForm[field.name]}
                    onChange={(event) =>
                      setCreateForm((current) => ({
                        ...current,
                        [field.name]: event.target.value,
                      }))
                    }
                    required
                    placeholder={field.placeholder}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                  />
                </label>
              ))}

              {createError && (
                <p
                  role="alert"
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
                >
                  {createError}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
                >
                  {creating ? (
                    <Loader2
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Plus className="h-4 w-4" aria-hidden="true" />
                  )}
                  Créer la fiche
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
          aria-hidden="true"
        />
        <input
          id="recherche-fiches"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Rechercher par client, adresse ou code ascenseur…"
          aria-label="Rechercher une fiche technique"
          className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-4 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
        />
      </div>

      {loading && <LoadingSkeleton rows={4} />}

      {!loading && error && <ErrorState message={error} onRetry={() => void load()} />}

      {!loading && !error && visible.length === 0 && (
        <EmptyState
          title={
            sheets.length === 0
              ? "Aucune fiche technique reçue pour le moment"
              : "Aucun résultat"
          }
          description={
            sheets.length === 0
              ? "Les fiches remplies par les prospects sans contrat arrivent ici. Elles décrivent l'immeuble et ses appareils avant qu'une offre ne soit établie."
              : "Essayez un autre nom, une autre adresse ou un autre code."
          }
        />
      )}

      {!loading && !error && visible.length > 0 && (
        <div className="space-y-3">
          {visible.map((sheet) => (
            <SheetCard
              key={sheet.id}
              sheet={sheet}
              open={expanded === sheet.id}
              onToggle={() =>
                setExpanded((current) => (current === sheet.id ? null : sheet.id))
              }
              onUpdated={(updated) =>
                setSheets((current) =>
                  current.map((item) =>
                    item.id === updated.id ? { ...item, ...updated } : item
                  )
                )
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SheetCard({
  sheet,
  open,
  onToggle,
  onUpdated,
}: {
  sheet: TechnicalSheetRow;
  open: boolean;
  onToggle: () => void;
  /** Remonte la fiche fusionnée après une complétion réussie. */
  onUpdated: (sheet: TechnicalSheetRow) => void;
}) {
  const filled = filledOptionalCount(sheet);
  const total = OPTIONAL_FIELD_NAMES.length;
  // A sheet with every technical column answered is the exception, not the
  // norm, so the badge reports progress rather than pass/fail.
  const complete = filled === total;

  const headingId = `fiche-${sheet.id}-titre`;

  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [editNotice, setEditNotice] = useState("");

  function startEditing() {
    const values: Record<string, string> = {};
    for (const name of OPTIONAL_FIELD_NAMES) {
      values[name] = optionalValue(sheet, name) ?? "";
    }
    setEditValues(values);
    setEditing(true);
    setEditError("");
    setEditNotice("");
  }

  async function saveEdit() {
    setSaving(true);
    setEditError("");
    setEditNotice("");

    try {
      const res = await fetch(`/api/technical-sheets/${sheet.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editValues),
      });
      const payload = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(
          payload?.error ?? `La mise à jour a échoué (${res.status}).`
        );
      }

      const updated: TechnicalSheetRow = payload?.data?.sheet
        ? { ...sheet, ...payload.data.sheet }
        : { ...sheet, ...editValues };

      onUpdated(updated);
      setEditing(false);
      setEditNotice(
        payload?.demo === true
          ? "Fiche complétée en mode démonstration. Les valeurs sont visibles dans le tableau, mais rien n'a été enregistré en base."
          : "Fiche mise à jour. Les champs techniques sont enregistrés."
      );
    } catch (err) {
      setEditError(
        err instanceof Error ? err.message : "La mise à jour a échoué."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`fiche-${sheet.id}-detail`}
        className="flex w-full items-start gap-3 p-4 text-left"
      >
        <span className="mt-0.5 shrink-0 text-gray-400">
          {open ? (
            <ChevronDown className="h-5 w-5" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-5 w-5" aria-hidden="true" />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span
            id={headingId}
            className="block font-semibold text-gray-900 dark:text-white"
          >
            {sheet.clientName}
          </span>
          <span className="mt-0.5 block text-sm text-gray-500 dark:text-gray-400">
            {sheet.buildingName ? `${sheet.buildingName} · ` : ""}
            {sheet.location}
          </span>
          <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
            {sheet.weightCapacity} kg · {sheet.numberOfFloors} étages
            {sheet.elevator ? ` · ${sheet.elevator.elevatorCode}` : ""}
          </span>
        </span>

        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <span
            className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${
              complete
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                : filled === 0
                  ? "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                  : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
            }`}
          >
            {filled} / {total} champs techniques
          </span>
          <span className="whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">
            {format(new Date(sheet.createdAt), "d MMMM yyyy", { locale: fr })}
          </span>
        </span>
      </button>

      {open && (
        <div
          id={`fiche-${sheet.id}-detail`}
          aria-labelledby={headingId}
          className="border-t border-gray-200 p-4 dark:border-gray-800"
        >
          <dl className="mb-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500 dark:text-gray-400">Transmis par</dt>
              <dd className="text-right font-medium text-gray-900 dark:text-white">
                {sheet.clientName || sheet.client.name || sheet.client.email}
              </dd>
            </div>
            {(sheet.contactPhone || sheet.client.phone) && (
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500 dark:text-gray-400">Téléphone</dt>
                <dd className="text-right font-medium text-gray-900 dark:text-white">
                  {sheet.contactPhone ?? sheet.client.phone}
                </dd>
              </div>
            )}
            {(sheet.buildingName || sheet.elevator?.building) && (
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500 dark:text-gray-400">Immeuble</dt>
                <dd className="text-right font-medium text-gray-900 dark:text-white">
                  {sheet.buildingName ??
                    `${sheet.elevator?.building?.name ?? ""}${
                      sheet.elevator?.building?.city
                        ? ` (${sheet.elevator.building.city})`
                        : ""
                    }`}
                </dd>
              </div>
            )}
          </dl>

          {editNotice && (
            <p
              role="status"
              className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
            >
              {editNotice}
            </p>
          )}
          {editError && (
            <p
              role="alert"
              className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
            >
              {editError}
            </p>
          )}

          {!editing && (
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                onClick={startEditing}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"
              >
                <Pencil className="h-4 w-4" aria-hidden="true" />
                Compléter la fiche
              </button>
            </div>
          )}

          {editing ? (
            <div className="space-y-5">
              {TECHNICAL_SHEET_SECTIONS.map((section) => {
                const fields = section.fields.filter((field) =>
                  isEditableField(field.name)
                );
                if (fields.length === 0) return null;

                return (
                  <section key={section.id}>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      {section.title}
                    </h3>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {fields.map((field) => (
                        <label key={field.name} className="block text-sm">
                          <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                            {field.label}
                          </span>
                          <input
                            value={editValues[field.name] ?? ""}
                            onChange={(event) =>
                              setEditValues((current) => ({
                                ...current,
                                [field.name]: event.target.value,
                              }))
                            }
                            placeholder={field.placeholder}
                            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                          />
                          {field.hint && (
                            <span className="mt-1 block text-[11px] text-gray-400">
                              {field.hint}
                            </span>
                          )}
                        </label>
                      ))}
                    </div>
                  </section>
                );
              })}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void saveEdit()}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                >
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Check className="h-4 w-4" aria-hidden="true" />
                  )}
                  Enregistrer
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setEditError("");
                  }}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  Annuler
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-4">
                {TECHNICAL_SHEET_SECTIONS.map((section) => {
                  // Only the answered fields are listed. Showing forty rows of
                  // "—" would bury the handful that a technician actually needs
                  // to read before setting off.
                  const answered = section.fields
                    .map((field) => ({
                      label: field.label,
                      value:
                        field.name === "clientName" ||
                        field.name === "location" ||
                        field.name === "weightCapacity" ||
                        field.name === "numberOfFloors"
                          ? String(sheet[field.name] ?? "")
                          : optionalValue(sheet, field.name),
                    }))
                    .filter((entry) => entry.value);

                  if (answered.length === 0) return null;

                  return (
                    <section key={section.id}>
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        {section.title}
                      </h3>
                      <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
                        {answered.map((entry) => (
                          <div
                            key={entry.label}
                            className="flex justify-between gap-4 border-b border-gray-100 py-1 dark:border-gray-800"
                          >
                            <dt className="text-gray-500 dark:text-gray-400">
                              {entry.label}
                            </dt>
                            <dd className="text-right font-medium text-gray-900 dark:text-white">
                              {entry.value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </section>
                  );
                })}
              </div>

              {!complete && (
                <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
                  {total - filled} champ{total - filled > 1 ? "s" : ""}{" "}
                  technique{total - filled > 1 ? "s" : ""} reste
                  {total - filled > 1 ? "nt" : ""} à renseigner lors de la
                  visite.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}
