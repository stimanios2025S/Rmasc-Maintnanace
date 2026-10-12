"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import {
  ArrowLeft,
  Check,
  FileText,
  Loader2,
  Plus,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { enumLabel } from "@/lib/ui/enum-labels";
import {
  VAT_RATE_PERCENT,
  computeQuoteTotals,
  formatDa,
  lineAmountHt,
  parseAmountInput,
} from "@/lib/quotes/totals";
import { amountInWords } from "@/lib/quotes/words";
import { quoteTransitionRefusal } from "@/lib/quotes/status";
import type { QuoteStatus } from "@/types";

/**
 * Le chiffrage d'un devis.
 *
 * LES TOTAUX SE CALCULENT ICI, EN DIRECT, AVEC LE MÊME MODULE QUE LE SERVEUR
 * `lib/quotes/totals.ts` n'a aucune dépendance, précisément pour cela : le
 * bureau voit le total se former pendant qu'il tape, et le PDF imprime le
 * résultat du même calcul. Deux implémentations — une en flottants dans le
 * navigateur, une en `Decimal` sur le serveur — auraient fini par produire deux
 * totaux pour la même offre.
 *
 * LE MONTANT EN LETTRES EST MONTRÉ AVANT L'ENVOI
 * C'est la mention que le client lit et signe. La laisser découvrir sur le PDF
 * obligerait à générer le document pour vérifier qu'il dit juste.
 *
 * ON NE CORRIGE PAS UNE OFFRE REMISE
 * Dès que le devis passe à « envoyé », les lignes se figent en lecture. Le
 * client a un papier entre les mains ; le modifier en base rendrait ce papier
 * faux sans que personne ne le sache. La route refuse la même chose — l'écran
 * et elle lisent `quoteTransitionRefusal`.
 */

interface LineRow {
  reference: string;
  designation: string;
  quantity: string;
  unit: string;
  unitPrice: string;
}

interface QuoteDetail {
  id: string;
  number: string;
  status: QuoteStatus;
  createdAt: string;
  sentAt: string | null;
  decidedAt: string | null;
  validityDays: number;
  need: string;
  notes: string | null;
  client: { id: string; name: string } | null;
  building: { id: string; name: string; city: string };
  elevator: { id: string; elevatorCode: string } | null;
  lines: {
    id: string;
    position: number;
    reference: string | null;
    designation: string;
    quantity: unknown;
    unit: string | null;
    unitPrice: unknown;
  }[];
  totals: { totalHt: number; vatAmount: number; totalTtc: number };
}

const STATUS_BADGE: Record<QuoteStatus, string> = {
  REQUESTED:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  SENT: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  ACCEPTED:
    "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  REFUSED: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
  CANCELLED: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
};

const INPUT =
  "w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 " +
  "placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 " +
  "focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500 " +
  "dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:disabled:bg-gray-800/50";

const EMPTY_LINE: LineRow = {
  reference: "",
  designation: "",
  quantity: "1",
  unit: "U",
  unitPrice: "",
};

function toDraft(line: QuoteDetail["lines"][number]): LineRow {
  return {
    reference: line.reference ?? "",
    designation: line.designation,
    quantity: String(Number(String(line.quantity))),
    unit: line.unit ?? "",
    unitPrice: String(Number(String(line.unitPrice))),
  };
}

export default function QuotePricingPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const [quote, setQuote] = useState<QuoteDetail | null>(null);
  const [lines, setLines] = useState<LineRow[]>([]);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/quotes?id=${encodeURIComponent(params.id)}`
      );
      if (!res.ok) {
        throw new Error(
          res.status === 404
            ? "Ce devis n'existe pas, ou ne vous est pas accessible."
            : `Impossible de charger le devis (${res.status}).`
        );
      }
      const json = await res.json();
      const data: QuoteDetail = json.data;
      setQuote(data);
      setLines(data.lines.map(toDraft));
      setNotes(data.notes ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Impossible de charger le devis.");
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const editable = quote?.status === "REQUESTED";

  /**
   * Les lignes relues pour le calcul.
   *
   * Une quantité ou un prix illisible compte pour zéro : la ligne est en cours
   * de frappe, et `NaN` se propagerait à tout le devis en une seule touche. Le
   * refus, lui, vient du serveur au moment d'enregistrer, avec le nom du champ.
   */
  const parsed = useMemo(
    () =>
      lines.map((line) => ({
        reference: line.reference.trim(),
        designation: line.designation.trim(),
        quantity: parseAmountInput(line.quantity) ?? 0,
        unit: line.unit.trim(),
        unitPrice: parseAmountInput(line.unitPrice) ?? 0,
      })),
    [lines]
  );

  const totals = useMemo(() => computeQuoteTotals(parsed), [parsed]);

  function updateLine(index: number, patch: Partial<LineRow>) {
    setLines((prev) =>
      prev.map((line, i) => (i === index ? { ...line, ...patch } : line))
    );
  }

  /**
   * Enregistre, et pose éventuellement un état.
   *
   * `nextStatus` est passé à la route dans le même appel : le geste du bureau
   * est « je saisis mes lignes et je remets l'offre », et deux requêtes
   * laisseraient un état intermédiaire — des lignes écrites et une offre non
   * remise — que rien ne distinguerait d'un brouillon.
   */
  async function save(nextStatus?: QuoteStatus) {
    if (!quote) return;

    // Le refus est calculé ici d'abord, pour que le message arrive sans
    // aller-retour et nomme ce qui manque.
    if (nextStatus) {
      const refusal = quoteTransitionRefusal(quote.status, nextStatus, parsed);
      if (refusal) {
        setActionError(refusal);
        return;
      }
    }

    setSaving(true);
    setActionError(null);
    setNotice(null);

    try {
      const body: Record<string, unknown> = { id: quote.id, notes };
      if (editable) {
        body.lines = parsed.map((line) => ({
          designation: line.designation,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          ...(line.reference ? { reference: line.reference } : {}),
          ...(line.unit ? { unit: line.unit } : {}),
        }));
      }
      if (nextStatus) body.status = nextStatus;

      const res = await fetch("/api/quotes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          json?.error ?? json?.message ?? "L'enregistrement a été refusé."
        );
      }

      const data: QuoteDetail = json.data;
      setQuote(data);
      setLines(data.lines.map(toDraft));
      setNotes(data.notes ?? "");
      setNotice(
        nextStatus
          ? `${data.number} — ${enumLabel(nextStatus).toLowerCase()}.`
          : `${data.number} enregistré.`
      );
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "L'enregistrement a échoué."
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  if (error || !quote) {
    return <ErrorState message={error || "Devis introuvable"} onRetry={load} />;
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <Link
        href="/administration/devis"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Devis
      </Link>

      {/* ── En-tête ───────────────────────────────────────────── */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-xs text-gray-500 dark:text-gray-400">
              {quote.number}
            </p>
            <h1 className="mt-1 text-xl font-bold text-gray-900 dark:text-white">
              {quote.building.name}
            </h1>
            <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
              {quote.client?.name ?? "Sans compte client"}
              {quote.elevator ? ` · ${quote.elevator.elevatorCode}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                STATUS_BADGE[quote.status] ?? STATUS_BADGE.REFUSED
              }`}
            >
              {enumLabel(quote.status)}
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Demandé le{" "}
              {format(new Date(quote.createdAt), "d MMMM yyyy", { locale: fr })}
            </span>
          </div>
        </div>

        <div className="mt-5 rounded-lg bg-gray-50 p-3 dark:bg-gray-800/50">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Besoin exprimé par le client
          </p>
          <p className="mt-1 whitespace-pre-line text-sm text-gray-800 dark:text-gray-200">
            {quote.need}
          </p>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <a
            href={`/api/quotes/${quote.id}/pdf`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <FileText className="h-4 w-4" aria-hidden="true" />
            Télécharger le PDF
          </a>
        </div>
      </Card>

      {notice && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-900/20 dark:text-green-200"
        >
          <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {notice}
        </p>
      )}
      {actionError && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-900/20 dark:text-red-300"
        >
          <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {actionError}
        </p>
      )}

      {/* ── Les lignes ────────────────────────────────────────── */}
      <Card className="p-5">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">
          Prestations et fournitures
        </h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {editable
            ? "Le total se forme à mesure de la saisie. Les lignes se figent dès que l'offre est remise au client."
            : "L'offre a été remise : ses lignes ne se modifient plus. Refusez-la puis rouvrez la demande pour la reprendre."}
        </p>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800">
                <th className="py-2 pr-2 font-semibold">Réf</th>
                <th className="py-2 pr-2 font-semibold">Désignation</th>
                <th className="w-20 py-2 pr-2 text-right font-semibold">Qté</th>
                <th className="w-20 py-2 pr-2 font-semibold">Unité</th>
                <th className="w-28 py-2 pr-2 text-right font-semibold">
                  P.U. (DA)
                </th>
                <th className="w-28 py-2 pr-2 text-right font-semibold">
                  Montant
                </th>
                {editable && <th className="w-10 py-2" />}
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr>
                  <td
                    colSpan={editable ? 7 : 6}
                    className="py-4 text-sm text-gray-500 dark:text-gray-400"
                  >
                    Aucune ligne. Ajoutez une prestation ou une fourniture.
                  </td>
                </tr>
              )}
              {lines.map((line, index) => (
                <tr
                  key={index}
                  className="border-b border-gray-100 align-middle dark:border-gray-800"
                >
                  <td className="py-1.5 pr-2">
                    <input
                      value={line.reference}
                      disabled={!editable}
                      onChange={(e) => updateLine(index, { reference: e.target.value })}
                      placeholder="—"
                      className={`${INPUT} w-24 font-mono`}
                      aria-label={`Référence ligne ${index + 1}`}
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <input
                      value={line.designation}
                      disabled={!editable}
                      onChange={(e) =>
                        updateLine(index, { designation: e.target.value })
                      }
                      placeholder="Désignation de la prestation"
                      className={INPUT}
                      aria-label={`Désignation ligne ${index + 1}`}
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <input
                      value={line.quantity}
                      disabled={!editable}
                      inputMode="decimal"
                      onChange={(e) => updateLine(index, { quantity: e.target.value })}
                      className={`${INPUT} text-right tabular-nums`}
                      aria-label={`Quantité ligne ${index + 1}`}
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <input
                      value={line.unit}
                      disabled={!editable}
                      onChange={(e) => updateLine(index, { unit: e.target.value })}
                      placeholder="U"
                      className={INPUT}
                      aria-label={`Unité ligne ${index + 1}`}
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <input
                      value={line.unitPrice}
                      disabled={!editable}
                      inputMode="decimal"
                      onChange={(e) => updateLine(index, { unitPrice: e.target.value })}
                      placeholder="0"
                      className={`${INPUT} text-right tabular-nums`}
                      aria-label={`Prix unitaire ligne ${index + 1}`}
                    />
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums font-medium text-gray-900 dark:text-white">
                    {formatDa(
                      lineAmountHt({
                        quantity: parsed[index]?.quantity ?? 0,
                        unitPrice: parsed[index]?.unitPrice ?? 0,
                      })
                    )}
                  </td>
                  {editable && (
                    <td className="py-1.5 text-center">
                      <button
                        type="button"
                        onClick={() =>
                          setLines((prev) => prev.filter((_, i) => i !== index))
                        }
                        aria-label={`Retirer la ligne ${index + 1}`}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-800"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {editable && (
          <button
            type="button"
            onClick={() => setLines((prev) => [...prev, { ...EMPTY_LINE }])}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Ajouter une ligne
          </button>
        )}

        {/* ── Totaux ──────────────────────────────────────────── */}
        <div className="mt-5 border-t border-gray-200 pt-4 dark:border-gray-800">
          <dl className="ml-auto max-w-sm space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500 dark:text-gray-400">Total HT</dt>
              <dd className="tabular-nums text-gray-900 dark:text-white">
                {formatDa(totals.totalHt)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500 dark:text-gray-400">
                TVA ({VAT_RATE_PERCENT} %)
              </dt>
              <dd className="tabular-nums text-gray-900 dark:text-white">
                {formatDa(totals.vatAmount)}
              </dd>
            </div>
            <div className="flex justify-between border-t border-gray-200 pt-1.5 text-base font-semibold dark:border-gray-800">
              <dt className="text-gray-900 dark:text-white">Total TTC</dt>
              <dd className="tabular-nums text-gray-900 dark:text-white">
                {formatDa(totals.totalTtc)}
              </dd>
            </div>
          </dl>

          {/**
           * La mention du formulaire, montrée avant l'impression. C'est ce que
           * le client lit et signe ; le découvrir sur le PDF obligerait à
           * générer le document pour vérifier qu'il dit juste.
           */}
          <p className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700 dark:bg-gray-800/50 dark:text-gray-300">
            Arrêté le présent devis à la somme de :{" "}
            <span className="font-medium">
              {amountInWords(totals.totalTtc)}.
            </span>
          </p>
        </div>
      </Card>

      {/* ── Observations du bureau ────────────────────────────── */}
      <Card className="p-5">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">
          Observations du bureau
        </h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Délai de fourniture, conditions d&apos;accès, ce qui est compris ou
          non. Ce texte s&apos;imprime sur l&apos;offre, sous les totaux.
        </p>
        <textarea
          value={notes}
          disabled={!editable}
          onChange={(event) => setNotes(event.target.value)}
          rows={3}
          placeholder="Délai estimé, précisions sur l'intervention…"
          className={`${INPUT} mt-3`}
        />
      </Card>

      {/* ── Les décisions ─────────────────────────────────────── */}
      <Card className="p-5">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">
          Décisions
        </h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {quote.status === "REQUESTED"
            ? "Enregistrez le chiffrage, puis remettez l'offre au client."
            : quote.status === "SENT"
              ? "L'offre est chez le client. Enregistrez sa réponse quand elle arrive."
              : "Ce devis est clos. Rouvrez la demande pour le reprendre."}
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            Enregistrer
          </button>

          {quote.status === "REQUESTED" && (
            <button
              type="button"
              disabled={saving}
              onClick={() => void save("SENT")}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              <Send className="h-4 w-4" aria-hidden="true" />
              Remettre au client
            </button>
          )}

          {quote.status === "SENT" && (
            <>
              <button
                type="button"
                disabled={saving}
                onClick={() => void save("ACCEPTED")}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                <Check className="h-4 w-4" aria-hidden="true" />
                Marquer accepté
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void save("REFUSED")}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                <X className="h-4 w-4" aria-hidden="true" />
                Marquer refusé
              </button>
            </>
          )}

          {quote.status !== "REQUESTED" && (
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                if (
                  quote.status === "ACCEPTED" &&
                  !window.confirm(
                    "Ce devis a été accepté par le client. Le remettre en demande " +
                      "efface la trace de cet accord — les décisions seront " +
                      "réenregistrées. Continuer ?"
                  )
                ) {
                  return;
                }
                void save("REQUESTED");
              }}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              Rouvrir la demande
            </button>
          )}
        </div>

        {quote.status === "ACCEPTED" && (
          <p className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
            Un devis accepté engage l&apos;entreprise. Rouvrir la demande
            conserve les lignes, mais la décision du client devra être
            enregistrée à nouveau.
          </p>
        )}
      </Card>
    </div>
  );
}
