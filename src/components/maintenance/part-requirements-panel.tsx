"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, PackageSearch, Plus, Printer, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { enumLabel, partUrgencyLabel } from "@/lib/ui/enum-labels";
import { PART_URGENCIES } from "@/types";
import type { PartRequirementStatus } from "@/types";

/**
 * Le panneau des demandes de pièces d'une intervention.
 *
 * POURQUOI IL EST PARTAGÉ
 * Une demande de pièce se lit et se décide à deux endroits : sur la fiche du bon
 * au bureau, et sur le bon que le technicien a ouvert dans son portail. C'est le
 * même objet, les mêmes états et les mêmes refus — deux copies auraient divergé
 * à la première correction, et le technicien aurait vu une version plus vieille
 * que celle du bureau.
 *
 * CE QU'IL NE FAIT PAS
 * Il n'écrit rien dans `partsReplaced`. Une demande n'est pas un constat : la
 * pièce posée se déclare dans le rapport d'intervention, au moment où elle est
 * posée. Confondre les deux ferait apparaître sur la facture une pièce qui a
 * seulement été demandée.
 *
 * LE NUMÉRO MÈNE AU DOCUMENT
 * Un bon de travail ne se coupe pas de sa fiche : le technicien qui tient la
 * pièce imprime la fiche et l'emporte. Le lien sort en PDF, comme la facture,
 * pour que le papier du bureau et celui du chantier soient le même document.
 */
export function PartRequirementsPanel({
  workOrderId,
  canDecide,
  canRequest = true,
  embedded = false,
}: {
  workOrderId: string;
  /** Les rôles de gestion : eux seuls décident, comme le fait la route. */
  canDecide: boolean;
  /** Faux sur un bon annulé, où la route refuserait une demande. */
  canRequest?: boolean;
  /**
   * Rendu à l'intérieur d'un cadre existant plutôt que comme une carte.
   *
   * Le portail technicien présente chaque intervention comme une carte dont les
   * sections sont séparées par des filets ; y déposer une seconde carte
   * donnerait un cadre dans un cadre, ce qui se lit mal et se voit tout de
   * suite. La seule différence est le contour et le niveau du titre — le
   * contenu, les règles et les refus sont les mêmes.
   */
  embedded?: boolean;
}) {
  const [rows, setRows] = useState<PartRequirementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(emptyDraft());

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/parts-replacement?workOrderId=${encodeURIComponent(workOrderId)}`
      );
      if (!res.ok) {
        throw new Error(`L'API des pièces a répondu ${res.status}`);
      }
      const json = await res.json();
      setRows(Array.isArray(json.data) ? json.data : []);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Échec du chargement des demandes"
      );
    } finally {
      setLoading(false);
    }
  }, [workOrderId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(row: PartRequirementRow, status: PartRequirementStatus, verb: string) {
    setBusyId(row.id);
    setActionError(null);
    setNotice(null);

    try {
      const res = await fetch("/api/parts-replacement", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, status }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          body?.error ?? body?.message ?? "La décision a été refusée."
        );
      }
      setNotice(`${row.number} — ${verb}.`);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "L'action a échoué.");
    } finally {
      setBusyId(null);
    }
  }

  async function submitRequest() {
    const read = readDraft(draft);
    if ("error" in read) {
      setActionError(read.error);
      return;
    }

    setSaving(true);
    setActionError(null);
    setNotice(null);

    try {
      const res = await fetch("/api/parts-replacement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workOrderId, ...read.body }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          body?.error ?? body?.message ?? "La demande a été refusée."
        );
      }

      setFormOpen(false);
      setDraft(emptyDraft());
      setNotice(
        `Demande ${body?.data?.number ?? ""} envoyée au bureau.`.trim()
      );
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "L'envoi a échoué.");
    } finally {
      setSaving(false);
    }
  }

  const content = (
    <>
      <div className="flex items-center gap-2">
        <PackageSearch className="h-4 w-4 text-gray-400" />
        <h2
          className={
            embedded
              ? "text-sm font-semibold text-gray-900 dark:text-white"
              : "text-base font-semibold text-gray-900 dark:text-white"
          }
        >
          Pièces à commander
        </h2>
        {rows.length > 0 && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-600 dark:bg-gray-800 dark:text-gray-300">
            {rows.length}
          </span>
        )}

        {canRequest && !formOpen && (
          <button
            type="button"
            onClick={() => {
              setFormOpen(true);
              setActionError(null);
              setNotice(null);
            }}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Demander une pièce
          </button>
        )}
      </div>

      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Ce qu&apos;il faut se procurer — à ne pas confondre avec les pièces
        posées, qui se déclarent dans le rapport d&apos;intervention et partent
        sur la facture.
      </p>

      {notice && (
        <p
          role="status"
          className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm font-medium text-green-800 dark:bg-green-950/40 dark:text-green-300"
        >
          {notice}
        </p>
      )}
      {actionError && (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {actionError}
        </p>
      )}

      {formOpen && (
        <div className="mt-4 rounded-lg border border-blue-200 bg-white/70 p-4 dark:border-blue-900 dark:bg-gray-900/60">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Pièce défectueuse *">
              <input
                value={draft.faultyPartName}
                onChange={(e) =>
                  setDraft({ ...draft, faultyPartName: e.target.value })
                }
                placeholder="Carte de commande"
                className={INPUT}
              />
            </Field>
            <Field label="Sa référence">
              <input
                value={draft.faultyPartReference}
                onChange={(e) =>
                  setDraft({ ...draft, faultyPartReference: e.target.value })
                }
                placeholder="MPB-3400"
                className={INPUT}
              />
            </Field>
            <Field label="Pièce de rechange requise *">
              <input
                value={draft.replacementPartName}
                onChange={(e) =>
                  setDraft({ ...draft, replacementPartName: e.target.value })
                }
                placeholder="Carte de commande"
                className={INPUT}
              />
            </Field>
            <Field label="Sa référence">
              <input
                value={draft.replacementPartReference}
                onChange={(e) =>
                  setDraft({ ...draft, replacementPartReference: e.target.value })
                }
                placeholder="MPB-3400-R2"
                className={INPUT}
              />
            </Field>
            <Field label="Quantité">
              <input
                inputMode="numeric"
                value={draft.quantity}
                onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
                className={INPUT}
              />
            </Field>
            <Field label="Urgence">
              <select
                value={draft.urgency}
                onChange={(e) =>
                  setDraft({ ...draft, urgency: e.target.value as PartUrgency })
                }
                className={INPUT}
              >
                {PART_URGENCIES.map((urgency) => (
                  <option key={urgency} value={urgency}>
                    {partUrgencyLabel(urgency)}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Observations" className="mt-3">
            <textarea
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              rows={3}
              placeholder="Ce qui a été constaté : mesure, bruit, défaut relevé."
              className={INPUT}
            />
          </Field>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void submitRequest()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Envoyer au bureau
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setFormOpen(false);
                setDraft(emptyDraft());
                setActionError(null);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              <X className="h-4 w-4" aria-hidden="true" />
              Annuler
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="mt-4 h-16 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
      ) : error ? (
        <p className="mt-3 flex items-start gap-2 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          Aucune pièce à commander pour cette intervention.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {rows.map((row) => {
            const isBusy = busyId === row.id;
            const immediate = row.urgency === "IMMEDIATE";

            return (
              <li
                key={row.id}
                className={`rounded-lg border p-3 ${
                  immediate
                    ? "border-red-300 bg-red-50/50 dark:border-red-900 dark:bg-red-950/10"
                    : "border-gray-200 dark:border-gray-800"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {immediate && (
                    <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                      Arrêt immédiat
                    </span>
                  )}
                  <span className="font-mono text-xs font-semibold text-gray-900 dark:text-white">
                    {row.number}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                      STATUS_BADGE[row.status] ?? STATUS_BADGE.PENDING
                    }`}
                  >
                    {enumLabel(row.status)}
                  </span>
                  {row.quantity > 1 && (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      ×{row.quantity}
                    </span>
                  )}
                  <a
                    href={`/api/parts-replacement/${row.id}/pdf`}
                    className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    <Printer className="h-3 w-3" aria-hidden="true" />
                    Imprimer la fiche
                  </a>
                </div>

                <p className="mt-2 text-sm text-gray-900 dark:text-white">
                  {row.faultyPartName}
                  {row.faultyPartReference ? (
                    <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                      {" "}
                      ({row.faultyPartReference})
                    </span>
                  ) : null}
                  <span className="text-gray-400"> → </span>
                  {row.replacementPartName}
                  {row.replacementPartReference ? (
                    <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                      {" "}
                      ({row.replacementPartReference})
                    </span>
                  ) : null}
                </p>

                {row.notes && (
                  <p className="mt-1 whitespace-pre-line text-xs text-gray-600 dark:text-gray-400">
                    {row.notes}
                  </p>
                )}

                <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                  Demandée par {row.requestedBy?.name ?? "un compte supprimé"} le{" "}
                  {formatStamp(row.createdAt)}
                  {row.statusChangedAt && row.status !== "PENDING"
                    ? ` · ${enumLabel(row.status).toLowerCase()} le ${formatStamp(
                        row.statusChangedAt
                      )}`
                    : ""}
                  {row.fulfilledAt
                    ? ` · posée le ${formatStamp(row.fulfilledAt)}`
                    : ""}
                </p>

                {canDecide && (
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {row.status === "PENDING" && (
                      <>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void decide(row, "APPROVED", "demande validée")}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                        >
                          {isBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          ) : null}
                          Valider
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void decide(row, "REJECTED", "demande refusée")}
                          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800"
                        >
                          Refuser
                        </button>
                      </>
                    )}

                    {row.status === "APPROVED" && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void decide(row, "FULFILLED", "pièce posée")}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                      >
                        {isBusy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        ) : null}
                        Marquer la pièce posée
                      </button>
                    )}

                    {row.status !== "PENDING" && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          void decide(
                            row,
                            "PENDING",
                            row.status === "REJECTED"
                              ? "demande rouverte"
                              : "décision retirée"
                          )
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800"
                      >
                        Revenir en attente
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!canDecide && rows.length > 0 && (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          Valider une demande engage une dépense : c&apos;est le bureau qui
          décide. Vous serez notifié de sa réponse.
        </p>
      )}
    </>
  );

  return embedded ? (
    <div className="border-t border-gray-200 px-5 py-4 dark:border-gray-800">
      {content}
    </div>
  ) : (
    <Card className="p-5">{content}</Card>
  );
}

// ─── Détails de présentation ────────────────────────────────

interface PartRequirementRow {
  id: string;
  number: string;
  status: PartRequirementStatus;
  urgency: string;
  quantity: number;
  faultyPartName: string;
  faultyPartReference: string | null;
  replacementPartName: string;
  replacementPartReference: string | null;
  notes: string | null;
  createdAt: string;
  statusChangedAt: string | null;
  fulfilledAt: string | null;
  workOrderId: string;
  requestedBy: { id: string; name: string } | null;
  statusChangedBy: { id: string; name: string } | null;
}

type PartUrgency = (typeof PART_URGENCIES)[number];

interface Draft {
  faultyPartName: string;
  faultyPartReference: string;
  replacementPartName: string;
  replacementPartReference: string;
  quantity: string;
  urgency: PartUrgency;
  notes: string;
}

const STATUS_BADGE: Record<PartRequirementStatus, string> = {
  PENDING: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  APPROVED: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  REJECTED: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
  FULFILLED: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
};

const INPUT =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 " +
  "placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 " +
  "focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block text-sm ${className}`}>
      <span className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
        {label}
      </span>
      {children}
    </label>
  );
}

function emptyDraft(): Draft {
  return {
    faultyPartName: "",
    faultyPartReference: "",
    replacementPartName: "",
    replacementPartReference: "",
    quantity: "1",
    urgency: "PREVENTIVE",
    notes: "",
  };
}

function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

/**
 * Relit le formulaire, ou dit ce qui manque.
 *
 * Le diagnostic et la pièce demandée sont obligatoires, et c'est la seule
 * vérification qui compte : une demande sans désignation n'est pas une demande,
 * c'est un message. Le reste a un défaut sensé.
 */
function readDraft(
  draft: Draft
):
  | { error: string }
  | {
      body: {
        faultyPartName: string;
        faultyPartReference?: string;
        replacementPartName: string;
        replacementPartReference?: string;
        quantity: number;
        urgency: PartUrgency;
        notes?: string;
      };
    } {
  const faultyPartName = draft.faultyPartName.trim();
  const replacementPartName = draft.replacementPartName.trim();

  if (!faultyPartName) {
    return { error: "Indiquez la pièce défectueuse constatée." };
  }
  if (!replacementPartName) {
    return { error: "Indiquez la pièce de rechange à commander." };
  }

  const quantity = Number.parseInt(draft.quantity, 10);
  if (!Number.isFinite(quantity) || quantity < 1) {
    return { error: "La quantité doit être un nombre entier d'au moins 1." };
  }

  const faultyPartReference = draft.faultyPartReference.trim();
  const replacementPartReference = draft.replacementPartReference.trim();
  const notes = draft.notes.trim();

  return {
    body: {
      faultyPartName,
      replacementPartName,
      quantity,
      urgency: draft.urgency,
      ...(faultyPartReference ? { faultyPartReference } : {}),
      ...(replacementPartReference ? { replacementPartReference } : {}),
      ...(notes ? { notes } : {}),
    },
  };
}
