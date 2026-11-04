"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Building2,
  ChevronRight,
  ExternalLink,
  FileText,
  Gauge,
  History,
  Info,
  KeyRound,
  Link2,
  Loader2,
  Mail,
  MapPin,
  Package,
  Phone,
  Plus,
  QrCode,
  Receipt,
  RefreshCw,
  Send,
  ShieldCheck,
  Unlink,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { CopyButton } from "@/components/admin/credentials-panel";
import { enumLabel } from "@/lib/ui/enum-labels";
import { parseDecimalInput } from "@/lib/ui/numbers";
import { formatDzd } from "@/lib/ui/money";
import { formatDa } from "@/lib/quotes/totals";
import type { CoverageContract } from "@/lib/contracts/coverage";
import {
  CLIENT_TYPE_LABELS,
  CONTROLLER_TYPES,
  ELEVATOR_BRANDS,
  MOTOR_TYPES,
  OPEN_INCIDENT_STATUSES,
  SLA_TIERS,
} from "@/types";
import type { ClientType } from "@/types";

/**
 * Fiche d'un compte client : son parc, ses appareils, son accès.
 *
 * POURQUOI CET ÉCRAN EXISTE
 * L'ouverture d'un compte ne dit qu'une chose : qui est le client. Tout le reste
 * — l'adresse d'un site, son contact, la position GPS qui sert au contrôle de
 * distance des pointages, les ascenseurs et leurs caractéristiques — arrive
 * après, au rythme des visites. Sans cet écran, la seule façon de compléter un
 * dossier était `POST /api/buildings` à la main, et la page `/ascenseurs` le dit
 * elle-même : « Enregistrez des ascenseurs via POST /api/elevators ».
 *
 * ON N'Y CRÉE PAS D'ASCENSEUR SANS SES CARACTÉRISTIQUES
 * Le formulaire les demande toutes. Ce n'est pas de la rigidité : les seuils
 * d'alerte, le calcul de durée de vie des pièces et le moteur prédictif lisent
 * la marque, le moteur, la charge et le nombre de niveaux. Une valeur inventée
 * pour remplir un champ produirait des alertes calculées sur du faux, ce que le
 * mode démonstration de ce produit refuse déjà par principe.
 *
 * TROIS ONGLETS, PARCE QUE LA FICHE PORTE TROIS MÉTIERS
 *  - « Informations & Contrats » : l'identité du client et de son responsable
 *    de site, le contrat en cours, ses engagements SLA, ses pièces jointes
 *    téléchargeables, puis l'administration de son accès au portail.
 *  - « Équipements rattachés » : la liste des ascenseurs avec leur matricule,
 *    leur immeuble, leur marque, leur modèle, leur date d'installation et leur
 *    état — et les gestes de gestion du parc.
 *  - « Registre d'archivage » : l'historique complet des interventions
 *    (pannes et entretiens) et la traçabilité des pièces remplacées.
 * Une seule colonne aurait obligé à faire défiler trois sujets sans rapport
 * pour atteindre le troisième ; les onglets disent d'emblée ce que la fiche
 * contient.
 *
 * CE QU'ON PEUT FAIRE ICI
 *  - créer un immeuble pour ce client (adresse, contact, GPS, palier de service)
 *  - lui rattacher un immeuble déjà en base, y compris détenu par un autre
 *  - détacher un immeuble, sans jamais le supprimer
 *  - ajouter un ascenseur à un immeuble
 *  - activer ou suspendre son accès au portail
 *  - préparer une invitation (mot de passe provisoire, WhatsApp, e-mail)
 *
 * SANS BASE, LA FICHE EST SERVIE PAR LA FIXTURE
 * `GET /api/clients/:id` renvoie `demo: true` et la fiche complète du jeu de
 * démonstration. L'écran l'annonce en tête et n'offre que les lectures : les
 * écritures (rattachement, création, suspension) demandent PostgreSQL, et le
 * bandeau le dit plutôt que de laisser cliquer sur un bouton qui échoue.
 */

// ─── Types ──────────────────────────────────────────────────

interface ElevatorRow {
  id: string;
  elevatorCode: string;
  brand: string;
  model: string;
  serialNumber: string | null;
  motorType: string;
  controllerType: string;
  floorsServed: number;
  maxPayloadKg: number;
  installationDate: string | null;
  /** Complément d'adresse : bâtiment, cage, étage. */
  installationLocation: string | null;
  status: string;
  overallHealth: number;
  nextMaintenance: string | null;
}

interface BuildingRow {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string | null;
  zipCode: string | null;
  contactPerson: string;
  contactEmail: string | null;
  contactPhone: string | null;
  slaTier: string;
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusM: number | null;
  elevators: ElevatorRow[];
}

interface ClientDetail {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  address: string | null;
  clientType: ClientType | null;
  isActive: boolean;
  createdAt: string;
  ownedBuildings: BuildingRow[];
}

interface AttachableRow {
  id: string;
  name: string;
  address: string;
  city: string;
  owner: { id: string; name: string } | null;
  elevatorCount: number;
}

/**
 * L'état des accès, quand le serveur le fournit.
 *
 * La route réelle ne le renvoie pas — l'écran lit alors l'e-mail du compte et
 * son indicateur d'activité, comme avant. Le repli de démonstration, lui, le
 * rend explicitement : sans base, on ne peut pas déduire d'un compte qu'il peut
 * ouvrir une session, et l'écran ne doit pas le supposer.
 */
interface AccessState {
  email: string;
  clientType: ClientType | null;
  isActive: boolean;
  canSignIn: boolean;
  passwordReissueAvailable: boolean;
}

/** Une panne telle que la liste et l'historique d'un appareil la lisent. */
interface IncidentRow {
  id: string;
  incidentNumber: string;
  status: string;
  notes: string | null;
  createdAt: string;
  resolvedAt: string | null;
  elevator: {
    id: string;
    elevatorCode: string;
    building: { id: string; name: string };
  };
}

interface QuoteRow {
  id: string;
  number: string;
  status: string;
  createdAt: string;
  need: string;
  building: { name: string };
  elevator: { elevatorCode: string } | null;
  clientId: string | null;
  lineCount?: number;
  totals?: { totalHt: number; vatAmount: number; totalTtc: number };
}

interface InvoiceRow {
  id: string;
  number: string;
  issuedAt: string;
  amount: string | number;
  currency: string;
  orderNumber: string;
  buildingName: string;
  clientId: string | null;
  status: string;
}

/**
 * Une intervention, telle que le registre d'archivage la relit.
 *
 * La fiche n'a pas besoin du rapport complet : elle répond à « quand, sur quel
 * appareil, par qui, et dans quel état ». Ces champs viennent de
 * `WORK_ORDER_INCLUDE`, qui les sert déjà à la carte d'intervention.
 */
interface WorkOrderRow {
  id: string;
  orderNumber: string;
  title: string;
  type: string;
  status: string;
  priority: string;
  createdAt: string;
  scheduledDate: string | null;
  completedAt: string | null;
  /** Ce que le technicien a posé, tel quel — `{ name, partNumber, qty }`. */
  partsReplaced: unknown;
  elevator: {
    id: string;
    elevatorCode: string;
    building: { id?: string; name: string };
  };
  assignedTo: { id: string; name: string | null; email: string } | null;
}

/** Une pièce posée, telle que l'historique la présente. */
interface ReplacedPartRow {
  key: string;
  workOrderId: string;
  orderNumber: string;
  elevatorId: string;
  elevatorCode: string;
  buildingName: string;
  date: string;
  name: string;
  partNumber: string | null;
  quantity: number;
  technicianName: string | null;
}

/**
 * Lit `partsReplaced` sans faire confiance à sa forme.
 *
 * La colonne est un `Json` écrit par le formulaire du technicien : elle peut
 * être absente, nulle, ou porter une ligne ancienne qui n'a pas les trois
 * champs. Une lecture qui planterait sur une ligne mal formée rendrait tout le
 * registre illisible à cause d'une seule intervention.
 */
function readReplacedParts(value: unknown): {
  name: string;
  partNumber: string | null;
  quantity: number;
}[] {
  if (!Array.isArray(value)) return [];
  const rows: { name: string; partNumber: string | null; quantity: number }[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) continue;
    const partNumber =
      typeof record.partNumber === "string" && record.partNumber.trim()
        ? record.partNumber.trim()
        : null;
    const quantity =
      typeof record.qty === "number" && Number.isFinite(record.qty) && record.qty > 0
        ? record.qty
        : 1;
    rows.push({ name, partNumber, quantity });
  }
  return rows;
}

/** Une demande d'accès approuvée, devenue un compte sur un site du client. */
interface ApprovedAccessRow {
  id: string;
  role: string;
  createdUser: { id: string; name: string; email: string } | null;
  /** `building` est facultatif : une demande très ancienne peut le porter à null. */
  elevator: { building: { id: string; name: string } | null } | null;
}

interface AccessAccountRow {
  id: string;
  name: string;
  email: string;
  role: string;
  origin: "owner" | "invited";
  buildingName: string | null;
}

interface InvitationState {
  text: string;
  mailto: string;
  whatsapp: string | null;
  password: string | null;
  demo: boolean;
}

/** A NULL type reads as contracted — the rule `@/types` documents. */
function effectiveType(clientType: ClientType | null): ClientType {
  return clientType === "NON_CONTRACTED" ? "NON_CONTRACTED" : "CONTRACTED";
}

// ─── Habillage des états ────────────────────────────────────
//
// Trois familles visuelles, et une seule règle : le vert dit « en service »,
// le rouge dit « arrêté », l'orange dit « à surveiller ». Les mêmes classes
// reviennent sur l'en-tête, les appareils, les devis et les factures — quatre
// écrans qui parlent de la même machine ne doivent pas en donner quatre
// lectures différentes.

const TONE = {
  green: {
    dot: "bg-emerald-500",
    pill: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:ring-emerald-800",
  },
  amber: {
    dot: "bg-amber-500",
    pill: "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-800",
  },
  red: {
    dot: "bg-red-500",
    pill: "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200 dark:bg-red-900/30 dark:text-red-300 dark:ring-red-800",
  },
  sky: {
    dot: "bg-sky-500",
    pill: "bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:ring-sky-800",
  },
  slate: {
    dot: "bg-slate-400",
    pill: "bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
  },
} as const;

type ToneKey = keyof typeof TONE;

/** Vert = en service, rouge = en panne, orange = entretien ou anomalie. */
function elevatorTone(status: string): {
  tone: ToneKey;
  label: string;
} {
  if (status === "OPERATIONAL") return { tone: "green", label: "En service" };
  if (status === "CRITICAL_SHUTDOWN" || status === "OFFLINE") {
    return { tone: "red", label: "En panne" };
  }
  if (status === "SERVICE_REQUIRED") {
    return { tone: "amber", label: "Entretien à prévoir" };
  }
  if (status === "ANOMALY_DETECTED") {
    return { tone: "amber", label: "Anomalie détectée" };
  }
  return { tone: "amber", label: "À surveiller" };
}

function clientStatus(client: {
  clientType: ClientType | null;
  isActive: boolean;
}): { tone: ToneKey; label: string } {
  if (!client.isActive) return { tone: "red", label: "Suspendu" };
  return effectiveType(client.clientType) === "CONTRACTED"
    ? { tone: "green", label: "Sous contrat" }
    : { tone: "amber", label: "Prospect" };
}

function quoteTone(status: string): { tone: ToneKey; label: string } {
  switch (status) {
    case "ACCEPTED":
      return { tone: "green", label: "Accepté" };
    case "REFUSED":
      return { tone: "red", label: "Refusé" };
    case "SENT":
      return { tone: "sky", label: "Transmis" };
    case "CANCELLED":
      return { tone: "slate", label: "Annulé" };
    default:
      return { tone: "amber", label: "En attente" };
  }
}

function invoiceTone(status: string): { tone: ToneKey; label: string } {
  switch (status) {
    case "PAID":
      return { tone: "green", label: "Réglée" };
    case "CANCELLED":
      return { tone: "red", label: "Annulée" };
    default:
      return { tone: "sky", label: "Émise" };
  }
}

/**
 * L'état d'une intervention, dans les mêmes trois familles visuelles.
 *
 * `PENDING_APPROVAL` reste orange et non verte : le travail est fait, mais le
 * rapport n'a pas encore été lu par le bureau — et c'est précisément la ligne
 * qu'un responsable doit voir dans un registre.
 */
function workOrderTone(status: string): { tone: ToneKey; label: string } {
  switch (status) {
    case "COMPLETED":
      return { tone: "green", label: "Terminée" };
    case "CANCELLED":
      return { tone: "slate", label: "Annulée" };
    case "IN_PROGRESS":
      return { tone: "sky", label: "En cours" };
    case "PENDING_APPROVAL":
      return { tone: "amber", label: "À valider" };
    case "ON_HOLD":
      return { tone: "amber", label: "En attente" };
    case "ASSIGNED":
      return { tone: "sky", label: "Assignée" };
    default:
      return { tone: "amber", label: "Ouverte" };
  }
}

/** Une date lisible, ou un tiret — jamais « Invalid Date » à l'écran. */
function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return format(date, "d MMM yyyy", { locale: fr });
}

function renewalLabel(mode: string): string {
  switch (mode) {
    case "AUTO":
      return "Reconduction automatique";
    case "MANUAL":
      return "Reconduction manuelle";
    default:
      return "Sans reconduction";
  }
}

function contractTone(status: string): { tone: ToneKey; label: string } {
  if (status === "ACTIVE") return { tone: "green", label: "Actif" };
  if (status === "SUSPENDED") return { tone: "amber", label: "Suspendu" };
  return { tone: "slate", label: enumLabel(status) };
}

function incidentTone(status: string): { tone: ToneKey; label: string } {
  if (status === "CLOSED" || status === "RESOLVED_BY_CLIENT") {
    return { tone: "green", label: "Résolue" };
  }
  if (status === "IN_PROGRESS") return { tone: "sky", label: "En cours" };
  if (status === "TECHNICIAN_ASSIGNED") {
    return { tone: "amber", label: "Technicien affecté" };
  }
  return { tone: "red", label: "Signalée" };
}

/**
 * Une lecture JSON qui n'avale pas les erreurs.
 *
 * Les six registres de la fiche (pannes, devis, factures, contrats,
 * interventions, accès) se
 * chargent en parallèle et chacun peut échouer sans empêcher les autres de
 * s'afficher. La fonction rend `null` sur un échec : l'onglet concerné montre
 * une ligne d'information, le reste de la fiche reste lisible.
 */
async function readJsonOrNull(url: string): Promise<unknown> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

const FIELD =
  "mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white";

const FIELD_NUM = `${FIELD} tabular-nums`;

const LABEL = "block text-sm font-medium text-gray-700 dark:text-gray-300";

// ─── Style de la fiche ──────────────────────────────────────
//
// Les cartes de cette page sont volontairement plus claires que `Card` : fond
// blanc, bordure `slate` fine, ombre douce. La fiche est un poste de travail lu
// longtemps, et le contraste entre le fond de page et les cartes y fait la
// hiérarchie mieux que des traits plus épais.

const SURFACE =
  "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100";
const BTN_SECONDARY =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";
const BTN_GHOST =
  "inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white";
const CHIP =
  "inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-200";

// ─── Page ───────────────────────────────────────────────────

export default function ClientDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const [tab, setTab] = useState<"info" | "fleet" | "archive">("info");

  const [client, setClient] = useState<ClientDetail | null>(null);
  const [attachable, setAttachable] = useState<AttachableRow[]>([]);
  const [attachableTruncated, setAttachableTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /** Vrai quand la fiche vient du jeu de démonstration, faute de base. */
  const [demoMode, setDemoMode] = useState(false);
  const [access, setAccess] = useState<AccessState | null>(null);

  const [panel, setPanel] = useState<"building" | "attach" | null>(null);
  const [elevatorFor, setElevatorFor] = useState<string | null>(null);
  const [attachQuery, setAttachQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  /** Les registres des trois onglets, chargés en parallèle. */
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [contracts, setContracts] = useState<CoverageContract[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrderRow[]>([]);
  const [approvedAccess, setApprovedAccess] = useState<ApprovedAccessRow[]>([]);
  const [registriesLoading, setRegistriesLoading] = useState(true);
  const [registriesError, setRegistriesError] = useState("");
  /** Le filtre de l'historique des pièces, par appareil. */
  const [partElevator, setPartElevator] = useState("ALL");

  const [qrFor, setQrFor] = useState<ElevatorRow | null>(null);
  const [historyFor, setHistoryFor] = useState<ElevatorRow | null>(null);
  const [accessBusy, setAccessBusy] = useState(false);
  const [accessNotice, setAccessNotice] = useState<string | null>(null);
  const [invitationBusy, setInvitationBusy] = useState(false);
  const [invitation, setInvitation] = useState<InvitationState | null>(null);

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!silent) setLoading(true);
      setError("");
      try {
        const res = await fetch(`/api/clients/${id}`);
        if (res.status === 404) throw new Error("Compte client introuvable");
        if (!res.ok) throw new Error(`La fiche a renvoyé ${res.status}`);
        const payload = await res.json();
        setClient(payload?.data?.client ?? null);
        setAttachable(payload?.data?.attachable ?? []);
        setAttachableTruncated(Boolean(payload?.data?.attachableTruncated));
        setAccess(payload?.data?.access ?? null);
        setDemoMode(payload?.demo === true);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Impossible de charger la fiche"
        );
      } finally {
        setLoading(false);
      }
    },
    [id]
  );

  /**
   * Les six registres de la fiche, en un seul aller-retour parallèle.
   *
   * Aucun n'est indispensable aux deux autres : une panne du registre des
   * factures ne doit pas empêcher de lire le parc. Chacun échoue donc pour son
   * propre compte, et un bandeau unique dit qu'une partie manque — plutôt que
   * de remplacer la fiche entière par un écran d'erreur.
   */
  const loadRegistries = useCallback(async () => {
    setRegistriesLoading(true);
    setRegistriesError("");

    const [
      incidentJson,
      quoteJson,
      invoiceJson,
      contractJson,
      workOrderJson,
      accessJson,
    ] = await Promise.all([
      readJsonOrNull(`/api/incidents?limit=200`),
      readJsonOrNull(
        `/api/quotes?clientId=${encodeURIComponent(id)}&limit=100`
      ),
      readJsonOrNull(
        `/api/invoices?clientId=${encodeURIComponent(id)}&limit=100`
      ),
      readJsonOrNull(`/api/contracts/coverage`),
      // Le registre d'archivage : toutes les interventions, pannes comme
      // entretiens préventifs. Le filtre `clientId` est appliqué côté serveur
      // pour le personnel ; l'écran refiltre ensuite sur ses propres appareils,
      // ce qui garde la fixture de démonstration correcte elle aussi.
      readJsonOrNull(
        `/api/work-orders?clientId=${encodeURIComponent(id)}&limit=200`
      ),
      readJsonOrNull(`/api/access-requests?status=APPROVED`),
    ]);

    const incidentPayload = incidentJson as { data?: IncidentRow[] } | null;
    const quotePayload = quoteJson as { data?: QuoteRow[] } | null;
    const invoicePayload = invoiceJson as { data?: InvoiceRow[] } | null;
    const contractPayload = contractJson as { data?: CoverageContract[] } | null;
    const workOrderPayload = workOrderJson as { data?: WorkOrderRow[] } | null;
    const accessPayload = accessJson as { data?: ApprovedAccessRow[] } | null;

    setIncidents(Array.isArray(incidentPayload?.data) ? incidentPayload.data : []);
    setQuotes(Array.isArray(quotePayload?.data) ? quotePayload.data : []);
    setInvoices(Array.isArray(invoicePayload?.data) ? invoicePayload.data : []);
    setContracts(Array.isArray(contractPayload?.data) ? contractPayload.data : []);
    setWorkOrders(Array.isArray(workOrderPayload?.data) ? workOrderPayload.data : []);
    setApprovedAccess(Array.isArray(accessPayload?.data) ? accessPayload.data : []);

    if (
      [
        incidentJson,
        quoteJson,
        invoiceJson,
        contractJson,
        workOrderJson,
        accessJson,
      ].some((value) => value === null)
    ) {
      setRegistriesError(
        "Une partie des registres (pannes, devis, factures, contrats, interventions ou accès) n'a pas pu être chargée."
      );
    }

    setRegistriesLoading(false);
  }, [id]);

  useEffect(() => {
    void load();
    void loadRegistries();
  }, [load, loadRegistries]);

  // Changer de fiche sans quitter le composant ne doit pas garder l'onglet ni
  // le filtre d'appareil du client précédent.
  useEffect(() => {
    setTab("info");
    setPartElevator("ALL");
  }, [id]);

  const refreshAll = useCallback(async () => {
    await Promise.all([load({ silent: true }), loadRegistries()]);
  }, [load, loadRegistries]);

  /**
   * La recherche d'immeubles à rattacher interroge le serveur, pas la liste
   * déjà reçue.
   *
   * La réponse est bornée à cinquante immeubles : filtrer localement
   * chercherait donc dans un échantillon arbitraire, et un immeuble existant
   * mais absent des cinquante premiers serait déclaré introuvable. Le délai
   * évite une requête par frappe.
   */
  useEffect(() => {
    if (panel !== "attach") return;
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(
            `/api/clients/${id}?q=${encodeURIComponent(attachQuery)}`
          );
          if (!res.ok) return;
          const payload = await res.json();
          setAttachable(payload?.data?.attachable ?? []);
          setAttachableTruncated(Boolean(payload?.data?.attachableTruncated));
        } catch {
          // Une recherche qui échoue n'efface pas la liste : l'administrateur
          // garde ce qu'il avait sous les yeux et peut réessayer en tapant.
        }
      })();
    }, 300);
    return () => window.clearTimeout(handle);
  }, [attachQuery, panel, id]);

  // ─── Périmètre du client ──────────────────────────────────

  const clientBuildings = useMemo(
    () => client?.ownedBuildings ?? [],
    [client]
  );
  const primaryContact = clientBuildings.find(
    (building) => building.contactPerson?.trim()
  );

  const buildingIds = useMemo(
    () => new Set((client?.ownedBuildings ?? []).map((b) => b.id)),
    [client]
  );

  const elevatorIds = useMemo(
    () =>
      new Set(
        (client?.ownedBuildings ?? []).flatMap((building) =>
          building.elevators.map((elevator) => elevator.id)
        )
      ),
    [client]
  );

  const elevatorTotal = useMemo(
    () =>
      (client?.ownedBuildings ?? []).reduce(
        (sum, building) => sum + building.elevators.length,
        0
      ),
    [client]
  );

  const clientIncidents = useMemo(
    () => incidents.filter((incident) => elevatorIds.has(incident.elevator.id)),
    [incidents, elevatorIds]
  );

  const openFaults = useMemo(
    () =>
      clientIncidents.filter((incident) =>
        (OPEN_INCIDENT_STATUSES as readonly string[]).includes(incident.status)
      ),
    [clientIncidents]
  );

  /** L'historique de chaque appareil, prêt pour le panneau latéral. */
  const faultsByElevator = useMemo(() => {
    const map = new Map<string, IncidentRow[]>();
    for (const incident of clientIncidents) {
      const list = map.get(incident.elevator.id) ?? [];
      list.push(incident);
      map.set(incident.elevator.id, list);
    }
    return map;
  }, [clientIncidents]);

  const clientQuotes = useMemo(
    () => quotes.filter((quote) => quote.clientId === client?.id),
    [quotes, client]
  );

  const clientInvoices = useMemo(
    () => invoices.filter((invoice) => invoice.clientId === client?.id),
    [invoices, client]
  );

  /**
   * Les appareils du client, à plat, pour le tableau d'équipements.
   *
   * Le parc est groupé par immeuble dans l'onglet, mais la demande d'une vue
   * d'ensemble est un tableau : chaque ligne porte son immeuble, ce qui évite
   * de faire défiler plusieurs sections pour comparer deux machines.
   */
  const clientElevators = useMemo(
    () =>
      clientBuildings.flatMap((building) =>
        building.elevators.map((elevator) => ({
          elevator,
          buildingName: building.name,
          buildingAddress: building.address,
          buildingCity: building.city,
        }))
      ),
    [clientBuildings]
  );

  /** Seuls les devis validés sont des documents rattachés à la fiche. */
  const acceptedQuotes = useMemo(
    () => clientQuotes.filter((quote) => quote.status === "ACCEPTED"),
    [clientQuotes]
  );

  const clientWorkOrders = useMemo(
    () =>
      workOrders
        .filter((order) => elevatorIds.has(order.elevator.id))
        .sort((a, b) => {
          const dateOf = (order: WorkOrderRow) =>
            new Date(
              order.completedAt ?? order.scheduledDate ?? order.createdAt
            ).getTime();
          const byDate = dateOf(b) - dateOf(a);
          if (byDate !== 0) return byDate;
          return a.orderNumber.localeCompare(b.orderNumber, "fr");
        }),
    [workOrders, elevatorIds]
  );

  /**
   * L'historique des pièces remplacées, reconstruit depuis les interventions.
   *
   * `WorkOrder.partsReplaced` est le constat de ce que le technicien a posé,
   * figé à la clôture — c'est la source qui rend une facture opposable. On ne
   * lit donc pas les demandes de pièces (`PartRequirement`), qui sont des
   * intentions : une pièce commandée n'est pas une pièce montée.
   */
  const replacedParts = useMemo<ReplacedPartRow[]>(() => {
    const rows: ReplacedPartRow[] = [];
    for (const order of clientWorkOrders) {
      const parts = readReplacedParts(order.partsReplaced);
      if (parts.length === 0) continue;
      const date =
        order.completedAt ?? order.scheduledDate ?? order.createdAt;
      for (const [index, part] of parts.entries()) {
        rows.push({
          key: `${order.id}:${index}`,
          workOrderId: order.id,
          orderNumber: order.orderNumber,
          elevatorId: order.elevator.id,
          elevatorCode: order.elevator.elevatorCode,
          buildingName: order.elevator.building?.name ?? "—",
          date,
          name: part.name,
          partNumber: part.partNumber,
          quantity: part.quantity,
          technicianName: order.assignedTo?.name ?? null,
        });
      }
    }
    return rows.sort((a, b) => {
      const byDate = new Date(b.date).getTime() - new Date(a.date).getTime();
      if (byDate !== 0) return byDate;
      return a.elevatorCode.localeCompare(b.elevatorCode, "fr");
    });
  }, [clientWorkOrders]);

  const visibleParts = useMemo(
    () =>
      partElevator === "ALL"
        ? replacedParts
        : replacedParts.filter((part) => part.elevatorId === partElevator),
    [replacedParts, partElevator]
  );

  /**
   * Le contrat du client, déduit de ses immeubles.
   *
   * La route de couverture ne filtre pas par client pour un administrateur :
   * elle rend la couverture du parc. On ne garde donc que les contrats qui
   * couvrent l'un des immeubles de cette fiche. Un contrat actif l'emporte sur
   * un suspendu — c'est la règle de `contractForBuilding`.
   */
  const clientContracts = useMemo(
    () =>
      contracts.filter((contract) =>
        contract.buildings.some((building) => buildingIds.has(building.id))
      ),
    [contracts, buildingIds]
  );

  const currentContract = useMemo(
    () =>
      clientContracts.find(
        (contract) => contract.effectiveStatus === "ACTIVE"
      ) ??
      clientContracts[0] ??
      null,
    [clientContracts]
  );

  /**
   * Les comptes qui ouvrent le portail pour ce client.
   *
   * Le titulaire d'abord — c'est le compte que la fiche administre. Puis les
   * accès invités créés par une demande QR approuvée, rattachés à un immeuble
   * de son parc. Le modèle ne porte pas de lien direct entre comptes : c'est
   * l'immeuble de la demande qui dit de quel portefeuille le compte relève.
   */
  const accessAccounts = useMemo<AccessAccountRow[]>(() => {
    if (!client) return [];

    const rows: AccessAccountRow[] = [
      {
        id: client.id,
        name: client.name,
        email: client.email,
        role:
          effectiveType(client.clientType) === "CONTRACTED"
            ? "Titulaire — contrat"
            : "Titulaire — prospect",
        origin: "owner",
        buildingName: null,
      },
    ];

    const seen = new Set([client.id]);
    for (const request of approvedAccess) {
      const user = request.createdUser;
      const building = request.elevator?.building;
      if (!user || !building || !buildingIds.has(building.id)) continue;
      if (seen.has(user.id)) continue;
      seen.add(user.id);
      rows.push({
        id: user.id,
        name: user.name,
        email: user.email,
        role: request.role || "Compte invité",
        origin: "invited",
        buildingName: building.name,
      });
    }

    return rows;
  }, [client, approvedAccess, buildingIds]);

  // ─── Actions ──────────────────────────────────────────────

  async function detach(building: BuildingRow) {
    setActionError("");
    if (
      !window.confirm(
        `Détacher « ${building.name} » de ${client?.name ?? "ce client"} ?\n\n` +
          "L'immeuble, ses appareils et son historique sont conservés ; il " +
          "cesse simplement d'apparaître dans le portail de ce client."
      )
    ) {
      return;
    }

    setBusyId(building.id);
    try {
      const res = await fetch(
        `/api/clients/${id}/buildings?buildingId=${encodeURIComponent(building.id)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error ?? "Le détachement a échoué.");
      }
      await load({ silent: true });
      await loadRegistries();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Le détachement a échoué.");
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Activer ou suspendre l'accès au portail.
   *
   * En démonstration, le changement est appliqué à l'écran seulement : il n'y
   * a pas de base où l'écrire. Le message le dit, plutôt que de laisser croire
   * à une modification enregistrée.
   */
  async function toggleAccess() {
    if (!client) return;
    const next = !client.isActive;

    setAccessBusy(true);
    setActionError("");
    setAccessNotice(null);

    if (demoMode) {
      setClient({ ...client, isActive: next });
      setAccess((current) =>
        current ? { ...current, isActive: next, canSignIn: next } : current
      );
      setAccessNotice(
        next
          ? "Accès activé — changement simulé, non enregistré (mode démonstration)."
          : "Accès suspendu — changement simulé, non enregistré (mode démonstration)."
      );
      setAccessBusy(false);
      return;
    }

    try {
      const res = await fetch("/api/clients", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: client.id, isActive: next }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.error ?? "La mise à jour de l'accès a échoué.");
      }
      setClient({ ...client, isActive: next });
      setAccessNotice(
        next
          ? "Accès au portail activé. Le client peut se connecter."
          : "Accès au portail suspendu. Toute connexion sera refusée."
      );
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "La mise à jour de l'accès a échoué."
      );
    } finally {
      setAccessBusy(false);
    }
  }

  /**
   * Préparer une invitation, sans prétendre l'avoir envoyée.
   *
   * Le mot de passe est engendré par la route dédiée — la même qu'en
   * production, et une fixture côté serveur quand PostgreSQL est absent. Le
   * texte et les liens `mailto:` / WhatsApp sont construits ici : le courriel
   * n'a aucun transport dans ce produit, et un bouton « Envoyer » qui ne
   * ferait rien serait une promesse en l'air.
   */
  async function generateInvitation() {
    if (!client) return;

    setInvitationBusy(true);
    setActionError("");
    setAccessNotice(null);

    try {
      const res = await fetch(`/api/clients/${client.id}/password`, {
        method: "POST",
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          payload?.error ?? "La génération de l'invitation a échoué."
        );
      }

      const password =
        typeof payload?.data?.password === "string"
          ? payload.data.password
          : null;
      const demo = payload?.data?.demo === true;

      const site =
        client.ownedBuildings.map((building) => building.name).join(", ") ||
        "votre parc";
      const origin =
        typeof window !== "undefined" ? window.location.origin : "";
      const lines = [
        `Bonjour ${client.name},`,
        "",
        `Vos accès Maintenance RMASC sont ouverts pour ${site}.`,
        "",
        `Adresse : ${origin}/connexion`,
        `E-mail : ${client.email}`,
        password ? `Mot de passe : ${password}` : null,
        "",
        "Ce mot de passe est provisoire : changez-le après votre première connexion.",
      ].filter((line): line is string => line !== null);

      const text = lines.join("\n");
      const subject = "Vos accès Maintenance RMASC";
      const mailto = `mailto:${encodeURIComponent(client.email)}?subject=${encodeURIComponent(
        subject
      )}&body=${encodeURIComponent(text)}`;
      const digits = (client.phone ?? "").replace(/\D/g, "");
      const whatsapp = digits
        ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
        : null;

      setInvitation({ text, mailto, whatsapp, password, demo });
      setAccessNotice(
        demo
          ? "Invitation simulée : aucun mot de passe n'a été enregistré."
          : "Invitation générée. L'ancien mot de passe ne fonctionne plus."
      );
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "La génération de l'invitation a échoué."
      );
    } finally {
      setInvitationBusy(false);
    }
  }

  // ─── États de chargement et d'erreur ──────────────────────

  if (loading && !client) {
    return (
      <div className="space-y-4">
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  if (error && !client) {
    return <ErrorState message={error} onRetry={() => void load()} />;
  }

  if (!client) {
    return (
      <EmptyState
        title="Compte client introuvable"
        hint="Il a peut-être été désactivé, ou le lien est incomplet."
      />
    );
  }

  const badge = clientStatus(client);
  const canSignIn = access?.canSignIn ?? client.isActive;
  const historyRows = historyFor
    ? faultsByElevator.get(historyFor.id) ?? []
    : [];

  const TABS = [
    {
      key: "info" as const,
      label: "Informations & Contrats",
      icon: FileText,
      count: acceptedQuotes.length + clientInvoices.length,
    },
    {
      key: "fleet" as const,
      label: "Équipements rattachés",
      icon: Building2,
      count: elevatorTotal,
    },
    {
      key: "archive" as const,
      label: "Registre d'archivage",
      icon: Archive,
      count: clientWorkOrders.length,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/*
        La fiche vient de la fixture, pas de PostgreSQL. Le dire évite de faire
        passer les immeubles et appareils affichés pour un parc réel : ce sont
        exactement les mêmes lignes que la carte et le tableau de bord montrent,
        mais aucun n'existe en base tant qu'elle est absente.
      */}
      {demoMode && (
        <div className="rounded-xl border border-sky-300 bg-sky-50 p-4 dark:border-sky-800 dark:bg-sky-950/40">
          <p className="flex items-start gap-2 text-sm font-medium text-sky-900 dark:text-sky-200">
            <Info className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
            <span>
              Mode démonstration : fiche, parc, contrats et accès servis depuis
              le jeu de démonstration. Les écritures nécessitent une base de
              données.
            </span>
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/administration/clients"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Espace clients
        </Link>

        <button
          type="button"
          onClick={() => void refreshAll()}
          disabled={loading || registriesLoading}
          className={BTN_GHOST}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${
              loading || registriesLoading ? "animate-spin" : ""
            }`}
            aria-hidden="true"
          />
          Actualiser
        </button>
      </div>

      {/* ── En-tête ──────────────────────────────────────────── */}
      <section className={`${SURFACE} p-6`}>
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                {client.name}
              </h1>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${TONE[badge.tone].pill}`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${TONE[badge.tone].dot}`}
                  aria-hidden="true"
                />
                {badge.label}
              </span>
              {!client.isActive && (
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  Connexion refusée
                </span>
              )}
            </div>

            <dl className="mt-4 grid gap-2 text-sm text-slate-600 dark:text-slate-300 sm:grid-cols-2">
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 flex-none text-slate-400" aria-hidden="true" />
                <span className="truncate">{client.email}</span>
              </div>
              {client.phone && (
                <div className="flex items-center gap-2">
                  <Phone className="h-4 w-4 flex-none text-slate-400" aria-hidden="true" />
                  <span className="tabular-nums">{client.phone}</span>
                </div>
              )}
              {client.address && (
                <div className="flex items-center gap-2 sm:col-span-2">
                  <MapPin className="h-4 w-4 flex-none text-slate-400" aria-hidden="true" />
                  <span>{client.address}</span>
                </div>
              )}
            </dl>
          </div>

          <div className="flex flex-wrap gap-2">
            <span className={CHIP}>
              <Building2 className="h-4 w-4 text-slate-400" aria-hidden="true" />
              <span className="tabular-nums font-semibold text-slate-900 dark:text-white">
                {clientBuildings.length}
              </span>
              Immeuble{clientBuildings.length === 1 ? "" : "s"}
            </span>
            <span className={CHIP}>
              <Gauge className="h-4 w-4 text-slate-400" aria-hidden="true" />
              <span className="tabular-nums font-semibold text-slate-900 dark:text-white">
                {elevatorTotal}
              </span>
              Ascenseur{elevatorTotal === 1 ? "" : "s"}
            </span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium ${
                openFaults.length > 0
                  ? "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
                  : "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-200"
              }`}
            >
              <AlertTriangle
                className="h-4 w-4 flex-none"
                aria-hidden="true"
              />
              <span className="tabular-nums font-semibold">
                {registriesLoading ? "…" : openFaults.length}
              </span>
              Panne{openFaults.length === 1 ? "" : "s"} en cours
            </span>
          </div>
        </div>

        <p className="mt-5 border-t border-slate-100 pt-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          Compte ouvert le{" "}
          {format(new Date(client.createdAt), "d MMMM yyyy", { locale: fr })}
          {client.clientType
            ? ` · ${CLIENT_TYPE_LABELS[effectiveType(client.clientType)]}`
            : ""}
        </p>
      </section>

      {registriesError && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {registriesError}
        </p>
      )}

      {actionError && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
          {actionError}
        </p>
      )}

      {/* ── Onglets ──────────────────────────────────────────── */}
      <div
        role="tablist"
        aria-label="Sections de la fiche client"
        className="flex flex-col gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:flex-row"
      >
        {TABS.map(({ key, label, icon: Icon, count }) => {
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(key)}
              className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-slate-900 text-white shadow-sm dark:bg-white dark:text-slate-900"
                  : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
              <span
                className={`rounded-full px-1.5 py-0.5 text-[11px] tabular-nums ${
                  active
                    ? "bg-white/20 dark:bg-slate-900/10"
                    : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* ── Onglet 2 : Équipements rattachés ─────────────────── */}
      {tab === "fleet" && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                Équipements rattachés
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {clientBuildings.length} immeuble
                {clientBuildings.length === 1 ? "" : "s"} · {elevatorTotal}{" "}
                appareil{elevatorTotal === 1 ? "" : "s"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setPanel(panel === "attach" ? null : "attach");
                  setElevatorFor(null);
                }}
                className={BTN_SECONDARY}
              >
                <Link2 className="h-4 w-4" aria-hidden="true" />
                Rattacher un immeuble
              </button>
              <button
                type="button"
                onClick={() => {
                  setPanel(panel === "building" ? null : "building");
                  setElevatorFor(null);
                }}
                className={BTN_PRIMARY}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Nouvel immeuble
              </button>
            </div>
          </div>

          {panel === "attach" && (
            <AttachBuildingPanel
              clientId={id}
              clientName={client.name}
              buildings={attachable}
              truncated={attachableTruncated}
              query={attachQuery}
              onQueryChange={setAttachQuery}
              onDone={async () => {
                setPanel(null);
                setAttachQuery("");
                await load({ silent: true });
              }}
              onCancel={() => {
                setPanel(null);
                setAttachQuery("");
              }}
            />
          )}

          {panel === "building" && (
            <AddBuildingForm
              clientId={id}
              clientName={client.name}
              clientPhone={client.phone}
              onDone={async () => {
                setPanel(null);
                await load({ silent: true });
              }}
              onCancel={() => setPanel(null)}
            />
          )}

          {/* La vue d'ensemble du parc : une ligne par appareil, avec son
              immeuble. Les sections qui suivent servent à administrer les
              immeubles (rattachement, création, ajout d'appareil) ; ce tableau
              est la lecture transverse que la fiche doit offrir. */}
          <section className={`${SURFACE} overflow-hidden`}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 p-5 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <Gauge className="h-4 w-4 text-slate-400" aria-hidden="true" />
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">
                  Liste des ascenseurs
                </h3>
              </div>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {clientElevators.length} appareil
                {clientElevators.length === 1 ? "" : "s"}
              </span>
            </div>

            {clientElevators.length === 0 ? (
              <p className="p-5 text-sm text-slate-500 dark:text-slate-400">
                Aucun ascenseur rattaché à ce client.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-left text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                    <tr>
                      <th className="px-5 py-3 font-semibold">Matricule</th>
                      <th className="px-5 py-3 font-semibold">
                        Immeuble / Localisation
                      </th>
                      <th className="px-5 py-3 font-semibold">Marque / Modèle</th>
                      <th className="px-5 py-3 font-semibold">
                        Date d&apos;installation
                      </th>
                      <th className="px-5 py-3 font-semibold">Statut</th>
                      <th className="px-5 py-3 text-right font-semibold">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {clientElevators.map(
                      ({ elevator, buildingName, buildingAddress, buildingCity }) => {
                      const tone = elevatorTone(elevator.status);
                      const faultCount =
                        faultsByElevator.get(elevator.id)?.length ?? 0;
                      return (
                        <tr
                          key={elevator.id}
                          className="transition-colors hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
                        >
                          <td className="whitespace-nowrap px-5 py-3">
                            <span className="font-mono text-xs font-semibold text-slate-900 dark:text-white">
                              {elevator.elevatorCode}
                            </span>
                            {elevator.serialNumber && (
                              <p className="mt-0.5 font-mono text-[11px] text-slate-400 dark:text-slate-500">
                                N° {elevator.serialNumber}
                              </p>
                            )}
                          </td>
                          <td className="px-5 py-3 text-slate-600 dark:text-slate-300">
                            <p className="font-medium text-slate-900 dark:text-white">
                              {buildingName}
                            </p>
                            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                              {buildingAddress}, {buildingCity}
                            </p>
                            {elevator.installationLocation && (
                              <p className="mt-1 flex items-start gap-1 text-xs font-medium text-slate-700 dark:text-slate-200">
                                <MapPin
                                  className="mt-0.5 h-3 w-3 flex-none text-slate-400"
                                  aria-hidden="true"
                                />
                                {elevator.installationLocation}
                              </p>
                            )}
                          </td>
                          <td className="px-5 py-3 text-slate-600 dark:text-slate-300">
                            {enumLabel(elevator.brand)} · {elevator.model}
                          </td>
                          <td className="whitespace-nowrap px-5 py-3 text-slate-500 dark:text-slate-400">
                            {formatDate(elevator.installationDate)}
                          </td>
                          <td className="whitespace-nowrap px-5 py-3">
                            <span
                              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE[tone.tone].pill}`}
                            >
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${TONE[tone.tone].dot}`}
                                aria-hidden="true"
                              />
                              {tone.label}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-5 py-3 text-right">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => setQrFor(elevator)}
                                className={BTN_GHOST}
                              >
                                <QrCode className="h-3.5 w-3.5" aria-hidden="true" />
                                QR
                              </button>
                              <button
                                type="button"
                                onClick={() => setHistoryFor(elevator)}
                                className={BTN_GHOST}
                              >
                                <History className="h-3.5 w-3.5" aria-hidden="true" />
                                Pannes
                                {faultCount > 0 && (
                                  <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                                    {faultCount}
                                  </span>
                                )}
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
          </section>

          {clientBuildings.length === 0 && panel === null ? (
            <EmptyState
              title="Aucun immeuble rattaché"
              hint="Déclarez une adresse de site, ou rattachez un immeuble déjà en base."
            />
          ) : (
            <div className="space-y-5">
              {clientBuildings.map((building) => (
                <section key={building.id} className={`${SURFACE} overflow-hidden`}>
                  <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 p-5 dark:border-slate-800">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Building2
                          className="h-4 w-4 flex-none text-slate-400"
                          aria-hidden="true"
                        />
                        <h3 className="text-base font-semibold text-slate-900 dark:text-white">
                          {building.name}
                        </h3>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE.slate.pill}`}
                        >
                          {enumLabel(building.slaTier)}
                        </span>
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                          {building.elevators.length} appareil
                          {building.elevators.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                        {building.address}, {building.city}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        Contact : {building.contactPerson}
                        {building.contactPhone
                          ? ` · ${building.contactPhone}`
                          : ""}
                      </p>
                      <p className="mt-1 flex items-center gap-1.5 text-xs">
                        <MapPin
                          className="h-3.5 w-3.5 flex-none text-slate-400"
                          aria-hidden="true"
                        />
                        {building.latitude !== null &&
                        building.longitude !== null ? (
                          <span className="tabular-nums text-slate-500 dark:text-slate-400">
                            {building.latitude.toFixed(4)},{" "}
                            {building.longitude.toFixed(4)}
                            {building.geofenceRadiusM !== null
                              ? ` · rayon ${building.geofenceRadiusM} m`
                              : " · rayon par défaut"}
                          </span>
                        ) : (
                          // Une position absente n'est pas une erreur, mais elle
                          // a une conséquence qu'il faut nommer : sans
                          // coordonnées, le pointage d'arrivée n'est pas
                          // contrôlé en distance.
                          <span className="text-amber-700 dark:text-amber-400">
                            Position inconnue — pointages non contrôlés.
                          </span>
                        )}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setElevatorFor(
                            elevatorFor === building.id ? null : building.id
                          )
                        }
                        className={BTN_GHOST}
                      >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        Ajouter un ascenseur
                      </button>
                      <button
                        type="button"
                        onClick={() => void detach(building)}
                        disabled={busyId === building.id}
                        className={`${BTN_GHOST} hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/40 dark:hover:text-red-300`}
                      >
                        {busyId === building.id ? (
                          <Loader2
                            className="h-3.5 w-3.5 animate-spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        Détacher
                      </button>
                    </div>
                  </header>

                  <div className="p-5">
                    {building.elevators.length === 0 ? (
                      <p className="text-sm text-slate-500 dark:text-slate-400">
                        Aucun appareil déclaré à cette adresse.
                      </p>
                    ) : (
                      <ul className="grid gap-3 sm:grid-cols-2">
                        {building.elevators.map((elevator) => {
                          const tone = elevatorTone(elevator.status);
                          const faultCount =
                            faultsByElevator.get(elevator.id)?.length ?? 0;

                          return (
                            <li
                              key={elevator.id}
                              className="rounded-xl border border-slate-200 bg-white p-4 transition-shadow hover:shadow-sm dark:border-slate-800 dark:bg-slate-900"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span
                                      className={`h-2.5 w-2.5 flex-none rounded-full ${TONE[tone.tone].dot}`}
                                      aria-hidden="true"
                                    />
                                    <span className="font-mono text-sm font-semibold text-slate-900 dark:text-white">
                                      {elevator.elevatorCode}
                                    </span>
                                  </div>
                                  <p className="mt-1 truncate text-sm text-slate-600 dark:text-slate-300">
                                    {enumLabel(elevator.brand)} {elevator.model}
                                  </p>
                                  {elevator.installationLocation && (
                                    <p className="mt-0.5 flex items-start gap-1 text-xs text-slate-500 dark:text-slate-400">
                                      <MapPin
                                        className="mt-0.5 h-3 w-3 flex-none"
                                        aria-hidden="true"
                                      />
                                      {elevator.installationLocation}
                                    </p>
                                  )}
                                </div>
                                <span
                                  className={`flex-none rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE[tone.tone].pill}`}
                                >
                                  {tone.label}
                                </span>
                              </div>

                              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                                {enumLabel(elevator.motorType)} ·{" "}
                                {elevator.floorsServed} niveaux ·{" "}
                                {elevator.maxPayloadKg} kg · santé{" "}
                                {Math.round(elevator.overallHealth)} %
                              </p>
                              {elevator.serialNumber && (
                                <p className="mt-0.5 font-mono text-[11px] text-slate-400 dark:text-slate-500">
                                  N° {elevator.serialNumber}
                                </p>
                              )}

                              <div className="mt-3 flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => setQrFor(elevator)}
                                  className={BTN_GHOST}
                                >
                                  <QrCode
                                    className="h-3.5 w-3.5"
                                    aria-hidden="true"
                                  />
                                  Voir QR Code
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setHistoryFor(elevator)}
                                  className={BTN_GHOST}
                                >
                                  <History
                                    className="h-3.5 w-3.5"
                                    aria-hidden="true"
                                  />
                                  Historique des pannes
                                  {faultCount > 0 && (
                                    <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                                      {faultCount}
                                    </span>
                                  )}
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    {elevatorFor === building.id && (
                      <div className="mt-4">
                        <AddElevatorForm
                          buildingId={building.id}
                          buildingName={building.name}
                          onDone={async () => {
                            setElevatorFor(null);
                            await load({ silent: true });
                          }}
                          onCancel={() => setElevatorFor(null)}
                        />
                      </div>
                    )}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Onglet 1 : Informations client ──────────────────── */}
      {/*
        L'identité du client passe avant ses contrats et ses documents : c'est
        la seule section qui répond à « qui est ce client, et qui joindre sur
        site ». Le contrat et les pièces commerciales suivent dans l'onglet, et
        l'accès au portail ferme la marche — il appartient à l'administration du
        compte, pas à la lecture du dossier.
      */}
      {tab === "info" && (
        <section className={`${SURFACE} p-6`}>
          <div className="flex items-center gap-2">
            <UserRound className="h-4 w-4 text-slate-400" aria-hidden="true" />
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">
              Informations client
            </h2>
          </div>

          <div className="mt-4 grid gap-5 md:grid-cols-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Compte client
              </p>
              <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">
                {client.name}
              </p>
              <dl className="mt-2 space-y-1.5 text-sm text-slate-600 dark:text-slate-300">
                <div className="flex items-center gap-2">
                  <Mail className="h-4 w-4 flex-none text-slate-400" aria-hidden="true" />
                  <span className="truncate">{client.email}</span>
                </div>
                {client.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="h-4 w-4 flex-none text-slate-400" aria-hidden="true" />
                    <span className="tabular-nums">{client.phone}</span>
                  </div>
                )}
                {client.address && (
                  <div className="flex items-start gap-2">
                    <MapPin className="mt-0.5 h-4 w-4 flex-none text-slate-400" aria-hidden="true" />
                    <span>{client.address}</span>
                  </div>
                )}
              </dl>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                Client depuis le{" "}
                {format(new Date(client.createdAt), "d MMMM yyyy", { locale: fr })}
                {" · "}
                {CLIENT_TYPE_LABELS[effectiveType(client.clientType)]}
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-800/40">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Responsable du site
              </p>
              {primaryContact ? (
                <>
                  <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">
                    {primaryContact.contactPerson}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {primaryContact.name} · {primaryContact.address},{" "}
                    {primaryContact.city}
                  </p>
                  <div className="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-300">
                    {primaryContact.contactPhone && (
                      <p className="flex items-center gap-2">
                        <Phone className="h-4 w-4 flex-none text-slate-400" aria-hidden="true" />
                        {primaryContact.contactPhone}
                      </p>
                    )}
                    {primaryContact.contactEmail && (
                      <p className="flex items-center gap-2">
                        <Mail className="h-4 w-4 flex-none text-slate-400" aria-hidden="true" />
                        {primaryContact.contactEmail}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  Aucun responsable de site renseigné.
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ── Onglet 1bis : Accès Portail Client ───────────────── */}
      {tab === "info" && (
        <div className="order-3 grid gap-5 lg:grid-cols-3">
          <section className={`${SURFACE} p-6 lg:col-span-2`}>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-slate-400" aria-hidden="true" />
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                Accès Portail Client
              </h2>
            </div>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              L&apos;accès au portail <span className="font-mono">/client</span>{" "}
              pour le compte{" "}
              <span className="font-medium text-slate-700 dark:text-slate-200">
                {client.email}
              </span>
              .
            </p>

            <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-800/40">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      canSignIn ? TONE.green.dot : TONE.red.dot
                    }`}
                    aria-hidden="true"
                  />
                  {canSignIn ? "Accès actif" : "Accès suspendu"}
                </p>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {canSignIn
                    ? "Le client peut ouvrir une session et signaler une panne depuis son portail."
                    : "Toute tentative de connexion est refusée tant que le compte reste suspendu."}
                </p>
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={client.isActive}
                aria-label={
                  client.isActive
                    ? "Suspendre l'accès au portail"
                    : "Activer l'accès au portail"
                }
                onClick={() => void toggleAccess()}
                disabled={accessBusy}
                className={`relative inline-flex h-6 w-11 flex-none items-center rounded-full transition-colors disabled:opacity-60 ${
                  client.isActive
                    ? "bg-emerald-500"
                    : "bg-slate-300 dark:bg-slate-700"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                    client.isActive ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>

            {accessNotice && (
              <p
                role="status"
                className="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-xs font-medium text-sky-800 dark:bg-sky-950/40 dark:text-sky-300"
              >
                {accessNotice}
              </p>
            )}

            <div className="mt-6 border-t border-slate-100 pt-5 dark:border-slate-800">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                Invitation
              </h3>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Génère un mot de passe provisoire et prépare le message
                d&apos;ouverture d&apos;accès. Le courriel est remis à votre
                messagerie ; aucun transport e-mail n&apos;est configuré dans ce
                produit.
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void generateInvitation()}
                  disabled={invitationBusy}
                  className={BTN_PRIMARY}
                >
                  {invitationBusy ? (
                    <Loader2
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <KeyRound className="h-4 w-4" aria-hidden="true" />
                  )}
                  Générer une invitation
                </button>
                <button
                  type="button"
                  disabled={!invitation?.whatsapp}
                  onClick={() => {
                    if (invitation?.whatsapp) {
                      window.open(
                        invitation.whatsapp,
                        "_blank",
                        "noopener,noreferrer"
                      );
                    }
                  }}
                  className={BTN_SECONDARY}
                >
                  <Send className="h-4 w-4" aria-hidden="true" />
                  Envoyer par WhatsApp
                </button>
                <button
                  type="button"
                  disabled={!invitation}
                  onClick={() => {
                    if (invitation) window.location.href = invitation.mailto;
                  }}
                  className={BTN_SECONDARY}
                >
                  <Mail className="h-4 w-4" aria-hidden="true" />
                  Envoyer par E-mail
                </button>
              </div>

              {invitation && (
                <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-800/40">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      {invitation.demo
                        ? "Invitation simulée"
                        : "Invitation générée"}
                    </p>
                    <CopyButton value={invitation.text} />
                  </div>

                  {invitation.password && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        Mot de passe provisoire
                      </span>
                      <code className="select-all rounded-lg border border-slate-200 bg-white px-2.5 py-1 font-mono text-sm tracking-wide text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white">
                        {invitation.password}
                      </code>
                    </div>
                  )}

                  <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-3 text-xs leading-relaxed text-slate-600 ring-1 ring-inset ring-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-800">
                    {invitation.text}
                  </pre>

                  {invitation.demo && (
                    <p className="mt-2 text-[11px] text-sky-700 dark:text-sky-300">
                      Mode démonstration : rien n&apos;a été enregistré, ce mot
                      de passe ne fonctionnera pas.
                    </p>
                  )}
                </div>
              )}
            </div>
          </section>

          <section className={`${SURFACE} p-6`}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-base font-semibold text-slate-900 dark:text-white">
                Comptes rattachés
              </h3>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {accessAccounts.length}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Le compte titulaire et les accès invités créés sur un site du
              parc.
            </p>

            <ul className="mt-4 space-y-3">
              {accessAccounts.map((account) => (
                <li
                  key={account.id}
                  className="flex items-start gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800"
                >
                  <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    <UserRound className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900 dark:text-white">
                      {account.name}
                    </p>
                    <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {account.email}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE.slate.pill}`}
                      >
                        {account.role}
                      </span>
                      {account.buildingName && (
                        <span className="text-[11px] text-slate-500 dark:text-slate-400">
                          {account.buildingName}
                        </span>
                      )}
                      {account.origin === "invited" && (
                        <span className="text-[11px] text-emerald-700 dark:text-emerald-300">
                          accès invité
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {/* ── Onglet 1ter : Contrat & documents ────────────────── */}
      {tab === "info" && (
        <div className="order-2 space-y-5">
          <section className={`${SURFACE} p-6`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-slate-400" aria-hidden="true" />
                <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                  Contrat courant
                </h2>
              </div>
              {currentContract && (
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-semibold ${TONE[contractTone(currentContract.effectiveStatus).tone].pill}`}
                >
                  {contractTone(currentContract.effectiveStatus).label}
                </span>
              )}
            </div>

            {registriesLoading ? (
              <div className="mt-4">
                <LoadingSkeleton rows={2} />
              </div>
            ) : currentContract ? (
              <>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Formule SLA
                    </p>
                    <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">
                      {enumLabel(currentContract.slaTier)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Reconduction
                    </p>
                    <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">
                      {renewalLabel(currentContract.renewalMode)}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      Préavis {currentContract.noticeDays} jours
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Échéance / reconduction
                    </p>
                    <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">
                      {format(
                        new Date(currentContract.effectiveEndsAt),
                        "d MMMM yyyy",
                        { locale: fr }
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      Depuis le{" "}
                      {format(new Date(currentContract.startsAt), "d MMM yyyy", {
                        locale: fr,
                      })}
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Engagements
                    </p>
                    <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">
                      {currentContract.responseHours} h de prise en charge
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {currentContract.interventionHours} h d&apos;intervention
                    </p>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Contrat {currentContract.reference}
                  </span>
                  {currentContract.buildings.map((building) => (
                    <span
                      key={building.id}
                      className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                    >
                      {building.name}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <p className="mt-4 rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                Aucun contrat en cours pour ce client.
              </p>
            )}
          </section>

          <section className={`${SURFACE} overflow-hidden`}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 p-5 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-slate-400" aria-hidden="true" />
                <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                  Devis validés
                </h2>
              </div>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {acceptedQuotes.length}
              </span>
            </div>

            {registriesLoading ? (
              <div className="p-5">
                <LoadingSkeleton rows={2} />
              </div>
            ) : acceptedQuotes.length === 0 ? (
              <p className="p-5 text-sm text-slate-500 dark:text-slate-400">
                Aucun devis validé rattaché à ce client. Les offres en attente
                ou refusées restent consultables dans le registre des devis.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                    <tr>
                      <th className="px-5 py-3 font-semibold">Numéro</th>
                      <th className="px-5 py-3 font-semibold">Objet</th>
                      <th className="px-5 py-3 font-semibold">Immeuble</th>
                      <th className="px-5 py-3 font-semibold">Statut</th>
                      <th className="px-5 py-3 font-semibold">Date</th>
                      <th className="px-5 py-3 text-right font-semibold">
                        Total TTC
                      </th>
                      <th className="px-5 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {acceptedQuotes.map((quote) => {
                      const tone = quoteTone(quote.status);
                      return (
                        <tr
                          key={quote.id}
                          className="transition-colors hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
                        >
                          <td className="whitespace-nowrap px-5 py-3">
                            <Link
                              href={`/administration/devis/${quote.id}`}
                              className="font-mono text-xs font-semibold text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-500 dark:text-white dark:decoration-slate-600"
                            >
                              {quote.number}
                            </Link>
                          </td>
                          <td className="max-w-[22rem] px-5 py-3">
                            <p
                              className="truncate text-sm text-slate-700 dark:text-slate-200"
                              title={quote.need}
                            >
                              {quote.need}
                            </p>
                          </td>
                          <td className="whitespace-nowrap px-5 py-3 text-slate-500 dark:text-slate-400">
                            {quote.building.name}
                          </td>
                          <td className="whitespace-nowrap px-5 py-3">
                            <span
                              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE[tone.tone].pill}`}
                            >
                              {tone.label}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-5 py-3 text-slate-500 dark:text-slate-400">
                            {format(new Date(quote.createdAt), "d MMM yyyy", {
                              locale: fr,
                            })}
                          </td>
                          <td className="whitespace-nowrap px-5 py-3 text-right font-medium tabular-nums text-slate-900 dark:text-white">
                            {quote.totals
                              ? formatDa(quote.totals.totalTtc)
                              : "—"}
                          </td>
                          <td className="whitespace-nowrap px-5 py-3 text-right">
                            <a
                              href={`/api/quotes/${quote.id}/pdf`}
                              className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
                            >
                              PDF
                              <ExternalLink
                                className="h-3 w-3"
                                aria-hidden="true"
                              />
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={`${SURFACE} overflow-hidden`}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 p-5 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <Receipt className="h-4 w-4 text-slate-400" aria-hidden="true" />
                <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                  Factures associées
                </h2>
              </div>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {clientInvoices.length}
              </span>
            </div>

            {registriesLoading ? (
              <div className="p-5">
                <LoadingSkeleton rows={2} />
              </div>
            ) : clientInvoices.length === 0 ? (
              <p className="p-5 text-sm text-slate-500 dark:text-slate-400">
                Aucune facture émise pour ce client.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                    <tr>
                      <th className="px-5 py-3 font-semibold">Numéro</th>
                      <th className="px-5 py-3 font-semibold">Bon</th>
                      <th className="px-5 py-3 font-semibold">Immeuble</th>
                      <th className="px-5 py-3 font-semibold">Émise le</th>
                      <th className="px-5 py-3 text-right font-semibold">
                        Montant
                      </th>
                      <th className="px-5 py-3 font-semibold">Statut</th>
                      <th className="px-5 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {clientInvoices.map((invoice) => {
                      const tone = invoiceTone(invoice.status);
                      return (
                        <tr
                          key={invoice.id}
                          className="transition-colors hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
                        >
                          <td className="whitespace-nowrap px-5 py-3 font-mono text-xs font-semibold text-slate-900 dark:text-white">
                            {invoice.number}
                          </td>
                          <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-slate-500 dark:text-slate-400">
                            {invoice.orderNumber}
                          </td>
                          <td className="whitespace-nowrap px-5 py-3 text-slate-500 dark:text-slate-400">
                            {invoice.buildingName}
                          </td>
                          <td className="whitespace-nowrap px-5 py-3 text-slate-500 dark:text-slate-400">
                            {format(new Date(invoice.issuedAt), "d MMM yyyy", {
                              locale: fr,
                            })}
                          </td>
                          <td className="whitespace-nowrap px-5 py-3 text-right font-medium tabular-nums text-slate-900 dark:text-white">
                            {formatDzd(invoice.amount) ?? "—"}
                          </td>
                          <td className="whitespace-nowrap px-5 py-3">
                            <span
                              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE[tone.tone].pill}`}
                            >
                              {tone.label}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-5 py-3 text-right">
                            <a
                              href={`/api/invoices/${invoice.id}/pdf`}
                              className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
                            >
                              PDF
                              <ExternalLink
                                className="h-3 w-3"
                                aria-hidden="true"
                              />
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ── Onglet 3 : Registre d'archivage ─────────────────── */}
      {tab === "archive" && (
        <div className="order-1 space-y-5">
          {/* ── Interventions ─────────────────────────────────── */}
          <section className={`${SURFACE} overflow-hidden`}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-5 dark:border-slate-800">
              <div className="flex items-start gap-2">
                <History className="mt-0.5 h-4 w-4 text-slate-400" aria-hidden="true" />
                <div>
                  <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                    Historique des interventions
                  </h2>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    Pannes résolues et entretiens préventifs, du plus récent au
                    plus ancien.
                  </p>
                </div>
              </div>
              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-semibold tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {clientWorkOrders.length} intervention
                {clientWorkOrders.length === 1 ? "" : "s"}
              </span>
            </div>

            {registriesLoading ? (
              <div className="p-5">
                <LoadingSkeleton rows={3} />
              </div>
            ) : clientWorkOrders.length === 0 ? (
              <p className="p-5 text-sm text-slate-500 dark:text-slate-400">
                Aucune intervention enregistrée sur les appareils de ce client.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                    <tr>
                      <th className="px-5 py-3 font-semibold">Date</th>
                      <th className="px-5 py-3 font-semibold">Bon de travail</th>
                      <th className="px-5 py-3 font-semibold">Appareil</th>
                      <th className="px-5 py-3 font-semibold">Type</th>
                      <th className="px-5 py-3 font-semibold">Statut</th>
                      <th className="px-5 py-3 font-semibold">Technicien</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {clientWorkOrders.map((order) => {
                      const tone = workOrderTone(order.status);
                      const date =
                        order.completedAt ??
                        order.scheduledDate ??
                        order.createdAt;
                      return (
                        <tr
                          key={order.id}
                          className="transition-colors hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
                        >
                          <td className="whitespace-nowrap px-5 py-3 text-slate-500 dark:text-slate-400">
                            {formatDate(date)}
                          </td>
                          <td className="px-5 py-3">
                            <Link
                              href={`/bons-de-travail/${order.id}`}
                              className="font-mono text-xs font-semibold text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-500 dark:text-white dark:decoration-slate-600"
                            >
                              {order.orderNumber}
                            </Link>
                            <p className="mt-0.5 max-w-[18rem] truncate text-xs text-slate-500 dark:text-slate-400">
                              {order.title}
                            </p>
                          </td>
                          <td className="px-5 py-3">
                            <p className="font-mono text-xs font-semibold text-slate-900 dark:text-white">
                              {order.elevator.elevatorCode}
                            </p>
                            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                              {order.elevator.building?.name ?? "—"}
                            </p>
                          </td>
                          <td className="whitespace-nowrap px-5 py-3">
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                              {enumLabel(order.type)}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-5 py-3">
                            <span
                              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE[tone.tone].pill}`}
                            >
                              {tone.label}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-5 py-3 text-slate-700 dark:text-slate-200">
                            {order.assignedTo?.name ?? (
                              <span className="text-slate-400 dark:text-slate-500">
                                Non affecté
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── Pièces remplacées ─────────────────────────────── */}
          <section className={`${SURFACE} overflow-hidden`}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-5 dark:border-slate-800">
              <div className="flex items-start gap-2">
                <Package className="mt-0.5 h-4 w-4 text-slate-400" aria-hidden="true" />
                <div>
                  <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                    Historique des pièces remplacées
                  </h2>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    Traçabilité des composants changés, appareil par appareil.
                  </p>
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                Appareil
                <select
                  value={partElevator}
                  onChange={(event) => setPartElevator(event.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                >
                  <option value="ALL">Tous les appareils</option>
                  {clientElevators.map(({ elevator, buildingName }) => (
                    <option key={elevator.id} value={elevator.id}>
                      {elevator.elevatorCode} — {buildingName}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {registriesLoading ? (
              <div className="p-5">
                <LoadingSkeleton rows={3} />
              </div>
            ) : visibleParts.length === 0 ? (
              <p className="p-5 text-sm text-slate-500 dark:text-slate-400">
                Aucune pièce remplacée n&apos;est enregistrée
                {partElevator === "ALL"
                  ? " pour ce client."
                  : " pour cet appareil."}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                    <tr>
                      <th className="px-5 py-3 font-semibold">Date</th>
                      <th className="px-5 py-3 font-semibold">Appareil</th>
                      <th className="px-5 py-3 font-semibold">Bon</th>
                      <th className="px-5 py-3 font-semibold">Pièce</th>
                      <th className="px-5 py-3 font-semibold">Référence</th>
                      <th className="px-5 py-3 text-right font-semibold">Qté</th>
                      <th className="px-5 py-3 font-semibold">Technicien</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {visibleParts.map((part) => (
                      <tr
                        key={part.key}
                        className="transition-colors hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
                      >
                        <td className="whitespace-nowrap px-5 py-3 text-slate-500 dark:text-slate-400">
                          {formatDate(part.date)}
                        </td>
                        <td className="px-5 py-3">
                          <p className="font-mono text-xs font-semibold text-slate-900 dark:text-white">
                            {part.elevatorCode}
                          </p>
                          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                            {part.buildingName}
                          </p>
                        </td>
                        <td className="whitespace-nowrap px-5 py-3">
                          <Link
                            href={`/bons-de-travail/${part.workOrderId}`}
                            className="font-mono text-xs text-slate-600 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-500 dark:text-slate-300 dark:decoration-slate-600"
                          >
                            {part.orderNumber}
                          </Link>
                        </td>
                        <td className="px-5 py-3 text-slate-700 dark:text-slate-200">
                          {part.name}
                        </td>
                        <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-slate-500 dark:text-slate-400">
                          {part.partNumber ?? "—"}
                        </td>
                        <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums text-slate-700 dark:text-slate-200">
                          {part.quantity}
                        </td>
                        <td className="whitespace-nowrap px-5 py-3 text-slate-500 dark:text-slate-400">
                          {part.technicianName ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ── QR d'un appareil ─────────────────────────────────── */}
      {qrFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`QR Code de l'appareil ${qrFor.elevatorCode}`}
          onClick={() => setQrFor(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl dark:bg-slate-900"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">
                  QR Code
                </h3>
                <p className="font-mono text-xs text-slate-500 dark:text-slate-400">
                  {qrFor.elevatorCode}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setQrFor(null)}
                aria-label="Fermer"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="mt-4 flex justify-center rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/elevators/${qrFor.id}/qr`}
                alt={`QR Code de l'appareil ${qrFor.elevatorCode}`}
                className="h-56 w-56"
              />
            </div>

            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              Ce code est apposé sur l&apos;appareil. Un client le scanne pour
              ouvrir le portail et signaler une panne.
            </p>

            <a
              href={`/api/elevators/${qrFor.id}/qr`}
              target="_blank"
              rel="noreferrer"
              className={`${BTN_SECONDARY} mt-4 w-full`}
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Ouvrir dans un onglet
            </a>
          </div>
        </div>
      )}

      {/* ── Historique des pannes d'un appareil ──────────────── */}
      {historyFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Historique des pannes de ${historyFor.elevatorCode}`}
          onClick={() => setHistoryFor(null)}
        >
          <div
            className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl dark:bg-slate-900"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">
                  Historique des pannes
                </h3>
                <p className="font-mono text-xs text-slate-500 dark:text-slate-400">
                  {historyFor.elevatorCode} · {historyRows.length} signalement
                  {historyRows.length === 1 ? "" : "s"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setHistoryFor(null)}
                aria-label="Fermer"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            {historyRows.length === 0 ? (
              <p className="mt-6 rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                Aucune panne enregistrée sur cet appareil.
              </p>
            ) : (
              <ul className="mt-4 max-h-[60vh] space-y-3 overflow-y-auto pr-1">
                {historyRows.map((incident) => {
                  const tone = incidentTone(incident.status);
                  return (
                    <li
                      key={incident.id}
                      className="rounded-xl border border-slate-200 p-3 dark:border-slate-800"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-slate-900 dark:text-white">
                          {incident.incidentNumber}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE[tone.tone].pill}`}
                        >
                          {tone.label}
                        </span>
                        <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
                          {format(new Date(incident.createdAt), "d MMM yyyy", {
                            locale: fr,
                          })}
                        </span>
                      </div>
                      {incident.notes && (
                        <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-300">
                          {incident.notes}
                        </p>
                      )}
                      {incident.resolvedAt && (
                        <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">
                          Résolue le{" "}
                          {format(new Date(incident.resolvedAt), "d MMM yyyy", {
                            locale: fr,
                          })}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setHistoryFor(null)}
                className={BTN_SECONDARY}
              >
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Nouvel immeuble ────────────────────────────────────────

function AddBuildingForm({
  clientId,
  clientName,
  clientPhone,
  onDone,
  onCancel,
}: {
  clientId: string;
  clientName: string;
  clientPhone: string | null;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  // Le contact sur site est obligatoire côté API, et à l'ouverture d'un dossier
  // c'est le client lui-même. Le pré-remplir évite de faire retaper ce que
  // l'écran vient d'afficher, sans l'imposer : le champ reste modifiable.
  const [contactPerson, setContactPerson] = useState(clientName);
  const [contactPhone, setContactPhone] = useState(clientPhone ?? "");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [slaTier, setSlaTier] = useState("STANDARD");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setError("");

    let latitude: number | undefined;
    let longitude: number | undefined;
    if (lat.trim() !== "" || lng.trim() !== "") {
      const parsedLat = parseDecimalInput(lat, { allowNegative: true });
      const parsedLng = parseDecimalInput(lng, { allowNegative: true });
      if (
        parsedLat === null ||
        parsedLng === null ||
        parsedLat < -90 ||
        parsedLat > 90 ||
        parsedLng < -180 ||
        parsedLng > 180
      ) {
        setError(
          "Renseignez la latitude et la longitude ensemble, dans leurs bornes, ou laissez les deux vides."
        );
        return;
      }
      latitude = parsedLat;
      longitude = parsedLng;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/buildings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          address: address.trim(),
          city: city.trim(),
          contactPerson: contactPerson.trim(),
          ...(contactPhone.trim() ? { contactPhone: contactPhone.trim() } : {}),
          slaTier,
          ...(latitude !== undefined && longitude !== undefined
            ? { latitude, longitude }
            : {}),
          ownerId: clientId,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        const issues = payload?.details?.issues ?? [];
        if (Array.isArray(issues) && issues.length > 0) {
          throw new Error(
            issues.map((i: { message: string }) => i.message).join(" ")
          );
        }
        throw new Error(payload?.error ?? "La création de l'immeuble a échoué.");
      }
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "La création de l'immeuble a échoué.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold text-gray-900 dark:text-white">
          Nouvel immeuble
        </h3>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Fermer"
          className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="mt-4 space-y-4"
        noValidate
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="b-name" className={LABEL}>
              Nom de l&apos;immeuble
            </label>
            <input
              id="b-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              placeholder="Résidence Les Oliviers"
              className={FIELD}
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="b-address" className={LABEL}>
              Adresse du site
            </label>
            <input
              id="b-address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              required
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor="b-city" className={LABEL}>
              Ville
            </label>
            <input
              id="b-city"
              value={city}
              onChange={(event) => setCity(event.target.value)}
              required
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor="b-sla" className={LABEL}>
              Palier de service
            </label>
            <select
              id="b-sla"
              value={slaTier}
              onChange={(event) => setSlaTier(event.target.value)}
              className={FIELD}
            >
              {SLA_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {enumLabel(tier)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="b-contact" className={LABEL}>
              Contact sur site
            </label>
            <input
              id="b-contact"
              value={contactPerson}
              onChange={(event) => setContactPerson(event.target.value)}
              required
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor="b-phone" className={LABEL}>
              Téléphone du contact{" "}
              <span className="text-gray-400">(facultatif)</span>
            </label>
            <input
              id="b-phone"
              value={contactPhone}
              onChange={(event) => setContactPhone(event.target.value)}
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor="b-lat" className={LABEL}>
              Latitude <span className="text-gray-400">(facultatif)</span>
            </label>
            <input
              id="b-lat"
              value={lat}
              onChange={(event) => setLat(event.target.value)}
              inputMode="decimal"
              placeholder="36.7538"
              aria-describedby="b-coords-aide"
              className={FIELD_NUM}
            />
          </div>
          <div>
            <label htmlFor="b-lng" className={LABEL}>
              Longitude <span className="text-gray-400">(facultatif)</span>
            </label>
            <input
              id="b-lng"
              value={lng}
              onChange={(event) => setLng(event.target.value)}
              inputMode="decimal"
              placeholder="3.0588"
              aria-describedby="b-coords-aide"
              className={FIELD_NUM}
            />
          </div>
          <p
            id="b-coords-aide"
            className="text-xs text-gray-500 sm:col-span-2 dark:text-gray-400"
          >
            Les deux ensemble ou aucune. Elles servent au contrôle de distance
            lors du pointage d&apos;arrivée du technicien.
          </p>
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
          >
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Annuler
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            Créer l&apos;immeuble
          </button>
        </div>
      </form>
    </Card>
  );
}

// ─── Rattacher un immeuble existant ─────────────────────────

function AttachBuildingPanel({
  clientId,
  clientName,
  buildings,
  truncated,
  query,
  onQueryChange,
  onDone,
  onCancel,
}: {
  clientId: string;
  clientName: string;
  buildings: AttachableRow[];
  truncated: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const attach = async (building: AttachableRow) => {
    setError("");

    /**
     * Déplacer un immeuble qui appartient déjà à quelqu'un d'autre se confirme.
     * Le rattachement d'un immeuble sans propriétaire, non : c'est l'acte normal
     * d'ouverture d'un dossier, et le faire confirmer apprendrait à valider sans
     * lire — ce qui est exactement ce qu'on ne veut pas le jour où il y a
     * vraiment quelque chose à lire.
     */
    if (
      building.owner &&
      !window.confirm(
        `« ${building.name} » appartient actuellement à ${building.owner.name}.\n\n` +
          `Le rattacher à ${clientName} ? ${building.owner.name} perdra l'accès à ce site.`
      )
    ) {
      return;
    }

    setBusyId(building.id);
    try {
      const res = await fetch(`/api/clients/${clientId}/buildings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buildingId: building.id }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.error ?? "Le rattachement a échoué.");
      }
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Le rattachement a échoué.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">
            Rattacher un immeuble existant
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Pour un site déjà en base — parc saisi avant l&apos;ouverture du
            compte, ou immeuble qui change de gestionnaire.
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Fermer"
          className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-4">
        <label htmlFor="attach-search" className="sr-only">
          Rechercher un immeuble
        </label>
        <input
          id="attach-search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Rechercher par nom, adresse ou ville…"
          className={FIELD}
        />
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
        >
          {error}
        </p>
      )}

      {buildings.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
          {query.trim()
            ? "Aucun immeuble ne correspond à cette recherche."
            : "Aucun autre immeuble disponible."}
        </p>
      ) : (
        <>
          <ul className="mt-4 divide-y divide-gray-100 dark:divide-gray-800">
            {buildings.map((building) => (
              <li
                key={building.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    {building.name}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {building.address}, {building.city} · {building.elevatorCount}{" "}
                    appareil{building.elevatorCount > 1 ? "s" : ""}
                  </p>
                  {building.owner && (
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                      Actuellement rattaché à {building.owner.name}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void attach(building)}
                  disabled={busyId === building.id}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  {busyId === building.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  Rattacher
                </button>
              </li>
            ))}
          </ul>
          {truncated && (
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              Seuls les cinquante premiers résultats sont affichés — affinez la
              recherche pour trouver un autre site.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

// ─── Nouvel ascenseur ───────────────────────────────────────

function AddElevatorForm({
  buildingId,
  buildingName,
  onDone,
  onCancel,
}: {
  buildingId: string;
  buildingName: string;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [elevatorCode, setElevatorCode] = useState("");
  const [brand, setBrand] = useState<string>(ELEVATOR_BRANDS[0]);
  const [model, setModel] = useState("");
  const [installationLocation, setInstallationLocation] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [motorType, setMotorType] = useState<string>(MOTOR_TYPES[0]);
  const [controllerType, setControllerType] = useState<string>(
    CONTROLLER_TYPES[0]
  );
  const [maxPayloadKg, setMaxPayloadKg] = useState("400");
  const [floorsServed, setFloorsServed] = useState("");
  const [installationDate, setInstallationDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setError("");

    const payload = parseDecimalInput(maxPayloadKg);
    if (payload === null || payload <= 0 || payload > 10000) {
      setError("La charge maximale doit être un nombre de kilos entre 1 et 10 000.");
      return;
    }
    const floors = parseDecimalInput(floorsServed);
    if (floors === null || floors < 1 || floors > 200 || !Number.isInteger(floors)) {
      setError("Le nombre de niveaux doit être un entier entre 1 et 200.");
      return;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(elevatorCode.trim())) {
      setError(
        "Le code de l'appareil ne peut contenir que des lettres, des chiffres, - et _."
      );
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/elevators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elevatorCode: elevatorCode.trim(),
          buildingId,
          brand,
          model: model.trim(),
          ...(installationLocation.trim()
            ? { installationLocation: installationLocation.trim() }
            : {}),
          ...(serialNumber.trim() ? { serialNumber: serialNumber.trim() } : {}),
          // L'API attend une date ISO complète ; le champ `date` du navigateur
          // rend « 2024-05-12 », qui n'est pas un `datetime`.
          ...(installationDate
            ? {
                installationDate: new Date(
                  `${installationDate}T00:00:00.000Z`
                ).toISOString(),
              }
            : {}),
          motorType,
          maxPayloadKg: payload,
          controllerType,
          floorsServed: floors,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const issues = body?.details?.issues ?? [];
        if (Array.isArray(issues) && issues.length > 0) {
          throw new Error(
            issues.map((i: { message: string }) => i.message).join(" ")
          );
        }
        throw new Error(body?.error ?? "La création de l'appareil a échoué.");
      }
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "La création de l'appareil a échoué.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="mt-3 space-y-4 rounded-lg border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-900 dark:bg-blue-950/20"
      noValidate
    >
      <div className="flex items-start justify-between gap-3">
        <h5 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
          <Wrench className="h-4 w-4 text-gray-400" aria-hidden="true" />
          Nouvel appareil — {buildingName}
        </h5>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Fermer"
          className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      <p className="text-xs text-gray-600 dark:text-gray-300">
        Toutes les caractéristiques sont demandées : les seuils d&apos;alerte et
        la durée de vie des pièces se calculent dessus. Relevez-les sur la plaque
        constructeur.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="e-code" className={LABEL}>
            Code de l&apos;appareil
          </label>
          <input
            id="e-code"
            value={elevatorCode}
            onChange={(event) => setElevatorCode(event.target.value)}
            required
            placeholder="MPT-04"
            className={`${FIELD} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="e-serial" className={LABEL}>
            N° de série <span className="text-gray-400">(facultatif)</span>
          </label>
          <input
            id="e-serial"
            value={serialNumber}
            onChange={(event) => setSerialNumber(event.target.value)}
            className={FIELD}
          />
        </div>
        <div>
          <label htmlFor="e-brand" className={LABEL}>
            Marque
          </label>
          <select
            id="e-brand"
            value={brand}
            onChange={(event) => setBrand(event.target.value)}
            className={FIELD}
          >
            {ELEVATOR_BRANDS.map((value) => (
              <option key={value} value={value}>
                {enumLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="e-model" className={LABEL}>
            Modèle
          </label>
          <input
            id="e-model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            required
            className={FIELD}
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="e-location" className={LABEL}>
            Lieu d&apos;installation{" "}
            <span className="text-gray-400">(facultatif)</span>
          </label>
          <input
            id="e-location"
            value={installationLocation}
            onChange={(event) => setInstallationLocation(event.target.value)}
            placeholder="Ex. : Bâtiment A, 3e étage, cage de gauche"
            className={FIELD}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Complète l&apos;adresse de l&apos;immeuble sur la fiche du client et
            sur le bon du technicien.
          </p>
        </div>
        <div>
          <label htmlFor="e-motor" className={LABEL}>
            Type de moteur
          </label>
          <select
            id="e-motor"
            value={motorType}
            onChange={(event) => setMotorType(event.target.value)}
            className={FIELD}
          >
            {MOTOR_TYPES.map((value) => (
              <option key={value} value={value}>
                {enumLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="e-controller" className={LABEL}>
            Type de commande
          </label>
          <select
            id="e-controller"
            value={controllerType}
            onChange={(event) => setControllerType(event.target.value)}
            className={FIELD}
          >
            {CONTROLLER_TYPES.map((value) => (
              <option key={value} value={value}>
                {enumLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="e-payload" className={LABEL}>
            Charge maximale (kg)
          </label>
          <input
            id="e-payload"
            value={maxPayloadKg}
            onChange={(event) => setMaxPayloadKg(event.target.value)}
            inputMode="numeric"
            required
            className={FIELD_NUM}
          />
        </div>
        <div>
          <label htmlFor="e-floors" className={LABEL}>
            Niveaux desservis
          </label>
          <input
            id="e-floors"
            value={floorsServed}
            onChange={(event) => setFloorsServed(event.target.value)}
            inputMode="numeric"
            required
            className={FIELD_NUM}
          />
        </div>
        <div>
          <label htmlFor="e-installed" className={LABEL}>
            Mise en service{" "}
            <span className="text-gray-400">(facultatif)</span>
          </label>
          <input
            id="e-installed"
            type="date"
            value={installationDate}
            onChange={(event) => setInstallationDate(event.target.value)}
            className={FIELD}
          />
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
        >
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          Annuler
        </button>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          Enregistrer l&apos;appareil
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}
