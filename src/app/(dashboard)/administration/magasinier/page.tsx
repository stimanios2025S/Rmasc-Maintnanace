"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import {
  AlertTriangle,
  Check,
  Loader2,
  PackageCheck,
  RefreshCw,
  Send,
  Truck,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { enumLabel } from "@/lib/ui/enum-labels";
import {
  canTransmit,
  transmissionRefusal,
} from "@/lib/stock/eligibility";
import type { PartRequirementStatus } from "@/types";

/**
 * Le poste du chef de service technique — la réception des besoins du terrain.
 *
 * CE QU'IL FAIT, ET CE QU'IL NE FAIT PAS
 * Le technicien signale sur un toit la pièce qu'il n'a pas. Le bureau valide la
 * dépense. Ce poste est le troisième moment : celui où le besoin **part vers le
 * magasin central**, qui est une autre application — celle qui tient le stock,
 * les bons de sortie et les fournisseurs.
 *
 * Il ne décide pas du bien-fondé d'une demande : valider une dépense reste le
 * geste du bureau, et la règle vit dans `lib/parts/status.ts`. Ici on transmet
 * ce qui est déjà validé, ou on constate pourquoi on ne peut pas.
 *
 * POURQUOI L'ÉCRAN MONTRE AUSSI LES TRANSMISES ET LES ÉCHECS
 * Un envoi qui ne laisse pas de trace visible oblige à rappeler le magasin
 * central pour savoir s'il a reçu quelque chose. Les trois onglets répondent aux
 * trois seules questions qu'on se pose : qu'est-ce qui part, qu'est-ce qui est
 * parti, qu'est-ce qui a échoué.
 *
 * LES BOUTONS SUIVENT LA MÊME RÈGLE QUE LA ROUTE
 * `transmissionRefusal` décide de ce qui est offert, et la route applique
 * exactement la même fonction. Un écran qui proposerait une action que la route
 * refuse est un défaut que ce dépôt corrige chaque fois qu'il le rencontre — et
 * la seule façon de ne pas le réintroduire est de n'écrire la règle qu'une fois.
 */

interface PartRow {
  id: string;
  number: string;
  status: PartRequirementStatus;
  urgency: string;
  quantity: number;
  faultyPartName: string;
  replacementPartName: string;
  replacementPartReference: string | null;
  notes: string | null;
  createdAt: string;
  fulfilledAt: string | null;
  workOrderId: string;
  requestedBy: { id: string; name: string } | null;
  /** L'état de la transmission. Absent tant que la demande n'est jamais partie. */
  stockReference: string | null;
  stockCodeRef: string | null;
  stockSentAt: string | null;
  stockSendError: string | null;
  stockSentBy: { id: string; name: string } | null;
  workOrder: {
    orderNumber: string;
    elevator: {
      elevatorCode: string;
      building: { name: string; city: string };
    };
  };
}

interface Outcome {
  id: string;
  number: string;
  ok: boolean;
  outcome: "sent" | "failed" | "skipped";
  reference?: string | null;
  error?: string;
}

/**
 * Un article du catalogue du magasin central.
 *
 * Le magasin refuse une ligne de demande sans `codeRef` — 422 constaté sur un
 * échange réel. Nos pièces sont du texte libre : l'article est donc choisi ici,
 * par le chef de service technique, parmi ceux que le magasin expose.
 */
interface StockArticle {
  codeRef: string;
  designation: string;
  unite: string;
  emplacement: string | null;
  location: string;
  quantiteStock: number;
  seuilAlerte: number;
  enAlerte: boolean;
}

/**
 * Les onglets, dans l'ordre du travail.
 *
 * « À transmettre » d'abord : c'est le seul état qui appelle une action de ce
 * poste. Les deux suivants sont du suivi.
 */
const FILTERS = [
  { key: "todo", label: "À transmettre" },
  { key: "sent", label: "Transmises" },
  { key: "failed", label: "En échec" },
  { key: "all", label: "Toutes" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

const ACTION =
  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50";
const PRIMARY = `${ACTION} bg-blue-600 font-semibold text-white hover:bg-blue-700`;
const SECONDARY = `${ACTION} border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800`;

export default function MagasinierPage() {
  const [filter, setFilter] = useState<FilterKey>("todo");
  const [rows, setRows] = useState<PartRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [configRefusal, setConfigRefusal] = useState<string | null>(null);
  const [configKnown, setConfigKnown] = useState(false);
  /** Le catalogue du magasin, pour choisir l'article de chaque demande. */
  const [articles, setArticles] = useState<StockArticle[]>([]);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  /**
   * L'article choisi pour chaque demande, par identifiant.
   *
   * Par demande et non global : deux besoins du même bon n'appellent presque
   * jamais le même article, et un choix unique enverrait la mauvaise pièce pour
   * l'un des deux.
   */
  const [articleByRow, setArticleByRow] = useState<Record<string, string>>({});

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!silent) setLoading(true);
      setError("");
      try {
        const res = await fetch("/api/parts-replacement");
        if (!res.ok) throw new Error(`L'API des pièces a répondu ${res.status}`);
        const json = await res.json();
        setRows(Array.isArray(json.data) ? json.data : []);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Échec du chargement des demandes"
        );
      } finally {
        setLoading(false);
      }
    },
    []
  );

  /**
   * L'état de la liaison, demandé séparément.
   *
   * Il est lu une fois au montage : c'est une propriété de l'installation, pas
   * des données. Répondre « non configuré » alors que l'écran propose un bouton
   * serait la façon la plus sûre de faire perdre confiance dans le bouton.
   */
  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/parts-replacement/transmit");
      if (!res.ok) return;
      const json = await res.json();
      setConfigRefusal(json?.data?.refusal ?? null);
      setConfigKnown(true);
    } catch {
      // Silencieux : l'écran reste utilisable, seul l'avertissement manque.
    }
  }, []);

  /**
   * Le catalogue du magasin.
   *
   * Chargé une fois, et seulement si la liaison est configurée : sans
   * identifiants, l'appel échouerait avec un message qui n'apprendrait rien de
   * plus que le bandeau déjà affiché.
   */
  const loadCatalogue = useCallback(async () => {
    setCatalogueError(null);
    try {
      const res = await fetch("/api/parts-replacement/stock-catalogue");
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          json?.error ?? json?.message ?? `Le catalogue a répondu ${res.status}`
        );
      }
      setArticles(Array.isArray(json?.data?.articles) ? json.data.articles : []);
    } catch (e) {
      setCatalogueError(
        e instanceof Error ? e.message : "Catalogue du magasin indisponible."
      );
    }
  }, []);

  useEffect(() => {
    void load();
    void loadConfig();
    void loadCatalogue();
  }, [load, loadConfig, loadCatalogue]);

  /**
   * Les trois familles, calculées une fois.
   *
   * « À transmettre » se lit avec la même fonction que la route : une demande
   * validée et jamais partie. Le filtre ne recopie pas la règle, il l'appelle.
   */
  const buckets = useMemo(() => {
    const todo = rows.filter((row) => canTransmit(row));
    const sent = rows.filter((row) => Boolean(row.stockReference));
    const failed = rows.filter(
      (row) => !row.stockReference && Boolean(row.stockSendError)
    );
    return { todo, sent, failed, all: rows };
  }, [rows]);

  const visible = buckets[filter];

  /** La sélection ne survit pas à un changement d'onglet : elle porte des lignes. */
  const selectableIds = useMemo(
    () => visible.filter((row) => canTransmit(row)).map((row) => row.id),
    [visible]
  );

  const selectedInView = useMemo(
    () => selectableIds.filter((id) => selected.has(id)),
    [selectableIds, selected]
  );

  const allSelected =
    selectableIds.length > 0 && selectedInView.length === selectableIds.length;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((current) => {
      const next = new Set(current);
      if (allSelected) selectableIds.forEach((id) => next.delete(id));
      else selectableIds.forEach((id) => next.add(id));
      return next;
    });
  }

  async function transmit(ids: string[]) {
    if (ids.length === 0) return;

    /**
     * L'article est exigé AVANT l'appel.
     *
     * Le magasin refuse une ligne sans `codeRef` — 422 constaté sur un échange
     * réel. Le vérifier ici évite un aller-retour pour dire ce qu'on sait déjà,
     * et nomme la demande concernée.
     */
    const missing = ids.filter((id) => !articleByRow[id]);
    if (missing.length > 0) {
      setActionError(
        "Choisissez l'article du magasin central pour chaque demande sélectionnée."
      );
      setNotice(null);
      setOutcomes([]);
      return;
    }

    const items = ids.map((id) => ({ id, codeRef: articleByRow[id] }));

    setBusy(true);
    setActionError(null);
    setNotice(null);
    setOutcomes([]);

    try {
      const res = await fetch("/api/parts-replacement/transmit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(
          body?.error ?? body?.message ?? "La transmission a été refusée."
        );
      }

      const data = body?.data ?? {};
      const results: Outcome[] = Array.isArray(data.results) ? data.results : [];
      setOutcomes(results);

      const sent = data.sent ?? 0;
      const failed = data.failed ?? 0;
      const skipped = data.skipped ?? 0;

      /**
       * Le compte rendu nomme les trois issues séparément.
       *
       * « 4 traitées » cacherait que deux ont échoué, et c'est précisément ce
       * qu'il faut voir : la transmission est un appel réseau, et un échec
       * partiel est le cas normal, pas l'exception.
       */
      setNotice(
        [
          sent > 0 ? `${sent} transmise${sent > 1 ? "s" : ""}` : null,
          failed > 0 ? `${failed} en échec` : null,
          skipped > 0 ? `${skipped} ignorée${skipped > 1 ? "s" : ""}` : null,
        ]
          .filter(Boolean)
          .join(" · ") || "Rien n'a été transmis."
      );

      setSelected(new Set());
      await load({ silent: true });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "L'envoi a échoué.");
    } finally {
      setBusy(false);
    }
  }

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

  const cannotTransmit = configKnown && configRefusal !== null;

  return (
    <div className="space-y-6">
      {/*
        L'avertissement vient en tête et avant les onglets : tant que la liaison
        n'est pas configurée, rien de ce que l'écran propose ne peut aboutir, et
        le dire en bas serait le dire trop tard.
      */}
      {cannotTransmit && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
          <p className="flex items-start gap-2 text-sm font-medium text-amber-900 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
            <span>
              {configRefusal} La liste reste consultable, mais aucun envoi
              n&apos;aboutira tant que ces variables ne sont pas posées.
            </span>
          </p>
        </div>
      )}

      {catalogueError && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950/40">
          <p className="flex items-start gap-2 text-sm font-medium text-red-900 dark:text-red-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
            <span>
              Catalogue du magasin indisponible : {catalogueError} Aucun envoi ne
              peut aboutir sans article.
            </span>
          </p>
        </div>
      )}

      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-28 flex-none text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Vue
          </span>
          <div role="tablist" aria-label="Filtrer les demandes" className="flex flex-wrap gap-1.5">
            {FILTERS.map((option) => {
              const count = buckets[option.key].length;
              return (
                <button
                  key={option.key}
                  type="button"
                  role="tab"
                  aria-selected={filter === option.key}
                  onClick={() => setFilter(option.key)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    filter === option.key
                      ? "bg-blue-600 text-white"
                      : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                  }`}
                >
                  {option.label}
                  <span
                    className={`ml-1.5 tabular-nums ${
                      filter === option.key ? "text-blue-100" : "text-gray-400"
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => void load({ silent: true })}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Actualiser
          </button>
        </div>

        {/*
          La barre d'action n'apparaît qu'avec une sélection. Un bouton
          « Transmettre » toujours visible mais inerte userait la place de la
          seule information qui compte ici : combien de besoins attendent.
        */}
        {selectableIds.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-gray-200 pt-4 dark:border-gray-800">
            <button
              type="button"
              onClick={toggleAll}
              className="inline-flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="h-4 w-4 rounded border-gray-300 dark:border-gray-600"
                aria-label="Tout sélectionner"
              />
              Tout sélectionner
            </button>

            <span className="text-sm text-gray-500 dark:text-gray-400">
              {selectedInView.length} sélectionnée
              {selectedInView.length > 1 ? "s" : ""} sur {selectableIds.length}{" "}
              transmissible{selectableIds.length > 1 ? "s" : ""}
            </span>

            <button
              type="button"
              disabled={
                busy ||
                selectedInView.length === 0 ||
                cannotTransmit ||
                selectedInView.some((id) => !articleByRow[id])
              }
              onClick={() => void transmit(selectedInView)}
              className={`${PRIMARY} ml-auto`}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Envoyer au magasin central
            </button>
          </div>
        )}

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
      </Card>

      {/*
        Le compte rendu ligne à ligne, sous la barre et au-dessus de la liste :
        c'est ce qu'on lit juste après avoir cliqué, et le chercher plus bas
        obligerait à faire défiler la liste entière pour retrouver l'échec.
      */}
      {outcomes.some((o) => !o.ok) && (
        <Card className="border-amber-300 p-4 dark:border-amber-800">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            Ce qui n&apos;est pas parti
          </p>
          <ul className="space-y-1.5">
            {outcomes
              .filter((o) => !o.ok)
              .map((o) => (
                <li key={o.id} className="text-xs text-amber-900 dark:text-amber-200">
                  <span className="font-mono font-semibold">{o.number}</span>
                  <span className="text-amber-700 dark:text-amber-400"> — {o.error}</span>
                </li>
              ))}
          </ul>
        </Card>
      )}

      {visible.length === 0 ? (
        <EmptyState
          title={
            filter === "todo"
              ? "Aucun besoin à transmettre"
              : "Rien dans cette vue"
          }
          hint={
            filter === "todo"
              ? "Un besoin arrive ici une fois le bureau l'a validé. Une demande en attente de décision se valide depuis l'écran Pièces & Commandes."
              : "Choisissez une autre vue pour voir les autres états."
          }
        />
      ) : (
        <ul className="space-y-3">
          {visible.map((row) => {
            const immediate = row.urgency === "IMMEDIATE";
            const transmittable = canTransmit(row);
            const refusal = transmittable ? null : transmissionRefusal(row);
            const checked = selected.has(row.id);
            const failed = !row.stockReference && Boolean(row.stockSendError);

            return (
              <li key={row.id}>
                <Card
                  className={`p-4 ${
                    immediate ? "border-red-300 dark:border-red-900" : ""
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {transmittable && (
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(row.id)}
                        className="h-4 w-4 rounded border-gray-300 dark:border-gray-600"
                        aria-label={`Sélectionner ${row.number}`}
                      />
                    )}

                    {immediate && (
                      <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                        Arrêt immédiat
                      </span>
                    )}

                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                      {enumLabel(row.status)}
                    </span>

                    <span className="font-mono text-xs font-semibold text-gray-900 dark:text-white">
                      {row.number}
                    </span>

                    {row.quantity > 1 && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        ×{row.quantity}
                      </span>
                    )}

                    <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">
                      Demandée le{" "}
                      {format(new Date(row.createdAt), "d MMMM yyyy", {
                        locale: fr,
                      })}
                    </span>
                  </div>

                  {/* La pièce défectueuse et sa remplaçante côte à côte : c'est
                      la comparaison qui porte l'information pour qui commande. */}
                  <p className="mt-2 text-sm text-gray-900 dark:text-white">
                    {row.faultyPartName}
                    <span className="text-gray-400"> → </span>
                    <span className="font-medium">{row.replacementPartName}</span>
                    {row.replacementPartReference ? (
                      <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                        {" "}
                        ({row.replacementPartReference})
                      </span>
                    ) : null}
                  </p>

                  <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                    <span className="font-mono text-blue-700 dark:text-blue-400">
                      {row.workOrder.elevator.elevatorCode}
                    </span>{" "}
                    · {row.workOrder.elevator.building.name} · bon{" "}
                    <Link
                      href={`/bons-de-travail/${row.workOrderId}`}
                      className="font-mono text-blue-700 underline decoration-dotted underline-offset-2 dark:text-blue-400"
                    >
                      {row.workOrder.orderNumber}
                    </Link>{" "}
                    · demandée par {row.requestedBy?.name ?? "un compte supprimé"}
                  </p>

                  {row.notes && (
                    <p className="mt-1.5 whitespace-pre-line text-xs text-gray-600 dark:text-gray-400">
                      {row.notes}
                    </p>
                  )}

                  {/* ─── L'état de la transmission ───────────────────────── */}

                  {row.stockReference && (
                    <p className="mt-2 flex items-center gap-1.5 text-xs text-green-800 dark:text-green-300">
                      <PackageCheck className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
                      <span>
                        Reçue par le magasin central sous la référence{" "}
                        <span className="font-mono font-semibold">
                          {row.stockReference}
                        </span>
                        {row.stockCodeRef ? (
                          <span className="font-mono"> · article {row.stockCodeRef}</span>
                        ) : null}
                        {row.stockSentAt
                          ? ` le ${format(new Date(row.stockSentAt), "d MMMM yyyy", { locale: fr })}`
                          : ""}
                        {row.stockSentBy ? ` par ${row.stockSentBy.name}` : ""}.
                      </span>
                    </p>
                  )}

                  {failed && (
                    <p className="mt-2 flex items-start gap-1.5 text-xs text-red-800 dark:text-red-300">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden="true" />
                      <span>
                        <span className="font-semibold">Transmission en échec</span>
                        {row.stockSentAt
                          ? ` le ${format(new Date(row.stockSentAt), "d MMMM yyyy", { locale: fr })}`
                          : ""}
                        {" — "}
                        {row.stockSendError}
                      </span>
                    </p>
                  )}

                  {refusal && !failed && (
                    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                      {refusal}
                    </p>
                  )}

                  {/* Le choix de l'article : obligatoire, et propre à chaque
                      demande. Le magasin refuse une ligne sans `codeRef`, et
                      notre application n'a aucun catalogue pour le déduire. */}
                  {transmittable && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <label
                        htmlFor={`article-${row.id}`}
                        className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
                      >
                        Article du magasin
                      </label>
                      <select
                        id={`article-${row.id}`}
                        value={articleByRow[row.id] ?? ""}
                        onChange={(event) =>
                          setArticleByRow((current) => ({
                            ...current,
                            [row.id]: event.target.value,
                          }))
                        }
                        className="min-w-[18rem] flex-1 rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                      >
                        <option value="">— choisir dans le catalogue —</option>
                        {articles.map((article) => (
                          <option key={article.codeRef} value={article.codeRef}>
                            {article.codeRef} — {article.designation} (
                            {article.quantiteStock} {article.unite}
                            {article.enAlerte ? " · en alerte" : ""})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={
                        busy ||
                        !transmittable ||
                        cannotTransmit ||
                        !articleByRow[row.id]
                      }
                      onClick={() => void transmit([row.id])}
                      className={PRIMARY}
                      title={
                        refusal ??
                        (cannotTransmit
                          ? "La liaison au magasin central n'est pas configurée."
                          : undefined)
                      }
                    >
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      ) : failed ? (
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <Send className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      {failed
                        ? "Réessayer l'envoi"
                        : "Envoyer au magasin central"}
                    </button>

                    <Link
                      href={`/api/parts-replacement/${row.id}/pdf`}
                      className={SECONDARY}
                    >
                      <Truck className="h-3.5 w-3.5" aria-hidden="true" />
                      Imprimer la fiche
                    </Link>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
