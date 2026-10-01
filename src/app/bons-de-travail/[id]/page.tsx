"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  Calendar,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Download,
  ExternalLink,
  FileText,
  History,
  Loader2,
  MapPin,
  Package,
  Receipt,
  Undo2,
  User,
  Wrench,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { enumLabel } from "@/lib/ui/enum-labels";
import { formatDzd, parseDzdInput } from "@/lib/ui/money";
import { MANAGEMENT_ROLES } from "@/types";

/**
 * La fiche d'un bon de travail, et la validation du rapport du technicien.
 *
 * POURQUOI CETTE PAGE EXISTE
 * Le portail du technicien dépose un rapport et passe le bon en
 * `PENDING_APPROVAL`. Jusqu'ici rien ne le lisait : la colonne « À valider » du
 * tableau montrait une carte, et il n'existait aucun écran pour l'ouvrir. Une
 * file d'attente qu'on ne peut pas ouvrir est une file qu'on ne vide pas.
 *
 * C'est aussi la première fiche de bon du produit — les autres pages de détail
 * portent sur un ascenseur ou un rapport d'inspection. Elle est donc écrite pour
 * servir de base à n'importe quel bon, pas seulement à ceux en attente : une
 * carte du tableau y renvoie quel que soit son statut, et une fois le bon
 * clôturé la page reste le dossier de ce qui a été fait.
 *
 * CE QUE LA PAGE NE FAIT PAS
 * Elle n'affiche pas le rapport d'inspection lui-même — checklist, photos,
 * signature. Ce document existe déjà, il est imprimable, et il vit sur
 * `/rapports-inspection/[id]`. Le reconstruire ici en donnerait deux versions
 * qui divergeraient à la première évolution. La fiche y renvoie.
 *
 * LE MONTANT EST CORRIGEABLE, ET LA CORRECTION EST ÉCRITE
 * Le bureau peut modifier la description, le caractère facturable et le montant
 * avant de décider. C'est nécessaire — un technicien qui saisit 185000 au lieu
 * de 18500 ne doit pas faire refaire tout le rapport — et ce n'est défendable
 * que parce que `WorkOrderRevision` garde l'ancienne valeur et le nom de qui l'a
 * changée. Le bandeau ambre signale la correction en cours de frappe, pour que
 * personne ne la découvre après coup dans un journal.
 */

const REPORT_DESCRIPTION_MAX = 5000;

interface WorkOrderRevisionRow {
  id: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  note: string | null;
  createdAt: string;
  author: { id: string; name: string | null } | null;
}

interface WorkOrderDetail {
  id: string;
  orderNumber: string;
  title: string;
  description: string | null;
  type: string;
  priority: string;
  status: string;
  notes: string | null;
  partsReplaced: Array<{ name: string; partNumber?: string; qty: number }> | null;
  isBillable: boolean;
  invoiceAmount: string | number | null;
  reportSubmittedAt: string | null;
  completedAt: string | null;
  startedAt: string | null;
  arrivedAt: string | null;
  actualHours: number | null;
  elevator: {
    id: string;
    elevatorCode: string;
    model: string;
    brand: string;
    floorsServed: number;
    status: string;
    nextMaintenance: string | null;
    building: {
      id: string;
      name: string;
      address: string;
      city: string;
      contactPerson: string;
      contactPhone: string | null;
    };
  };
  assignedTo: { id: string; name: string | null; email: string | null } | null;
  component: { name: string; componentType: string } | null;
  incident: {
    id: string;
    incidentNumber: string;
    status: string;
    isDirectTransfer: boolean;
    errorCode: { code: string; title: string } | null;
  } | null;
  inspectionReports: Array<{
    id: string;
    reportNumber: string;
    title: string;
    overallResult: string;
    submittedAt: string;
  }>;
  revisions: WorkOrderRevisionRow[];
  invoice: {
    id: string;
    number: string;
    issuedAt: string;
    amount: string | number;
    currency: string;
  } | null;
}

/** Couleurs de statut, alignées sur les colonnes du tableau. */
const STATUS_STYLES: Record<string, string> = {
  OPEN: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  ASSIGNED: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  IN_PROGRESS:
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300",
  PENDING_APPROVAL:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  ON_HOLD:
    "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  COMPLETED:
    "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  CANCELLED: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
};

const PRIORITY_STYLES: Record<string, string> = {
  LOW: "text-gray-500 dark:text-gray-400",
  MEDIUM: "text-blue-600 dark:text-blue-400",
  HIGH: "text-orange-600 dark:text-orange-400",
  EMERGENCY: "text-red-600 dark:text-red-400",
  CRITICAL: "text-red-700 dark:text-red-400 font-semibold",
};

/**
 * Ce qu'un champ du journal s'appelle à l'écran.
 *
 * Les clés sont les noms de colonnes stockés dans `WorkOrderRevision.field`, et
 * ils ne sont pas traduits en base : la traduction vit ici, comme celle des
 * énumérations vit dans `enum-labels.ts`, pour qu'une valeur ajoutée au schéma
 * ne casse pas une chronologie déjà écrite.
 */
const REVISION_FIELD_LABELS: Record<string, string> = {
  notes: "Rapport d'intervention",
  isBillable: "Facturation",
  invoiceAmount: "Montant à facturer",
  partsReplaced: "Pièces remplacées",
};

function formatDateTime(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Le texte d'une valeur du journal, rendu lisible. */
function revisionValue(field: string, value: string | null): string {
  if (field === "isBillable") return value === "true" ? "Facturable" : "Non facturable";
  if (field === "invoiceAmount") return formatDzd(value) ?? "aucun montant";
  if (field === "partsReplaced") return value ?? "aucune pièce";
  return value ?? "—";
}

function Fact({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Clock;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {label}
        </p>
        <p className="text-sm text-gray-900 dark:text-white break-words">{value}</p>
      </div>
    </div>
  );
}

/**
 * Une entrée de la chronologie.
 *
 * Le renvoi au technicien a sa propre mise en forme plutôt qu'une ligne
 * « PENDING_APPROVAL → IN_PROGRESS » : ce sont deux identifiants de statut, et
 * l'information utile est le motif écrit par le bureau, pas la transition. Un
 * lecteur qui découvre le dossier six mois plus tard veut lire « le bureau a
 * demandé de reprendre le réglage », pas le nom interne de deux états.
 */
function RevisionEntry({ row }: { row: WorkOrderRevisionRow }) {
  const when = formatDateTime(row.createdAt);

  if (row.field === "status") {
    return (
      <li className="relative pl-7">
        <span className="absolute left-0 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-orange-100 dark:bg-orange-900/40">
          <Undo2 className="h-3 w-3 text-orange-600 dark:text-orange-400" />
        </span>
        <p className="text-sm font-medium text-gray-900 dark:text-white">
          Rapport renvoyé au technicien
        </p>
        {row.note && (
          <p className="mt-1 whitespace-pre-wrap rounded-lg bg-orange-50 px-3 py-2 text-sm text-orange-900 dark:bg-orange-900/20 dark:text-orange-200">
            {row.note}
          </p>
        )}
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {row.author?.name ?? "Compte supprimé"} · {when}
        </p>
      </li>
    );
  }

  return (
    <li className="relative pl-7">
      <span className="absolute left-0 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40">
        <FileText className="h-3 w-3 text-amber-600 dark:text-amber-400" />
      </span>
      <p className="text-sm font-medium text-gray-900 dark:text-white">
        {REVISION_FIELD_LABELS[row.field] ?? row.field}
      </p>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
        <span className="text-gray-400 line-through">
          {revisionValue(row.field, row.oldValue)}
        </span>
        <span className="mx-1.5 text-gray-400">→</span>
        <span className="font-medium text-gray-900 dark:text-white">
          {revisionValue(row.field, row.newValue)}
        </span>
      </p>
      {row.note && (
        <p className="mt-1 text-xs italic text-gray-500 dark:text-gray-400">
          {row.note}
        </p>
      )}
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {row.author?.name ?? "Compte supprimé"} · {when}
      </p>
    </li>
  );
}

export default function WorkOrderDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { data: session } = useSession();
  const role = session?.user?.role;
  const canDecide = role !== undefined && MANAGEMENT_ROLES.includes(role);

  const [data, setData] = useState<WorkOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  /**
   * Le rapport tel qu'il est en cours d'édition dans le formulaire.
   *
   * `baseline` garde les valeurs telles qu'elles sont en base. C'est ce qui
   * permet à la page de dire « vous êtes en train de corriger » plutôt que de
   * l'affirmer en permanence : sans point de comparaison, un formulaire ne sait
   * pas s'il a été modifié.
   */
  const [description, setDescription] = useState("");
  const [isBillable, setIsBillable] = useState(false);
  const [amount, setAmount] = useState("");
  const [baseline, setBaseline] = useState<{
    description: string;
    isBillable: boolean;
    amount: number | null;
  } | null>(null);

  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch(`/api/work-orders/${id}`);
      if (res.status === 404) throw new Error("Bon de travail introuvable");
      if (!res.ok) throw new Error(`La fiche a renvoyé ${res.status}`);
      const json = await res.json();
      setData(json.data);
    } catch (e) {
      setLoadError(
        e instanceof Error ? e.message : "Impossible de charger le bon de travail"
      );
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Le formulaire suit la donnée chargée. Il la suit aussi après une décision,
  // ce qui est le comportement voulu : la page recharge, le bon n'est plus en
  // attente, et le formulaire se fige sur ce qui vient d'être enregistré.
  useEffect(() => {
    if (!data) return;
    setDescription(data.notes ?? "");
    setIsBillable(data.isBillable);
    setAmount(data.invoiceAmount === null ? "" : String(data.invoiceAmount));
    setBaseline({
      description: (data.notes ?? "").trim(),
      isBillable: data.isBillable,
      amount: data.invoiceAmount === null ? null : Number(data.invoiceAmount),
    });
  }, [data]);

  const isPending = data?.status === "PENDING_APPROVAL";
  const editable = isPending && canDecide;

  const amountValue = parseDzdInput(amount);
  const corrected: string[] = [];
  if (editable && baseline) {
    if (description.trim() !== baseline.description) {
      corrected.push("le rapport d’intervention");
    }
    if (isBillable !== baseline.isBillable) {
      corrected.push("le caractère facturable");
    } else if (isBillable && amountValue !== baseline.amount) {
      corrected.push("le montant à facturer");
    }
  }

  const submit = async (choice: "approve" | "reject") => {
    if (!data) return;

    const trimmed = description.trim();
    if (trimmed === "") {
      setActionError("Le rapport doit décrire les travaux effectués.");
      return;
    }
    let invoiceAmount: number | null = null;
    if (isBillable) {
      if (amountValue === null) {
        setActionError(
          "Indiquez le montant à facturer, ou décochez « intervention payante »."
        );
        return;
      }
      invoiceAmount = Math.round(amountValue * 100) / 100;
    }
    if (choice === "reject" && reason.trim() === "") {
      setActionError("Indiquez au technicien ce qu'il doit corriger.");
      return;
    }

    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      const body: Record<string, unknown> = {
        notes: trimmed,
        isBillable,
        invoiceAmount: isBillable ? invoiceAmount : null,
        status: choice === "approve" ? "COMPLETED" : "IN_PROGRESS",
      };
      if (choice === "reject") body.rejectionReason = reason.trim();

      const res = await fetch(`/api/work-orders?id=${data.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error ?? "Échec de l'enregistrement de la décision");
      }

      setDecision(null);
      setReason("");
      setNotice(
        choice === "approve"
          ? "Bon clôturé. Le technicien a été libéré et le montant est prêt à facturer."
          : "Rapport renvoyé au technicien, avec le motif à corriger."
      );
      await load();
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "Échec de l'enregistrement de la décision"
      );
    } finally {
      setBusy(false);
    }
  };

  /**
   * Émet la facture d'un bon clos.
   *
   * Sert au rattrapage : dans le cas normal la facture existe déjà, émise au
   * moment de la validation. La route est idempotente, donc ce bouton ne peut
   * pas produire de doublon même pressé deux fois.
   */
  const issueInvoice = async () => {
    if (!data) return;
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      const res = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workOrderId: data.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error ?? "L'émission de la facture a échoué.");
      }
      setNotice(
        json?.data?.number ? `Facture ${json.data.number} émise.` : "Facture émise."
      );
      await load();
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "L'émission de la facture a échoué."
      );
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="p-6 max-w-5xl mx-auto space-y-4">
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  if (loadError && !data) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <ErrorState message={loadError} onRetry={load} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <EmptyState
          title="Bon de travail introuvable"
          hint="Il a peut-être été supprimé, ou le lien est incomplet."
        />
      </div>
    );
  }

  const reception = formatDateTime(data.reportSubmittedAt);
  const closure = formatDateTime(data.completedAt);
  const amountLabel = formatDzd(data.invoiceAmount);
  const parts = data.partsReplaced ?? [];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <Link
        href="/bons-de-travail"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" />
        Bons de travail
      </Link>

      {/* ── En-tête ───────────────────────────────────────────── */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-xs text-gray-500 dark:text-gray-400">
              {data.orderNumber}
            </p>
            <h1 className="mt-1 text-xl font-bold text-gray-900 dark:text-white">
              {data.title}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                STATUS_STYLES[data.status] ?? STATUS_STYLES.OPEN
              }`}
            >
              {enumLabel(data.status)}
            </span>
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
              {enumLabel(data.type)}
            </span>
            <span
              className={`text-xs font-medium ${
                PRIORITY_STYLES[data.priority] ?? PRIORITY_STYLES.MEDIUM
              }`}
            >
              Priorité {enumLabel(data.priority).toLowerCase()}
            </span>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Fact
            icon={MapPin}
            label="Site"
            value={
              <>
                {data.elevator.building.name}
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  {data.elevator.building.address}, {data.elevator.building.city}
                </span>
              </>
            }
          />
          <Fact
            icon={Wrench}
            label="Appareil"
            value={
              <>
                <span className="font-mono">{data.elevator.elevatorCode}</span>
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  {enumLabel(data.elevator.brand)} {data.elevator.model}
                  {data.component
                    ? ` · ${enumLabel(data.component.componentType)}`
                    : ""}
                </span>
              </>
            }
          />
          <Fact
            icon={User}
            label="Technicien"
            value={
              data.assignedTo?.name ?? (
                <span className="text-gray-500">Non affecté</span>
              )
            }
          />
          {data.component && (
            <Fact icon={Wrench} label="Composant visé" value={data.component.name} />
          )}
          {data.arrivedAt && (
            <Fact
              icon={Clock}
              label="Arrivée sur site"
              value={formatDateTime(data.arrivedAt)}
            />
          )}
          {reception && (
            <Fact icon={ClipboardCheck} label="Rapport reçu" value={reception} />
          )}
          {closure && <Fact icon={CheckCircle2} label="Clôturé le" value={closure} />}
          {data.elevator.nextMaintenance && (
            <Fact
              icon={Calendar}
              label="Prochain entretien"
              value={new Date(data.elevator.nextMaintenance).toLocaleDateString(
                "fr-FR",
                { day: "2-digit", month: "long", year: "numeric" }
              )}
            />
          )}
        </div>
      </Card>

      {notice && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-900/20 dark:text-green-200"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          {notice}
        </p>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {/* ── Rapport du technicien ─────────────────────────── */}
          <Card className="p-5">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-gray-400" />
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">
                Rapport du technicien
              </h2>
            </div>

            {data.description && (
              <div className="mt-4 rounded-lg bg-gray-50 p-3 dark:bg-gray-800/50">
                <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Demande initiale
                </p>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                  {data.description}
                </p>
              </div>
            )}

            <div className="mt-4 space-y-2">
              <label
                htmlFor="report-description"
                className="block text-xs font-medium text-gray-600 dark:text-gray-300"
              >
                Travaux effectués
              </label>
              <textarea
                id="report-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                readOnly={!editable}
                rows={6}
                maxLength={REPORT_DESCRIPTION_MAX}
                placeholder="Le technicien n'a pas encore décrit les travaux."
                className={`w-full rounded-lg border px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:outline-none ${
                  editable
                    ? "border-gray-300 bg-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950"
                    : "border-transparent bg-gray-50 dark:bg-gray-800/50"
                }`}
              />
            </div>

            {/* ── Pièces ─────────────────────────────────────── */}
            <div className="mt-5">
              <div className="flex items-center gap-2">
                <Package className="h-4 w-4 text-gray-400" />
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                  Pièces remplacées
                </h3>
              </div>
              {parts.length === 0 ? (
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  Aucune pièce déclarée sur ce rapport.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-800">
                  {parts.map((part, index) => (
                    <li
                      key={`${part.name}-${index}`}
                      className="flex items-baseline justify-between gap-3 py-2"
                    >
                      <span className="text-sm text-gray-900 dark:text-white">
                        {part.name}
                        {part.partNumber && (
                          <span className="ml-2 font-mono text-xs text-gray-500 dark:text-gray-400">
                            {part.partNumber}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-sm tabular-nums text-gray-600 dark:text-gray-300">
                        ×{part.qty}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* ── Facturation ────────────────────────────────── */}
            <div className="mt-5 border-t border-gray-100 pt-4 dark:border-gray-800">
              <div className="flex items-center gap-2">
                <Banknote className="h-4 w-4 text-gray-400" />
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                  Facturation
                </h3>
              </div>

              {editable ? (
                <div className="mt-3 space-y-3">
                  <label
                    htmlFor="report-billable"
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-800"
                  >
                    <input
                      id="report-billable"
                      type="checkbox"
                      checked={isBillable}
                      onChange={(e) => setIsBillable(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-sm font-medium text-gray-900 dark:text-white">
                      Intervention payante
                    </span>
                  </label>

                  {isBillable && (
                    <div className="space-y-1.5">
                      <label
                        htmlFor="report-amount"
                        className="block text-xs font-medium text-gray-600 dark:text-gray-300"
                      >
                        Montant total à facturer (DZD)
                      </label>
                      <input
                        id="report-amount"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        inputMode="decimal"
                        placeholder="18500"
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm tabular-nums text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      />
                    </div>
                  )}
                </div>
              ) : (
                <p className="mt-2 text-sm">
                  {data.isBillable ? (
                    <>
                      <span className="font-medium text-gray-900 dark:text-white">
                        {amountLabel ?? "Montant non renseigné"}
                      </span>
                      <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                        à facturer au client
                      </span>
                    </>
                  ) : (
                    <span className="text-gray-500 dark:text-gray-400">
                      Intervention couverte par le contrat — rien à facturer.
                    </span>
                  )}
                </p>
              )}
            </div>
          </Card>

          {/* ── Rapport d'inspection ──────────────────────────── */}
          <Card className="p-5">
            <div className="flex items-center gap-2">
              <ClipboardCheck className="h-4 w-4 text-gray-400" />
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">
                Rapport d&apos;inspection
              </h2>
            </div>
            {data.inspectionReports.length === 0 ? (
              <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
                Aucun rapport d&apos;inspection n&apos;est rattaché à ce bon. Le
                technicien a décrit son intervention sans passer de checklist.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {data.inspectionReports.map((report) => (
                  <li key={report.id}>
                    <Link
                      href={`/rapports-inspection/${report.id}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2.5 hover:border-blue-400 hover:bg-blue-50/50 dark:border-gray-800 dark:hover:border-blue-700 dark:hover:bg-blue-900/10"
                    >
                      <span className="min-w-0">
                        <span className="block font-mono text-xs text-gray-500 dark:text-gray-400">
                          {report.reportNumber}
                        </span>
                        <span className="block text-sm text-gray-900 dark:text-white">
                          {report.title}
                        </span>
                        <span className="block text-xs text-gray-500 dark:text-gray-400">
                          Résultat : {enumLabel(report.overallResult)} ·{" "}
                          {formatDateTime(report.submittedAt)}
                        </span>
                      </span>
                      <ExternalLink className="h-4 w-4 shrink-0 text-gray-400" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* ── Facture ───────────────────────────────────────── */}
          {(data.invoice || (data.status === "COMPLETED" && data.isBillable)) && (
            <Card className="p-5">
              <div className="flex items-center gap-2">
                <Receipt className="h-4 w-4 text-gray-400" aria-hidden="true" />
                <h2 className="text-base font-semibold text-gray-900 dark:text-white">
                  Facture
                </h2>
              </div>

              {data.invoice ? (
                <>
                  <div className="mt-3 flex flex-wrap items-baseline justify-between gap-3">
                    <div>
                      <p className="font-mono text-sm font-medium text-gray-900 dark:text-white">
                        {data.invoice.number}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        Émise le {formatDateTime(data.invoice.issuedAt)}
                      </p>
                    </div>
                    <p className="text-lg font-semibold tabular-nums text-gray-900 dark:text-white">
                      {formatDzd(data.invoice.amount) ?? "—"}
                    </p>
                  </div>

                  <a
                    href={`/api/invoices/${data.invoice.id}/pdf`}
                    className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
                  >
                    <Download className="h-4 w-4" aria-hidden="true" />
                    Télécharger la facture
                  </a>
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    Le document reprend les valeurs figées à l&apos;émission. Une
                    correction ultérieure du bon ne le modifie pas.
                  </p>
                </>
              ) : (
                <>
                  {/* Ce cas ne devrait pas durer : la facture s'émet à la
                      clôture. S'il est visible, c'est que l'émission a échoué —
                      base momentanément injoignable, par exemple — et le bon
                      reste facturable sans facture. Le dire, et permettre de
                      réparer, vaut mieux que de laisser un bon clos dont
                      personne ne saura qu'il n'a jamais été facturé. */}
                  <p className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
                    <AlertTriangle
                      className="mt-0.5 h-4 w-4 shrink-0"
                      aria-hidden="true"
                    />
                    Ce bon est clôturé et facturable, mais aucune facture
                    n&apos;a été émise.
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void issueInvoice()}
                    className="mt-3 inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                  >
                    {busy ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Receipt className="h-4 w-4" aria-hidden="true" />
                    )}
                    Émettre la facture
                  </button>
                </>
              )}
            </Card>
          )}

          {/* ── Chronologie ───────────────────────────────────── */}
          <Card className="p-5">
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-gray-400" />
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">
                Corrections du bureau
              </h2>
            </div>
            {data.revisions.length === 0 ? (
              <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
                Aucune correction : le rapport est tel que le technicien l&apos;a
                déposé.
              </p>
            ) : (
              <ul className="mt-4 space-y-4 border-l border-gray-200 dark:border-gray-800">
                {data.revisions.map((row) => (
                  <RevisionEntry key={row.id} row={row} />
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* ── Décision ────────────────────────────────────────── */}
        <div className="lg:col-span-1">
          <Card className="p-5 lg:sticky lg:top-6">
            {isPending && canDecide ? (
              <>
                <h2 className="text-base font-semibold text-gray-900 dark:text-white">
                  Valider le rapport
                </h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {reception
                    ? `Reçu le ${reception}`
                    : "Rapport reçu, horodatage indisponible"}
                </p>

                <dl className="mt-4 space-y-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-sm text-gray-500 dark:text-gray-400">
                      Technicien
                    </dt>
                    <dd className="text-sm font-medium text-gray-900 dark:text-white">
                      {data.assignedTo?.name ?? "—"}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-sm text-gray-500 dark:text-gray-400">
                      À facturer
                    </dt>
                    <dd className="text-sm font-medium tabular-nums text-gray-900 dark:text-white">
                      {isBillable
                        ? amountLabel ?? "à compléter"
                        : "Non facturable"}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-sm text-gray-500 dark:text-gray-400">
                      Pièces
                    </dt>
                    <dd className="text-sm tabular-nums text-gray-900 dark:text-white">
                      {parts.length === 0
                        ? "aucune"
                        : `${parts.length} ligne${parts.length > 1 ? "s" : ""}`}
                    </dd>
                  </div>
                </dl>

                {corrected.length > 0 && (
                  <p className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Vous modifiez {corrected.join(", ")}. La correction sera
                      enregistrée à votre nom, avec la valeur d&apos;origine du
                      technicien.
                    </span>
                  </p>
                )}

                {(actionError || loadError) && (
                  <p
                    role="alert"
                    className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-900/20 dark:text-red-300"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    {actionError || loadError}
                  </p>
                )}

                {decision === "reject" && (
                  <div className="mt-4 space-y-1.5">
                    <label
                      htmlFor="rejection-reason"
                      className="block text-xs font-medium text-gray-600 dark:text-gray-300"
                    >
                      Ce que le technicien doit corriger
                    </label>
                    <textarea
                      id="rejection-reason"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      rows={4}
                      maxLength={2000}
                      autoFocus
                      placeholder="Le montant ne correspond pas au devis signé ; reprendre le relevé des pièces."
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                    />
                    <p className="text-[11px] text-gray-400">
                      Ce motif lui est notifié, et reste attaché au bon.
                    </p>
                  </div>
                )}

                <div className="mt-5 space-y-2">
                  {decision === null && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setActionError("");
                          setDecision("approve");
                        }}
                        className="flex w-full items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-green-700"
                      >
                        <CheckCircle2 className="h-4 w-4" />
                        Valider et clôturer
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setActionError("");
                          setDecision("reject");
                        }}
                        className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                      >
                        <Undo2 className="h-4 w-4" />
                        Renvoyer au technicien
                      </button>
                    </>
                  )}

                  {decision === "approve" && (
                    <div className="space-y-2 rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-900 dark:bg-green-900/20">
                      <p className="text-sm font-medium text-green-900 dark:text-green-200">
                        Clôturer ce bon ?
                      </p>
                      <p className="text-xs text-green-800 dark:text-green-300">
                        Un bon clôturé ne peut plus changer de statut. Les
                        corrections que vous venez de faire sont enregistrées en
                        même temps.
                      </p>
                      <div className="flex gap-2 pt-1">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => submit("approve")}
                          className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-green-600 px-3 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
                        >
                          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                          {busy ? "Enregistrement…" : "Confirmer"}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setDecision(null)}
                          className="rounded-lg bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200"
                        >
                          Annuler
                        </button>
                      </div>
                    </div>
                  )}

                  {decision === "reject" && (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => submit("reject")}
                        className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-orange-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
                      >
                        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                        {busy ? "Envoi…" : "Renvoyer le rapport"}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setDecision(null);
                          setReason("");
                        }}
                        className="rounded-lg border border-gray-300 px-3 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                      >
                        Annuler
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <h2 className="text-base font-semibold text-gray-900 dark:text-white">
                  {isPending ? "En attente de validation" : "Dossier du bon"}
                </h2>
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  {isPending && !canDecide
                    ? "Seuls les responsables et les administrateurs peuvent valider un rapport."
                    : data.status === "COMPLETED"
                      ? `Bon clôturé${closure ? ` le ${closure}` : ""}. Il ne peut plus changer de statut.`
                      : data.status === "CANCELLED"
                        ? "Bon annulé."
                        : "Ce bon n'est pas en attente de validation. Il reprendra la file de validation une fois le rapport du technicien déposé."}
                </p>

                {data.status === "COMPLETED" && (
                  <p className="mt-4 flex items-start gap-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-900/20 dark:text-green-200">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    {data.isBillable
                      ? `Montant validé : ${amountLabel ?? "non renseigné"}.`
                      : "Intervention non facturable."}
                  </p>
                )}

                {(actionError || loadError) && (
                  <p
                    role="alert"
                    className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-900/20 dark:text-red-300"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    {actionError || loadError}
                  </p>
                )}
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
