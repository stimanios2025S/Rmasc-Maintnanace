"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import {
  Check,
  FileText,
  Loader2,
  PackageSearch,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Truck,
  X,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { enumLabel } from "@/lib/ui/enum-labels";
import { formatDzd } from "@/lib/ui/money";
import { awaitsDecision, transitionRefusal } from "@/lib/parts/status";
import type { PartRequirementStatus } from "@/types";

/**
 * Le tableau des pièces à commander, pour le bureau.
 *
 * CE QU'IL AJOUTE
 * Le panneau des demandes de pièces existait, mais **seulement à l'intérieur
 * d'un bon de travail**. Le bureau n'avait donc aucune vue d'ensemble : pour
 * savoir ce qui attendait une décision, il fallait ouvrir les bons un par un —
 * c'est-à-dire ne pas le faire. Une pièce demandée depuis un toit attendait une
 * décision que personne ne voyait.
 *
 * `/api/parts-replacement?status=PENDING` savait déjà répondre. Rien ne
 * l'appelait.
 *
 * LES ACTIONS SUIVENT LA MÊME RÈGLE QUE LA ROUTE
 * `transitionRefusal` décide quels boutons s'affichent, et la route applique la
 * même fonction. Un écran qui proposerait une action que la route refuse est un
 * défaut que ce dépôt corrige à chaque fois qu'il le rencontre.
 *
 * CE QU'IL NE FAIT PAS
 * Il ne modifie ni la quantité ni la désignation d'une demande : ce que le
 * technicien a constaté sur l'appareil ne se réécrit pas depuis un bureau. Seule
 * la décision se prend ici.
 */

interface PartRow {
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
  /** La réserve locale, quand la pièce y figure. `null` = inconnue. */
  stockAvailable: number | null;
  stockLocation: string | null;
  /** Le motif d'un refus, saisi par le magasinier. */
  decisionNote: string | null;
  workOrder: {
    orderNumber: string;
    title: string;
    elevator: {
      id: string;
      elevatorCode: string;
      building: { id: string; name: string; city: string };
    };
  };
}

/**
 * Un article de la réserve physique.
 *
 * Distinct d'une demande : il n'a ni bon de travail ni demandeur, seulement
 * une quantité et un emplacement.
 */
interface StockRow {
  id: string;
  reference: string;
  name: string;
  category: string | null;
  quantity: number;
  reorderThreshold: number;
  unitPrice: string | number | null;
  location: string | null;
  updatedAt: string;
}

/** Une ligne du journal des mouvements de la réserve. */
interface StockMovementRow {
  id: string;
  type: "ENTRY" | "EXIT" | "RESERVATION" | "ADJUSTMENT";
  quantity: number;
  reason: string | null;
  createdAt: string;
  stockItem: { id: string; reference: string; name: string };
  user: { id: string; name: string } | null;
}

const MOVEMENT_LABEL: Record<StockMovementRow["type"], string> = {
  ENTRY: "Entrée",
  EXIT: "Sortie",
  RESERVATION: "Réservation",
  ADJUSTMENT: "Ajustement",
};

const MOVEMENT_TONE: Record<StockMovementRow["type"], string> = {
  ENTRY:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  EXIT: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
  RESERVATION:
    "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300",
  ADJUSTMENT:
    "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
};

/**
 * Les onglets, dans l'ordre du travail.
 *
 * « En attente » et « validées » d'abord : ce sont les deux états qui appellent
 * une action — décider, puis commander. Les suivants n'appellent plus rien,
 * c'est du suivi.
 */
const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: "", label: "Toutes" },
  { key: "PENDING_STOCK_CHECK", label: "À vérifier" },
  { key: "PENDING", label: "À décider" },
  { key: "RESERVED", label: "Réservées" },
  { key: "ORDER_REQUIRED", label: "Ruptures" },
  { key: "APPROVED", label: "À commander" },
  { key: "ORDERED", label: "Commandées" },
  { key: "FULFILLED", label: "Posées" },
  { key: "REJECTED", label: "Refusées" },
];

const STATUS_BADGE: Record<PartRequirementStatus, string> = {
  PENDING:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  PENDING_STOCK_CHECK:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  APPROVED: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  RESERVED:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  ORDER_REQUIRED:
    "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  ORDERED:
    "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  FULFILLED:
    "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  REJECTED: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
};

/** Le style commun des petits boutons d'action. */
const ACTION =
  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50";
const PRIMARY = `${ACTION} bg-blue-600 font-semibold text-white hover:bg-blue-700`;
const SECONDARY = `${ACTION} border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800`;
const QUIET = `${ACTION} text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800`;

export default function PiecesAFournirPage() {
  /**
   * Les deux onglets de la console.
   *
   * « Demandes de pièces » est le circuit quotidien ; « Réception & réserve
   * physique » montre ce que le magasin a réellement en rayon. Les deux se
   * lisent ensemble — une demande ne se réserve que contre une quantité — mais
   * ce sont deux questions, donc deux onglets.
   */
  const [tab, setTab] = useState<"requests" | "stock" | "movements">(
    "requests"
  );
  const [stockItems, setStockItems] = useState<StockRow[]>([]);
  const [stockLoading, setStockLoading] = useState(false);
  const [stockError, setStockError] = useState("");
  const [showStockForm, setShowStockForm] = useState(false);
  const [stockSaving, setStockSaving] = useState(false);
  const [stockFormError, setStockFormError] = useState("");
  const [stockNotice, setStockNotice] = useState("");
  const [stockForm, setStockForm] = useState({
    name: "",
    reference: "",
    category: "",
    quantity: "0",
    reorderThreshold: "0",
    unitPrice: "",
    location: "",
  });

  /** Journal des mouvements, chargé à l'ouverture de son onglet. */
  const [movementRows, setMovementRows] = useState<StockMovementRow[]>([]);
  const [movementsLoading, setMovementsLoading] = useState(false);
  const [movementsError, setMovementsError] = useState("");
  const [movementSearch, setMovementSearch] = useState("");
  const [debouncedMovementSearch, setDebouncedMovementSearch] = useState("");
  const [movementType, setMovementType] = useState<
    "" | StockMovementRow["type"]
  >("");
  const [movementsRefresh, setMovementsRefresh] = useState(0);

  /** L'article en cours de réapprovisionnement et la quantité reçue. */
  const [restockTarget, setRestockTarget] = useState<StockRow | null>(null);
  const [restockQuantity, setRestockQuantity] = useState("1");
  const [restockReason, setRestockReason] = useState("");
  const [restockSaving, setRestockSaving] = useState(false);
  const [restockError, setRestockError] = useState("");

  /** L'article en cours de modification et ses champs éditables. */
  const [editTarget, setEditTarget] = useState<StockRow | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    category: "",
    location: "",
    unitPrice: "",
    reorderThreshold: "",
  });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");

  /** Réception d'un bon de livraison fournisseur. */
  const [showBlForm, setShowBlForm] = useState(false);
  const [blNumber, setBlNumber] = useState("");
  const [blItemId, setBlItemId] = useState("");
  const [blQuantity, setBlQuantity] = useState("1");
  const [blLines, setBlLines] = useState<
    Array<{ stockItemId: string; quantity: number }>
  >([]);
  const [blSaving, setBlSaving] = useState(false);
  const [blError, setBlError] = useState("");

  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<PartRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** demande de pièce → devis créé, pour remplacer le bouton par un lien. */
  const [quoteResults, setQuoteResults] = useState<
    Record<string, { id: string | null; number: string }>
  >({});
  const [quotingId, setQuotingId] = useState<string | null>(null);
  /** La demande dont on saisit le motif de refus, et le motif en cours. */
  const [rejectTarget, setRejectTarget] = useState<PartRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!silent) setLoading(true);
      setError("");
      try {
        const query = status ? `?status=${encodeURIComponent(status)}` : "";
        const res = await fetch(`/api/parts-replacement${query}`);
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
    },
    [status]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // La réserve n'est chargée qu'à l'ouverture de son onglet : la console
  // quotidienne ne doit pas payer une requête qu'elle n'affiche pas.
  useEffect(() => {
    if (tab !== "stock" || stockItems.length > 0) return;

    let cancelled = false;
    setStockLoading(true);
    setStockError("");

    fetch("/api/stock")
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((payload) => {
        if (cancelled) return;
        setStockItems(Array.isArray(payload?.data) ? payload.data : []);
      })
      .catch(() => {
        if (!cancelled) setStockError("Impossible de charger la réserve.");
      })
      .finally(() => {
        if (!cancelled) setStockLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tab, stockItems.length]);

  // Débounce de la recherche : une frappe ne doit pas lancer une requête.
  useEffect(() => {
    const id = setTimeout(
      () => setDebouncedMovementSearch(movementSearch.trim()),
      300
    );
    return () => clearTimeout(id);
  }, [movementSearch]);

  // L'historique est relu à l'ouverture de l'onglet et à chaque filtre.
  useEffect(() => {
    if (tab !== "movements") return;

    let cancelled = false;
    setMovementsLoading(true);
    setMovementsError("");

    const query = new URLSearchParams({ limit: "100" });
    if (debouncedMovementSearch) query.set("q", debouncedMovementSearch);
    if (movementType) query.set("type", movementType);

    fetch(`/api/stock/movements?${query.toString()}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((payload) => {
        if (cancelled) return;
        setMovementRows(Array.isArray(payload?.data) ? payload.data : []);
      })
      .catch(() => {
        if (!cancelled) {
          setMovementsError("Impossible de charger l'historique des flux.");
        }
      })
      .finally(() => {
        if (!cancelled) setMovementsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tab, debouncedMovementSearch, movementType, movementsRefresh]);

  async function decide(
    row: PartRow,
    next: PartRequirementStatus,
    verb: string
  ) {
    /**
     * Le refus est calculé ici d'abord, pour qu'il arrive sans aller-retour et
     * nomme ce qui manque. La route applique exactement la même règle — c'est
     * la même fonction.
     */
    const refusal = transitionRefusal(row.status, next);
    if (refusal) {
      setActionError(refusal);
      setNotice(null);
      return;
    }

    setBusyId(row.id);
    setActionError(null);
    setNotice(null);

    try {
      const res = await fetch("/api/parts-replacement", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, status: next }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          body?.error ?? body?.message ?? "La décision a été refusée."
        );
      }
      setNotice(`${row.number} — ${verb}.`);
      await load({ silent: true });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "L'action a échoué.");
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Le geste du magasinier : réserver, constater la rupture, refuser.
   *
   * Le refus passe par une saisie de motif — un refus muet oblige le technicien
   * à rappeler pour savoir quoi corriger, ce qui est exactement ce que ce
   * circuit existe pour éviter.
   */
  async function act(
    row: PartRow,
    action: "reserve" | "order" | "reject",
    reason?: string
  ) {
    setBusyId(row.id);
    setActionError(null);
    setNotice(null);

    try {
      const res = await fetch("/api/parts-replacement", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: row.id,
          action,
          ...(reason ? { reason } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          body?.error ?? body?.message ?? "L'action a été refusée."
        );
      }

      const verb =
        action === "reserve"
          ? "pièce réservée, le technicien est prévenu"
          : action === "order"
            ? "passée en commande fournisseur"
            : "demande refusée";
      setNotice(`${row.number} — ${verb}.`);
      setRejectTarget(null);
      setRejectReason("");
      await load({ silent: true });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "L'action a échoué.");
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Transforme une demande validée en devis.
   *
   * La route écrit le devis, l'immeuble, l'appareil et le besoin à partir de la
   * demande : rien n'est ressaisi, donc rien ne peut diverger. Elle est
   * idempotente — un double clic renvoie l'offre déjà créée plutôt que d'en
   * ouvrir une seconde.
   */
  async function createQuoteForPart(row: PartRow) {
    setQuotingId(row.id);
    setActionError(null);
    setNotice(null);

    try {
      const res = await fetch(`/api/part-requirements/${row.id}/quote`, {
        method: "POST",
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(
          body?.error ?? body?.message ?? "Le devis n'a pas pu être créé."
        );
      }

      const data = body?.data;
      setQuoteResults((current) => ({
        ...current,
        [row.id]: { id: data.quoteId ?? null, number: data.number },
      }));
      setNotice(
        `${data.number} — devis ${
          data.alreadyExists ? "déjà créé" : "créé"
        } pour ${row.number}.${
          body?.demo ? " Mode démonstration : le devis n'a pas été enregistré en base." : " L'équipe technique est prévenue."
        }`
      );
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "Le devis n'a pas pu être créé."
      );
    } finally {
      setQuotingId(null);
    }
  }

  /**
   * Le nombre de demandes qui attendent une décision, dans la vue courante.
   *
   * Le test passe par `awaitsDecision` et non par `status === "PENDING"` : c'est
   * la fonction qui porte cette règle, et la recopier ici est exactement ce que
   * le module existe pour éviter. La recopie serait restée juste aujourd'hui,
   * puis serait devenue fausse le jour où un état s'ajoute avant la décision —
   * sans que rien ne le signale, puisque le compte aurait continué de s'afficher.
   */
  const awaiting = useMemo(
    () => rows.filter((row) => awaitsDecision(row.status)).length,
    [rows]
  );

  const tabsBar = (
    <div
      role="tablist"
      aria-label="Console magasin"
      className="flex gap-1 border-b border-gray-200 dark:border-gray-800"
    >
      <button
        type="button"
        role="tab"
        aria-selected={tab === "requests"}
        onClick={() => setTab("requests")}
        className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${
          tab === "requests"
            ? "border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-400"
            : "border-transparent text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
        }`}
      >
        Demandes de pièces
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "stock"}
        onClick={() => setTab("stock")}
        className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${
          tab === "stock"
            ? "border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-400"
            : "border-transparent text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
        }`}
      >
        Réception &amp; Réserve physique
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "movements"}
        onClick={() => setTab("movements")}
        className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${
          tab === "movements"
            ? "border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-400"
            : "border-transparent text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
        }`}
      >
        Historique des flux
      </button>
    </div>
  );

  async function createStockItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStockFormError("");
    setStockNotice("");

    const quantity = Number.parseInt(stockForm.quantity, 10);
    const reorderThreshold = Number.parseInt(stockForm.reorderThreshold, 10);
    const unitPrice = stockForm.unitPrice.trim()
      ? Number(stockForm.unitPrice.replace(",", "."))
      : undefined;

    if (!stockForm.name.trim() || !stockForm.reference.trim()) {
      setStockFormError("Le nom et la référence sont obligatoires.");
      return;
    }
    if (!Number.isInteger(quantity) || quantity < 0) {
      setStockFormError("La quantité doit être un entier positif ou nul.");
      return;
    }
    if (!Number.isInteger(reorderThreshold) || reorderThreshold < 0) {
      setStockFormError("Le seuil critique doit être un entier positif ou nul.");
      return;
    }
    if (unitPrice !== undefined && (!Number.isFinite(unitPrice) || unitPrice < 0)) {
      setStockFormError("Le prix unitaire doit être un montant positif.");
      return;
    }

    setStockSaving(true);
    try {
      const res = await fetch("/api/stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: stockForm.name.trim(),
          reference: stockForm.reference.trim(),
          category: stockForm.category.trim() || undefined,
          quantity,
          reorderThreshold,
          unitPrice,
          location: stockForm.location.trim() || undefined,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : payload?.error?.message;
        throw new Error(message ?? `La création a échoué (${res.status}).`);
      }

      const created = payload?.data as StockRow | undefined;
      if (created) {
        setStockItems((current) =>
          [...current, created].sort((a, b) => a.name.localeCompare(b.name, "fr"))
        );
      }
      setShowStockForm(false);
      setStockForm({
        name: "",
        reference: "",
        category: "",
        quantity: "0",
        reorderThreshold: "0",
        unitPrice: "",
        location: "",
      });
      setStockNotice(
        payload?.demo === true
          ? "Référence créée en mode démonstration — non enregistrée en base."
          : `Référence ${created?.reference ?? ""} ajoutée à la réserve.`
      );
    } catch (err) {
      setStockFormError(
        err instanceof Error ? err.message : "La création a échoué."
      );
    } finally {
      setStockSaving(false);
    }
  }

  /**
   * Réception de nouvelles unités sur une référence existante.
   *
   * `PATCH /api/stock` avec un `delta` positif : pas de création, donc pas de
   * 409 de doublon. La ligne locale est remplacée par la réponse, ce qui garde
   * la quantité, le seuil et l'emplacement à jour sans relire toute la réserve.
   */
  async function restock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!restockTarget) return;

    setRestockError("");
    const quantity = Number.parseInt(restockQuantity, 10);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      setRestockError(
        "La quantité reçue doit être un entier supérieur à zéro."
      );
      return;
    }

    setRestockSaving(true);
    try {
      const res = await fetch("/api/stock", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: restockTarget.id,
          delta: quantity,
          reason: restockReason.trim() || "Réception au magasin",
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : payload?.error?.message;
        throw new Error(message ?? `La réception a échoué (${res.status}).`);
      }

      const updated = payload?.data as StockRow | undefined;
      if (updated) {
        setStockItems((current) =>
          current.map((item) => (item.id === updated.id ? updated : item))
        );
      }
      setStockNotice(
        `${restockTarget.reference} : +${quantity} unité(s) ajoutée(s) à la réserve.`
      );
      setRestockTarget(null);
      setRestockQuantity("1");
      setRestockReason("");
      // Le prochain passage sur l'onglet doit relire le journal.
      setMovementsRefresh((n) => n + 1);
    } catch (err) {
      setRestockError(
        err instanceof Error ? err.message : "La réception a échoué."
      );
    } finally {
      setRestockSaving(false);
    }
  }

  function openEdit(item: StockRow) {
    setEditTarget(item);
    setEditForm({
      name: item.name,
      category: item.category ?? "",
      location: item.location ?? "",
      unitPrice:
        item.unitPrice === null || item.unitPrice === undefined
          ? ""
          : String(item.unitPrice),
      reorderThreshold: String(item.reorderThreshold),
    });
    setEditError("");
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editTarget) return;

    setEditError("");
    const name = editForm.name.trim();
    if (!name) {
      setEditError("Le nom de l'article est obligatoire.");
      return;
    }

    const threshold = Number.parseInt(editForm.reorderThreshold, 10);
    if (!Number.isInteger(threshold) || threshold < 0) {
      setEditError("Le seuil critique doit être un entier positif ou nul.");
      return;
    }

    const unitPrice = editForm.unitPrice.trim()
      ? Number(editForm.unitPrice.replace(",", "."))
      : null;
    if (unitPrice !== null && (!Number.isFinite(unitPrice) || unitPrice < 0)) {
      setEditError("Le prix unitaire doit être un montant positif.");
      return;
    }

    setEditSaving(true);
    try {
      const res = await fetch("/api/stock", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editTarget.id,
          name,
          category: editForm.category.trim() || null,
          location: editForm.location.trim() || null,
          unitPrice,
          reorderThreshold: threshold,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : payload?.error?.message;
        throw new Error(message ?? `La modification a échoué (${res.status}).`);
      }

      const updated = payload?.data as StockRow | undefined;
      if (updated) {
        setStockItems((current) =>
          current.map((item) => (item.id === updated.id ? updated : item))
        );
      }
      setStockNotice(
        `Article ${updated?.reference ?? editTarget.reference} mis à jour.`
      );
      setEditTarget(null);
      setMovementsRefresh((n) => n + 1);
    } catch (err) {
      setEditError(
        err instanceof Error ? err.message : "La modification a échoué."
      );
    } finally {
      setEditSaving(false);
    }
  }

  function addBlLine() {
    setBlError("");
    if (!blItemId) {
      setBlError("Choisissez un article.");
      return;
    }

    const quantity = Number.parseInt(blQuantity, 10);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      setBlError("La quantité reçue doit être un entier supérieur à zéro.");
      return;
    }

    setBlLines((current) => {
      const existing = current.findIndex(
        (line) => line.stockItemId === blItemId
      );
      if (existing >= 0) {
        return current.map((line, index) =>
          index === existing
            ? { ...line, quantity: line.quantity + quantity }
            : line
        );
      }
      return [...current, { stockItemId: blItemId, quantity }];
    });
    setBlQuantity("1");
  }

  function removeBlLine(index: number) {
    setBlLines((current) => current.filter((_, i) => i !== index));
  }

  async function submitBl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBlError("");

    const number = blNumber.trim();
    if (!number) {
      setBlError("Le numéro de BL est obligatoire.");
      return;
    }
    if (blLines.length === 0) {
      setBlError("Ajoutez au moins une ligne à la réception.");
      return;
    }

    setBlSaving(true);
    try {
      const res = await fetch("/api/stock/receptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blNumber: number, lines: blLines }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : payload?.error?.message;
        throw new Error(message ?? `La réception a échoué (${res.status}).`);
      }

      const items = payload?.data?.items as StockRow[] | undefined;
      if (Array.isArray(items)) {
        const byId = new Map(items.map((item) => [item.id, item]));
        setStockItems((current) =>
          current.map((item) => byId.get(item.id) ?? item)
        );
      }

      setStockNotice(
        `Réception BL ${number} enregistrée (${blLines.length} ligne(s)).`
      );
      setShowBlForm(false);
      setBlNumber("");
      setBlLines([]);
      setBlItemId("");
      setBlQuantity("1");
      setMovementsRefresh((n) => n + 1);
    } catch (err) {
      setBlError(
        err instanceof Error ? err.message : "La réception a échoué."
      );
    } finally {
      setBlSaving(false);
    }
  }

  if (tab === "movements") {
    return (
      <div className="space-y-6">
        {tabsBar}

        <Card className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                Historique des flux
              </h2>
              <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
                Entrées, sorties, réservations et corrections d&apos;inventaire
                de la réserve physique, du plus récent au plus ancien.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setMovementsRefresh((n) => n + 1)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Actualiser
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              value={movementSearch}
              onChange={(event) => setMovementSearch(event.target.value)}
              placeholder="Rechercher par nom ou référence…"
              className="min-w-[220px] flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
            />
            <div className="flex flex-wrap gap-1">
              {[
                { key: "", label: "Tous" },
                { key: "ENTRY", label: "Entrées" },
                { key: "EXIT", label: "Sorties" },
                { key: "RESERVATION", label: "Réservations" },
                { key: "ADJUSTMENT", label: "Ajustements" },
              ].map((option) => (
                <button
                  key={option.key || "all"}
                  type="button"
                  onClick={() =>
                    setMovementType(
                      option.key as "" | StockMovementRow["type"]
                    )
                  }
                  className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                    movementType === option.key
                      ? "border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-950/40 dark:text-blue-300"
                      : "border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {movementsLoading ? (
            <p className="mt-4 text-sm text-gray-500">
              Chargement de l&apos;historique…
            </p>
          ) : movementsError ? (
            <p
              role="alert"
              className="mt-4 text-sm font-medium text-red-700 dark:text-red-400"
            >
              {movementsError}
            </p>
          ) : movementRows.length === 0 ? (
            <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
              Aucun mouvement enregistré pour le moment.
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-800">
                    {[
                      "Date",
                      "Type",
                      "Article",
                      "Quantité",
                      "Motif",
                      "Auteur",
                    ].map((header) => (
                      <th
                        key={header}
                        className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {movementRows.map((movement) => (
                    <tr key={movement.id}>
                      <td className="whitespace-nowrap px-3 py-2 text-sm text-gray-500">
                        {format(new Date(movement.createdAt), "dd/MM/yyyy HH:mm", {
                          locale: fr,
                        })}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                            MOVEMENT_TONE[movement.type]
                          }`}
                        >
                          {MOVEMENT_LABEL[movement.type]}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-sm">
                        <span className="font-mono text-xs text-gray-700 dark:text-gray-300">
                          {movement.stockItem.reference}
                        </span>
                        <span className="block text-gray-500 dark:text-gray-400">
                          {movement.stockItem.name}
                        </span>
                      </td>
                      <td
                        className={`px-3 py-2 text-sm font-bold tabular-nums ${
                          movement.quantity > 0
                            ? "text-emerald-700 dark:text-emerald-300"
                            : "text-red-700 dark:text-red-300"
                        }`}
                      >
                        {movement.quantity > 0 ? "+" : ""}
                        {movement.quantity}
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                        {movement.reason ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                        {movement.user?.name ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    );
  }

  if (tab === "stock") {
    return (
      <div className="space-y-6">
        {tabsBar}

        <Card className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                Réserve physique du magasin
              </h2>
              <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
                Ce que le magasinier a sous la main. Une réservation décrémente
                cette quantité.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowStockForm(true);
                  setStockFormError("");
                  setStockNotice("");
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Nouvelle référence
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowBlForm(true);
                  setBlError("");
                  setStockNotice("");
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
              >
                <Truck className="h-4 w-4" aria-hidden="true" />
                Réception BL
              </button>
              <Link
                href="/administration/magasinier"
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Réception magasin central
              </Link>
            </div>
          </div>

          {stockNotice && (
            <p
              role="status"
              className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
            >
              {stockNotice}
            </p>
          )}

          {showStockForm && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="nouvelle-reference-titre"
              onClick={() => setShowStockForm(false)}
            >
              <div
                className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-800 dark:bg-gray-900"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <h2
                      id="nouvelle-reference-titre"
                      className="text-lg font-semibold text-gray-900 dark:text-white"
                    >
                      Nouvelle référence
                    </h2>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      Un article reçu au magasin et suivi dans la réserve
                      physique.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowStockForm(false)}
                    aria-label="Fermer"
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>

                <form onSubmit={createStockItem} className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block sm:col-span-2">
                      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        Nom de l&apos;article <span className="text-red-500">*</span>
                      </span>
                      <input
                        value={stockForm.name}
                        onChange={(event) =>
                          setStockForm((current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                        required
                        placeholder="ex. : Variateur Fuji 15 kW"
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        Référence <span className="text-red-500">*</span>
                      </span>
                      <input
                        value={stockForm.reference}
                        onChange={(event) =>
                          setStockForm((current) => ({
                            ...current,
                            reference: event.target.value,
                          }))
                        }
                        required
                        placeholder="FUJI-VVVF-15"
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        Catégorie
                      </span>
                      <input
                        value={stockForm.category}
                        onChange={(event) =>
                          setStockForm((current) => ({
                            ...current,
                            category: event.target.value,
                          }))
                        }
                        placeholder="Électronique, portes, câbles…"
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        Quantité
                      </span>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={stockForm.quantity}
                        onChange={(event) =>
                          setStockForm((current) => ({
                            ...current,
                            quantity: event.target.value,
                          }))
                        }
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        Seuil critique
                      </span>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={stockForm.reorderThreshold}
                        onChange={(event) =>
                          setStockForm((current) => ({
                            ...current,
                            reorderThreshold: event.target.value,
                          }))
                        }
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        Prix unitaire (DZD)
                      </span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={stockForm.unitPrice}
                        onChange={(event) =>
                          setStockForm((current) => ({
                            ...current,
                            unitPrice: event.target.value,
                          }))
                        }
                        placeholder="145000"
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      />
                    </label>
                    <label className="block sm:col-span-2">
                      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        Emplacement casier
                      </span>
                      <input
                        value={stockForm.location}
                        onChange={(event) =>
                          setStockForm((current) => ({
                            ...current,
                            location: event.target.value,
                          }))
                        }
                        placeholder="Allée B · radeau 1"
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      />
                    </label>
                  </div>

                  {stockFormError && (
                    <p
                      role="alert"
                      className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
                    >
                      {stockFormError}
                    </p>
                  )}

                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowStockForm(false)}
                      className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      Annuler
                    </button>
                    <button
                      type="submit"
                      disabled={stockSaving}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
                    >
                      {stockSaving ? (
                        <Loader2
                          className="h-4 w-4 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <Plus className="h-4 w-4" aria-hidden="true" />
                      )}
                      Ajouter la référence
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {restockTarget && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="restock-titre"
              onClick={() => setRestockTarget(null)}
            >
              <div
                className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-800 dark:bg-gray-900"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <h2
                      id="restock-titre"
                      className="text-lg font-semibold text-gray-900 dark:text-white"
                    >
                      Réapprovisionner
                    </h2>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      {restockTarget.reference} — {restockTarget.name}
                    </p>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      En réserve : {restockTarget.quantity} · seuil{" "}
                      {restockTarget.reorderThreshold}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setRestockTarget(null)}
                    aria-label="Fermer"
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>

                <form onSubmit={restock} className="space-y-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                      Quantité reçue <span className="text-red-500">*</span>
                    </span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      required
                      value={restockQuantity}
                      onChange={(event) =>
                        setRestockQuantity(event.target.value)
                      }
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                      Motif
                    </span>
                    <input
                      value={restockReason}
                      onChange={(event) => setRestockReason(event.target.value)}
                      placeholder="Réception fournisseur, retour magasin…"
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                    />
                  </label>

                  {restockError && (
                    <p
                      role="alert"
                      className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
                    >
                      {restockError}
                    </p>
                  )}

                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setRestockTarget(null)}
                      className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      Annuler
                    </button>
                    <button
                      type="submit"
                      disabled={restockSaving}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                    >
                      {restockSaving ? (
                        <Loader2
                          className="h-4 w-4 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <Plus className="h-4 w-4" aria-hidden="true" />
                      )}
                      Ajouter au stock
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* ── Modification d'une fiche article ─────────────────── */}
          {editTarget && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="edit-article-titre"
              onClick={() => setEditTarget(null)}
            >
              <div
                className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-800 dark:bg-gray-900"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <h2
                      id="edit-article-titre"
                      className="text-lg font-semibold text-gray-900 dark:text-white"
                    >
                      Modifier l&apos;article
                    </h2>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      <span className="font-mono">
                        {editTarget.reference}
                      </span>{" "}
                      — la quantité en réserve se change par un
                      réapprovisionnement, pas ici.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditTarget(null)}
                    aria-label="Fermer"
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>

                <form onSubmit={saveEdit} className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block sm:col-span-2">
                      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        Nom de l&apos;article{" "}
                        <span className="text-red-500">*</span>
                      </span>
                      <input
                        value={editForm.name}
                        onChange={(event) =>
                          setEditForm((current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                        required
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        Catégorie
                      </span>
                      <input
                        value={editForm.category}
                        onChange={(event) =>
                          setEditForm((current) => ({
                            ...current,
                            category: event.target.value,
                          }))
                        }
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        Emplacement casier
                      </span>
                      <input
                        value={editForm.location}
                        onChange={(event) =>
                          setEditForm((current) => ({
                            ...current,
                            location: event.target.value,
                          }))
                        }
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        Prix unitaire (DZD)
                      </span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={editForm.unitPrice}
                        onChange={(event) =>
                          setEditForm((current) => ({
                            ...current,
                            unitPrice: event.target.value,
                          }))
                        }
                        placeholder="Laisser vide si inconnu"
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        Seuil critique{" "}
                        <span className="text-red-500">*</span>
                      </span>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        required
                        value={editForm.reorderThreshold}
                        onChange={(event) =>
                          setEditForm((current) => ({
                            ...current,
                            reorderThreshold: event.target.value,
                          }))
                        }
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      />
                    </label>
                  </div>

                  {editError && (
                    <p
                      role="alert"
                      className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
                    >
                      {editError}
                    </p>
                  )}

                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setEditTarget(null)}
                      className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      Annuler
                    </button>
                    <button
                      type="submit"
                      disabled={editSaving}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
                    >
                      {editSaving ? (
                        <Loader2
                          className="h-4 w-4 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <Check className="h-4 w-4" aria-hidden="true" />
                      )}
                      Enregistrer
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* ── Réception d'un bon de livraison fournisseur ─────── */}
          {showBlForm && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="reception-bl-titre"
              onClick={() => setShowBlForm(false)}
            >
              <div
                className="w-full max-w-2xl rounded-2xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-800 dark:bg-gray-900"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <h2
                      id="reception-bl-titre"
                      className="text-lg font-semibold text-gray-900 dark:text-white"
                    >
                      Réception d&apos;un bon de livraison
                    </h2>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      Crédite plusieurs articles en une seule écriture. Chaque
                      ligne du journal portera le numéro de BL comme motif.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowBlForm(false)}
                    aria-label="Fermer"
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>

                <form onSubmit={submitBl} className="space-y-4">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                      Numéro de BL fournisseur{" "}
                      <span className="text-red-500">*</span>
                    </span>
                    <input
                      value={blNumber}
                      onChange={(event) => setBlNumber(event.target.value)}
                      required
                      placeholder="ex. : BL-2026-0457"
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                    />
                  </label>

                  <div className="rounded-xl border border-gray-200 p-3 dark:border-gray-700">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Lignes reçues
                    </p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_6rem_auto]">
                      <label className="block">
                        <span className="sr-only">Article</span>
                        <select
                          value={blItemId}
                          onChange={(event) => setBlItemId(event.target.value)}
                          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                        >
                          <option value="">Choisir un article…</option>
                          {stockItems.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.reference} — {item.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="sr-only">Quantité reçue</span>
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={blQuantity}
                          onChange={(event) =>
                            setBlQuantity(event.target.value)
                          }
                          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={addBlLine}
                        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
                      >
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        Ajouter
                      </button>
                    </div>

                    {blLines.length === 0 ? (
                      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                        Aucune ligne. Ajoutez au moins un article reçu.
                      </p>
                    ) : (
                      <ul className="mt-3 divide-y divide-gray-100 dark:divide-gray-800">
                        {blLines.map((line, index) => {
                          const item = stockItems.find(
                            (candidate) => candidate.id === line.stockItemId
                          );
                          return (
                            <li
                              key={line.stockItemId}
                              className="flex items-center justify-between gap-3 py-2"
                            >
                              <span className="min-w-0 text-sm text-gray-900 dark:text-white">
                                <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                                  {item?.reference ?? line.stockItemId}
                                </span>{" "}
                                {item?.name ?? "Article inconnu"}
                              </span>
                              <span className="flex items-center gap-2">
                                <span className="text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
                                  +{line.quantity}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => removeBlLine(index)}
                                  aria-label={`Retirer la ligne ${index + 1}`}
                                  className="rounded-lg p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                                >
                                  <X className="h-4 w-4" aria-hidden="true" />
                                </button>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>

                  {blError && (
                    <p
                      role="alert"
                      className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
                    >
                      {blError}
                    </p>
                  )}

                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setShowBlForm(false);
                        setBlLines([]);
                        setBlError("");
                      }}
                      className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      Annuler
                    </button>
                    <button
                      type="submit"
                      disabled={blSaving || blLines.length === 0}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                    >
                      {blSaving ? (
                        <Loader2
                          className="h-4 w-4 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <Truck className="h-4 w-4" aria-hidden="true" />
                      )}
                      Enregistrer la réception
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {stockLoading ? (
            <p className="mt-4 text-sm text-gray-500">Chargement de la réserve…</p>
          ) : stockError ? (
            <p role="alert" className="mt-4 text-sm font-medium text-red-700 dark:text-red-400">
              {stockError}
            </p>
          ) : stockItems.length === 0 ? (
            <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
              Aucun article en réserve. Lancez{" "}
              <code className="rounded bg-gray-100 px-1 py-0.5 text-xs dark:bg-gray-800">
                npx tsx scripts/seed-stock.ts
              </code>{" "}
              pour amorcer un catalogue de démonstration.
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-800">
                    {[
                      "Référence",
                      "Désignation",
                      "Catégorie",
                      "En réserve",
                      "Seuil",
                      "Prix unitaire",
                      "Emplacement",
                      "État",
                      "Action",
                    ].map((h) => (
                      <th
                        key={h}
                        className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {stockItems.map((item) => {
                    const out = item.quantity === 0;
                    const critical =
                      !out && item.quantity < item.reorderThreshold;
                    const low = !out && item.quantity <= item.reorderThreshold;
                    return (
                      <tr key={item.id}>
                        <td className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-300">
                          {item.reference}
                        </td>
                        <td className="px-3 py-2 text-sm font-medium text-gray-900 dark:text-white">
                          {item.name}
                        </td>
                        <td className="px-3 py-2 text-sm text-gray-500">
                          {item.category ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-sm font-bold text-gray-900 dark:text-white">
                          {item.quantity}
                        </td>
                        <td className="px-3 py-2 text-sm text-gray-500">
                          {item.reorderThreshold}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-500">
                          {formatDzd(item.unitPrice) ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-sm text-gray-500">
                          {item.location ?? "—"}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                              out
                                ? "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                                : critical
                                  ? "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                                  : low
                                    ? "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                                    : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                            }`}
                          >
                            {out
                              ? "Rupture"
                              : critical
                                ? "Stock critique"
                                : low
                                  ? "Stock bas"
                                  : "En réserve"}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                setRestockTarget(item);
                                setRestockQuantity("1");
                                setRestockReason("");
                                setRestockError("");
                              }}
                              className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                            >
                              <Plus className="h-3 w-3" aria-hidden="true" />
                              Réapprovisionner
                            </button>
                            {/*
                              La correction d'une fiche, distincte d'une entrée
                              de stock : un prix, une catégorie ou un seuil se
                              réécrivent sans toucher à la quantité. Deux
                              gestes dans une seule modale auraient laissé
                              croire qu'on peut changer les deux d'un coup.
                            */}
                            <button
                              type="button"
                              onClick={() => openEdit(item)}
                              className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2 py-1 text-[11px] font-semibold text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                            >
                              <Pencil className="h-3 w-3" aria-hidden="true" />
                              Modifier
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    );
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

  return (
    <div className="space-y-6">
      {tabsBar}

      <Card className="p-5">
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
                key={option.key || "toutes"}
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

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-gray-200 pt-4 dark:border-gray-800">
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {rows.length} demande{rows.length > 1 ? "s" : ""}
            {status === "PENDING"
              ? " à décider"
              : awaiting > 0
                ? ` · ${awaiting} en attente de décision`
                : ""}
          </span>

          <button
            type="button"
            onClick={() => void load({ silent: true })}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Actualiser
          </button>
        </div>

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

      {rows.length === 0 ? (
        <EmptyState
          icon={PackageSearch}
          title="Aucune demande de pièce"
          description="Une demande s'ouvre depuis une intervention, sur le terrain : le technicien signale la pièce manquante, le bureau la valide puis la commande."
          action={{
            label: "Voir les interventions",
            href: "/bons-de-travail",
            variant: "secondary",
          }}
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const isBusy = busyId === row.id;
            const immediate = row.urgency === "IMMEDIATE";

            return (
              <li key={row.id}>
                <Card
                  className={`p-4 ${
                    immediate
                      ? "border-red-300 dark:border-red-900"
                      : ""
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {immediate && (
                      <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                        Arrêt immédiat
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                        STATUS_BADGE[row.status] ?? STATUS_BADGE.REJECTED
                      }`}
                    >
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
                    {row.faultyPartReference ? (
                      <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                        {" "}
                        ({row.faultyPartReference})
                      </span>
                    ) : null}
                    <span className="text-gray-400"> → </span>
                    <span className="font-medium">
                      {row.replacementPartName}
                    </span>
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
                    · demandée par{" "}
                    {row.requestedBy?.name ?? "un compte supprimé"}
                  </p>

                  {/*
                    La réserve réelle, telle que le magasinier la vérifie.
                    `null` veut dire « pièce inconnue du magasin », et non
                    « zéro » : les deux mènent au même refus de réservation,
                    mais seul le second est une information.
                  */}
                  <p
                    className={`mt-2 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-bold ${
                      row.stockAvailable === null
                        ? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                        : row.stockAvailable >= row.quantity
                          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                          : "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                    }`}
                  >
                    📦{" "}
                    {row.stockAvailable === null
                      ? "Stock non suivi"
                      : `Stock en réserve : ${row.stockAvailable} unité${
                          row.stockAvailable > 1 ? "s" : ""
                        }`}
                    {row.stockLocation ? ` · ${row.stockLocation}` : ""}
                  </p>

                  {row.decisionNote && (
                    <p className="mt-1.5 text-xs font-medium text-red-700 dark:text-red-300">
                      Motif : {row.decisionNote}
                    </p>
                  )}

                  {row.notes && (
                    <p className="mt-1.5 whitespace-pre-line text-xs text-gray-600 dark:text-gray-400">
                      {row.notes}
                    </p>
                  )}

                  <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                    {row.statusChangedAt && row.status !== "PENDING"
                      ? `${enumLabel(row.status).toLowerCase()} le ${format(
                          new Date(row.statusChangedAt),
                          "d MMMM yyyy",
                          { locale: fr }
                        )}`
                      : "Aucune décision prise."}
                    {row.fulfilledAt
                      ? ` · posée le ${format(
                          new Date(row.fulfilledAt),
                          "d MMMM yyyy",
                          { locale: fr }
                        )}`
                      : ""}
                  </p>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {/*
                      Le bouton qui fait avancer la demande, selon l'état. Les
                      autres n'apparaissent que pour corriger une décision —
                      et `transitionRefusal` refuse ce qui n'aurait pas de sens,
                      ici comme sur la route.
                    */}
                    {/*
                      Le circuit du magasin : vérifier la réserve, réserver,
                      constater la rupture, ou refuser avec un motif.

                      « Approuver & réserver » est désactivé quand la réserve
                      ne suffit pas — le bouton dit pourquoi au survol, plutôt
                      que d'échouer après le clic.
                    */}
                    {(row.status === "PENDING" ||
                      row.status === "PENDING_STOCK_CHECK" ||
                      row.status === "ORDER_REQUIRED") && (
                      <>
                        <button
                          type="button"
                          disabled={
                            isBusy ||
                            row.stockAvailable === null ||
                            row.stockAvailable < row.quantity
                          }
                          title={
                            row.stockAvailable === null
                              ? "Pièce inconnue du magasin : passez la demande en commande."
                              : row.stockAvailable < row.quantity
                                ? `Stock insuffisant : ${row.stockAvailable} en réserve pour ${row.quantity} demandée(s).`
                                : undefined
                          }
                          onClick={() => void act(row, "reserve")}
                          className={PRIMARY}
                        >
                          {isBusy ? (
                            <Loader2
                              className="h-3.5 w-3.5 animate-spin"
                              aria-hidden="true"
                            />
                          ) : (
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          Approuver &amp; réserver
                        </button>
                        {row.status !== "ORDER_REQUIRED" && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void act(row, "order")}
                            className={SECONDARY}
                          >
                            🛒 Rupture — passer en commande
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => {
                            setRejectTarget(row);
                            setRejectReason("");
                          }}
                          className={QUIET}
                        >
                          ❌ Refuser
                        </button>
                      </>
                    )}

                    {row.status === "RESERVED" && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          void decide(row, "FULFILLED", "pièce posée")
                        }
                        className={PRIMARY}
                      >
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        Marquer la pièce posée
                      </button>
                    )}

                    {row.status === "APPROVED" && (
                      <>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void decide(row, "ORDERED", "commande passée")}
                          className={PRIMARY}
                        >
                          {isBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <PackageSearch className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          Commander
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void decide(row, "FULFILLED", "pièce posée")}
                          className={SECONDARY}
                        >
                          Posée sans commande
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void decide(row, "REJECTED", "demande refusée")}
                          className={QUIET}
                        >
                          Refuser
                        </button>
                      </>
                    )}

                    {row.status === "ORDERED" && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void decide(row, "FULFILLED", "pièce posée")}
                        className={PRIMARY}
                      >
                        {isBusy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        Valider la livraison
                      </button>
                    )}

                    {row.status === "REJECTED" && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void decide(row, "PENDING", "demande rouverte")}
                        className={SECONDARY}
                      >
                        Rouvrir la demande
                      </button>
                    )}

                    {row.status !== "PENDING" && row.status !== "REJECTED" && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void decide(row, "PENDING", "décision retirée")}
                        className={QUIET}
                      >
                        Revenir en attente
                      </button>
                    )}

                    {/*
                      Le passage à l'offre n'existe qu'une fois la demande
                      validée : on ne chiffre pas une pièce que le bureau n'a
                      pas encore acceptée. Une fois le devis créé, le bouton
                      devient le lien vers la fiche à chiffrer.
                    */}
                    {(row.status === "PENDING" ||
                      row.status === "APPROVED" ||
                      row.status === "ORDERED") &&
                      (quoteResults[row.id] ? (
                        quoteResults[row.id].id ? (
                          <Link
                            href={`/administration/devis/${quoteResults[row.id].id}`}
                            className={SECONDARY}
                          >
                            <FileText
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />
                            Devis {quoteResults[row.id].number}
                          </Link>
                        ) : (
                          // Démonstration : le devis n'a pas de fiche à ouvrir.
                          <span className={`${SECONDARY} opacity-70`}>
                            <FileText
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />
                            Devis {quoteResults[row.id].number} (démo)
                          </span>
                        )
                      ) : (
                        <button
                          type="button"
                          disabled={quotingId === row.id}
                          onClick={() => void createQuoteForPart(row)}
                          className={SECONDARY}
                        >
                          {quotingId === row.id ? (
                            <Loader2
                              className="h-3.5 w-3.5 animate-spin"
                              aria-hidden="true"
                            />
                          ) : (
                            <FileText
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />
                          )}
                          Créer le devis
                        </button>
                      ))}

                    <a
                      href={`/api/parts-replacement/${row.id}/pdf`}
                      className={`${SECONDARY} ml-auto`}
                    >
                      <Printer className="h-3.5 w-3.5" aria-hidden="true" />
                      Imprimer la fiche
                    </a>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {/*
        Le motif de refus est obligatoire, et il est saisi ici plutôt que dans
        un `prompt()` du navigateur : le message doit rester lisible, modifiable
        et annulable, et un refus muet renvoie le technicien au téléphone.
      */}
      {rejectTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="reject-heading"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRejectTarget(null);
          }}
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-gray-900">
            <h2
              id="reject-heading"
              className="text-lg font-bold text-gray-900 dark:text-white"
            >
              Refuser la demande
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {rejectTarget.replacementPartName} ×{rejectTarget.quantity} ·{" "}
              {rejectTarget.number}
            </p>

            <label className="mt-4 block">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Motif du refus (obligatoire)
              </span>
              <textarea
                rows={3}
                maxLength={2000}
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                placeholder="Réf. obsolète, incompatible avec l'appareil…"
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-white"
              />
            </label>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRejectTarget(null)}
                className={SECONDARY}
              >
                Annuler
              </button>
              <button
                type="button"
                disabled={
                  busyId === rejectTarget.id || rejectReason.trim().length === 0
                }
                onClick={() =>
                  void act(rejectTarget, "reject", rejectReason.trim())
                }
                className={`${ACTION} bg-red-600 font-semibold text-white hover:bg-red-700`}
              >
                {busyId === rejectTarget.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : null}
                Refuser la demande
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
