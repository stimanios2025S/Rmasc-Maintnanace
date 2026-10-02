"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CirclePause, CirclePlay, Loader2, Pencil, Plus, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { enumLabel } from "@/lib/ui/enum-labels";
import { toDateInput, fromDateInput } from "@/lib/maintenance/schedule";
import type { ChecklistItem } from "@/lib/maintenance/schedule";
import {
  DueBadge,
  BUCKET_CARD_STYLES,
  bucketOf,
} from "@/components/maintenance/due-badge";
import type { MaintenanceFrequency } from "@prisma/client";

/**
 * Les programmes d'entretien d'un appareil, sur sa fiche.
 *
 * POURQUOI ICI ET PAS SUR LE TABLEAU
 * Un contrat se rattache à une machine, et une machine se configure sur sa
 * fiche : la périodicité, les points à contrôler et l'échéance sont des
 * caractéristiques de l'équipement, au même titre que sa charge maximale. Le
 * tableau `/entretien` décide de ce qu'on fait cette semaine ; il ne réécrit pas
 * un contrat. Séparer les deux évite qu'un clic de travers sur un écran de
 * planification modifie les termes d'un engagement commercial.
 *
 * LA LISTE DE POINTS SE SAISIT EN TEXTE, UNE LIGNE PAR POINT
 * Une textarea plutôt qu'une liste de champs répétables : le bureau recopie un
 * contrat, et coller huit lignes d'un coup est le geste réel. Les lignes vides
 * sont ignorées et les doublons écartés — deux points identiques produiraient
 * deux lignes de contrôle du même nom, que la restauration du rapport
 * apparie par nom et fusionnerait de toute façon en silence.
 */

const FREQUENCIES = [
  "WEEKLY",
  "BIWEEKLY",
  "MONTHLY",
  "QUARTERLY",
  "SEMI_ANNUAL",
  "ANNUAL",
  "BY_USAGE_CYCLES",
] as const satisfies readonly MaintenanceFrequency[];

interface ScheduleRow {
  id: string;
  title: string;
  description: string | null;
  frequency: MaintenanceFrequency;
  cycleThreshold: number | null;
  checklist: ChecklistItem[];
  nextDueDate: string;
  lastCompleted: string | null;
  isActive: boolean;
  activeWorkOrder: {
    id: string;
    orderNumber: string;
    scheduledDate: string | null;
  } | null;
}

interface FormState {
  title: string;
  description: string;
  frequency: MaintenanceFrequency;
  /** Gardé en texte : un `<input type="number">` vide n'est pas zéro. */
  cycleThreshold: string;
  nextDueDate: string;
  checklistText: string;
}

function emptyForm(): FormState {
  return {
    title: "",
    description: "",
    frequency: "MONTHLY",
    cycleThreshold: "",
    nextDueDate: toDateInput(new Date()),
    checklistText: "",
  };
}

function formOf(row: ScheduleRow): FormState {
  return {
    title: row.title,
    description: row.description ?? "",
    frequency: row.frequency,
    cycleThreshold: row.cycleThreshold === null ? "" : String(row.cycleThreshold),
    nextDueDate: toDateInput(new Date(row.nextDueDate)),
    checklistText: row.checklist.map((item) => item.name).join("\n"),
  };
}

/**
 * Une ligne non vide = un point de contrôle.
 *
 * Les doublons sont écartés ici, à la saisie, et pas à l'affichage : ce qui est
 * enregistré en base doit être ce que le technicien cochera, et une liste
 * contenant deux fois « Essai du frein » l'obligerait à cocher deux fois le
 * même essai.
 */
function checklistFromText(text: string): ChecklistItem[] {
  const seen = new Set<string>();
  const items: ChecklistItem[] = [];

  for (const raw of text.split("\n")) {
    const name = raw.trim().replace(/^\d+[.)]\s*/, "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    items.push({ name, required: true });
  }

  return items;
}

export function SchedulePanel({
  elevatorId,
  canEdit,
}: {
  elevatorId: string;
  canEdit: boolean;
}) {
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** `null` = fermé ; `""` = création ; un id = édition de cette ligne. */
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/maintenance-schedules?elevatorId=${encodeURIComponent(elevatorId)}`
      );
      if (!res.ok) throw new Error(`L'API des programmes a répondu ${res.status}`);
      const json = await res.json();
      setRows(json.data ?? []);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Échec du chargement des programmes"
      );
    } finally {
      setLoading(false);
    }
  }, [elevatorId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Le verdict est calculé ici, une fois pour toutes les lignes, avec un seul
   * `new Date()` — pour la même raison que sur le tableau : deux lignes lues à
   * une milliseconde d'intervalle ne doivent pas être de part et d'autre de
   * minuit.
   */
  const evaluated = useMemo(() => {
    const now = new Date();
    return rows.map((row) => ({
      row,
      ...bucketOf(row, Boolean(row.activeWorkOrder), now),
    }));
  }, [rows]);

  function closeForm() {
    setEditing(null);
    setForm(emptyForm());
    setFormError(null);
  }

  function openCreate() {
    setEditing("");
    setForm(emptyForm());
    setFormError(null);
    setNotice(null);
  }

  function openEdit(row: ScheduleRow) {
    setEditing(row.id);
    setForm(formOf(row));
    setFormError(null);
    setNotice(null);
  }

  /**
   * Valide avant d'envoyer, et dit exactement ce qui manque.
   *
   * Les mêmes règles existent côté serveur — c'est lui qui fait autorité — mais
   * un refus de l'API coûte un aller-retour et n'indique pas le champ. Ici, la
   * règle des cycles est appliquée sur la valeur *effective*, exactement comme
   * dans `cyclesRuleViolation` : le formulaire ne peut pas contredire la route.
   */
  function buildPayload(): Record<string, unknown> | string {
    const title = form.title.trim();
    if (title.length < 3) return "Donnez un intitulé d'au moins 3 caractères.";

    const next = fromDateInput(form.nextDueDate);
    if (!next) return "Choisissez une date d'échéance.";

    let cycleThreshold: number | null = null;
    if (form.frequency === "BY_USAGE_CYCLES") {
      const parsed = Number.parseInt(form.cycleThreshold, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return "Une périodicité « à l'usage » exige un nombre de cycles de référence.";
      }
      cycleThreshold = parsed;
    }

    return {
      title,
      description: form.description.trim(),
      frequency: form.frequency,
      cycleThreshold,
      nextDueDate: form.nextDueDate,
      checklistItems: checklistFromText(form.checklistText),
    };
  }

  async function save() {
    const payload = buildPayload();
    if (typeof payload === "string") {
      setFormError(payload);
      return;
    }

    setSaving(true);
    setFormError(null);
    setNotice(null);

    try {
      const isCreate = editing === "";
      const res = await fetch(
        isCreate ? "/api/maintenance-schedules" : `/api/maintenance-schedules/${editing}`,
        {
          method: isCreate ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isCreate ? { elevatorId, ...payload } : payload
          ),
        }
      );

      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          body?.error ?? body?.message ?? "L'enregistrement a été refusé."
        );
      }

      setNotice(
        isCreate
          ? `Programme « ${payload.title} » créé.`
          : `Programme « ${payload.title} » mis à jour.`
      );
      closeForm();
      await load();
    } catch (e) {
      setFormError(
        e instanceof Error ? e.message : "L'enregistrement a échoué."
      );
    } finally {
      setSaving(false);
    }
  }

  /**
   * Suspendre ou réactiver.
   *
   * Pas de suppression : retirer la ligne effacerait le lien entre les visites
   * déjà faites et l'obligation qu'elles acquittaient — voir l'en-tête de
   * `POST /api/maintenance-schedules`. Un programme qu'on ne veut plus est un
   * programme qu'on éteint.
   */
  async function toggleActive(row: ScheduleRow) {
    setBusyId(row.id);
    setError(null);
    setNotice(null);

    try {
      const res = await fetch(`/api/maintenance-schedules/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !row.isActive }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error ?? body?.message ?? "La mise à jour a échoué.");
      }
      setNotice(
        row.isActive
          ? `Programme « ${row.title} » suspendu. Les visites déjà planifiées restent dues.`
          : `Programme « ${row.title} » réactivé.`
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "La mise à jour a échoué.");
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <Card className="p-6">
        <div className="h-24 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />
      </Card>
    );
  }

  // A non-management caller never sees this tab, but the API refuses them, and
  // an empty panel with a hidden cause would read as "this lift has no
  // programme" — the one conclusion that must not be reached by accident.
  if (error && rows.length === 0) {
    return (
      <Card className="p-6">
        <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {notice && (
        <p
          role="status"
          className="rounded-lg bg-green-50 dark:bg-green-950/40 px-3 py-2 text-sm font-medium text-green-800 dark:text-green-300"
        >
          {notice}
        </p>
      )}

      {rows.length === 0 && editing === null && (
        <Card className="p-6">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Aucun programme d&apos;entretien sur cet appareil. Sans programme,
            aucune visite préventive n&apos;est jamais due : la machine
            n&apos;apparaîtra sur le tableau que le jour où quelqu&apos;un la
            signalera en panne.
          </p>
        </Card>
      )}

      {evaluated.map(({ row, bucket, due }) => {
        const isBusy = busyId === row.id;

        return (
          <Card
            key={row.id}
            className={`p-5 ${BUCKET_CARD_STYLES[bucket]}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-semibold text-gray-900 dark:text-white">
                {row.title}
              </h4>
              <span className="inline-flex items-center gap-1 rounded-full border border-gray-300 dark:border-gray-700 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-600 dark:text-gray-300">
                {enumLabel(row.frequency)}
              </span>
              <DueBadge
                bucket={bucket}
                due={due}
                isActive={row.isActive}
                cycleThreshold={row.cycleThreshold}
              />

              {canEdit && (
                <div className="ml-auto flex gap-2">
                  <button
                    type="button"
                    onClick={() => openEdit(row)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    Modifier
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void toggleActive(row)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    {isBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : row.isActive ? (
                      <CirclePause className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <CirclePlay className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {row.isActive ? "Suspendre" : "Réactiver"}
                  </button>
                </div>
              )}
            </div>

            {row.description && (
              <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                {row.description}
              </p>
            )}

            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Échéance au{" "}
              <span className="font-medium">
                {new Date(row.nextDueDate).toLocaleDateString("fr-FR")}
              </span>
              {row.lastCompleted
                ? ` · dernière visite le ${new Date(
                    row.lastCompleted
                  ).toLocaleDateString("fr-FR")}`
                : " · aucune visite enregistrée"}
              {row.activeWorkOrder
                ? ` · bon ${row.activeWorkOrder.orderNumber} en cours`
                : ""}
            </p>

            {row.checklist.length > 0 ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-300">
                  {row.checklist.length}{" "}
                  {row.checklist.length > 1 ? "points de contrôle" : "point de contrôle"}
                </summary>
                <ol className="mt-2 list-inside list-decimal space-y-0.5 text-sm text-gray-600 dark:text-gray-400">
                  {row.checklist.map((item, i) => (
                    <li key={i}>{item.name}</li>
                  ))}
                </ol>
              </details>
            ) : (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                Aucun point de contrôle : le technicien recevra la liste
                standard à la place.
              </p>
            )}
          </Card>
        );
      })}

      {canEdit && editing === null && (
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Ajouter un programme d&apos;entretien
        </button>
      )}

      {canEdit && editing !== null && (
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-gray-900 dark:text-white">
              {editing === ""
                ? "Nouveau programme d'entretien"
                : "Modifier le programme"}
            </h4>
            <button
              type="button"
              onClick={closeForm}
              aria-label="Fermer le formulaire"
              className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="text-sm md:col-span-2">
              <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
                Intitulé
              </span>
              <input
                type="text"
                value={form.title}
                maxLength={200}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Inspection de sécurité mensuelle"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              />
            </label>

            <label className="text-sm md:col-span-2">
              <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
                Description (facultative)
              </span>
              <textarea
                value={form.description}
                rows={2}
                maxLength={2000}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              />
            </label>

            <label className="text-sm">
              <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
                Périodicité
              </span>
              <select
                value={form.frequency}
                onChange={(e) =>
                  setForm({
                    ...form,
                    frequency: e.target.value as MaintenanceFrequency,
                  })
                }
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              >
                {FREQUENCIES.map((frequency) => (
                  <option key={frequency} value={frequency}>
                    {enumLabel(frequency)}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm">
              <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
                Prochaine échéance
              </span>
              <input
                type="date"
                value={form.nextDueDate}
                onChange={(e) => setForm({ ...form, nextDueDate: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              />
            </label>

            {/*
              Le seuil de cycles n'apparaît que là où il sert. L'afficher en
              permanence laisserait croire qu'il s'applique aussi à une
              périodicité mensuelle — où la route le refuse.
            */}
            {form.frequency === "BY_USAGE_CYCLES" && (
              <label className="text-sm md:col-span-2">
                <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
                  Nombre de cycles de référence
                </span>
                <input
                  type="number"
                  min={1}
                  value={form.cycleThreshold}
                  onChange={(e) =>
                    setForm({ ...form, cycleThreshold: e.target.value })
                  }
                  placeholder="20000"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white md:max-w-xs"
                />
                <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                  Aucune échéance n&apos;est calculée sur cette périodicité :
                  rien dans le système ne compte les cycles d&apos;un appareil.
                  Le programme est affiché « à l&apos;usage », ni à l&apos;heure
                  ni en retard.
                </span>
              </label>
            )}

            <label className="text-sm md:col-span-2">
              <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
                Points de contrôle — un par ligne
              </span>
              <textarea
                value={form.checklistText}
                rows={6}
                onChange={(e) =>
                  setForm({ ...form, checklistText: e.target.value })
                }
                placeholder={
                  "Contrôle de la tension des câbles\nEssai du frein d'urgence\nVérification du nivellement de la cabine"
                }
                className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              />
              <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                Ces points pré-remplissent le rapport d&apos;inspection du
                technicien pour chaque visite issue de ce programme. Les lignes
                vides et les doublons sont ignorés.
              </span>
            </label>
          </div>

          {formError && (
            <p
              role="alert"
              className="mt-4 rounded-lg bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm font-medium text-red-800 dark:text-red-300"
            >
              {formError}
            </p>
          )}

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {saving && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {editing === "" ? "Créer le programme" : "Enregistrer"}
            </button>
            <button
              type="button"
              onClick={closeForm}
              className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              Annuler
            </button>
          </div>

          {editing !== "" && (
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              Changer la périodicité ne déplace pas l&apos;échéance en cours :
              la nouvelle période s&apos;appliquera à partir de la prochaine
              visite terminée. Modifiez la date ci-dessus si elle doit changer
              aussi.
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
