"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import {
  AlertTriangle,
  ClipboardList,
  Download,
  FileCheck,
  Receipt,
  RefreshCw,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { ContractSlaBadge } from "@/components/contracts/contract-sla-badge";
import { InfoHint } from "@/components/ui/info-hint";
import {
  TrafficDot,
  TrafficLegend,
  TrafficPill,
} from "@/components/ui/traffic";
import {
  TRAFFIC_LEVELS,
  elevatorTrafficLabel,
  elevatorTrafficLevel,
  type TrafficLevel,
} from "@/lib/ui/traffic";
import type { CoverageContract } from "@/lib/contracts/coverage";
import { enumLabel } from "@/lib/ui/enum-labels";
import { formatDzd } from "@/lib/ui/money";
import { ClientQuotesCard } from "@/components/client/quotes-card";
import { ProgressTrack } from "@/components/ui/progress-track";
import { ValidationBadge } from "@/components/ui/validation-badge";
import { EmergencyButton } from "@/components/client/emergency-button";
import type { EmergencyElevator } from "@/components/client/emergency-button";
import { IncidentWizard } from "@/components/client/incident-wizard";
import { NonContractedPortal } from "@/components/client/non-contracted-portal";
import { InterventionActions } from "@/components/client/intervention-actions";
import { isNonContractedClient } from "@/types";
import type { IncidentStatus } from "@/types";

/**
 * The building occupant's portal.
 *
 * FRENCH, DELIBERATELY
 * Every screen behind a staff login is English; this one is French. Its
 * readers are tenants and building managers, not the maintenance company, and
 * the portal's whole purpose is that a non-technical person can resolve a
 * stuck lift without a phone call. Asking them to work in a second language
 * works against that.
 *
 * TWO WAYS IN, ON PURPOSE
 * The wizard is the good path — identify the code, follow the steps, most
 * faults clear. The red button is the path for someone who cannot or should
 * not read a page right now. Neither replaces the other; both are visible at
 * once rather than behind a toggle, because in the moment nobody goes looking
 * for an accessibility setting.
 *
 * THIS IS THE CONTRACTED PORTAL
 * Everything above assumes we already hold the customer's file: the wizard
 * picks an elevator from a list, and the red button escalates a fault on one.
 * Neither is possible for a customer with no contract and therefore no
 * equipment registered, so those accounts are routed to
 * `NonContractedPortal` before any of this renders. The two are genuinely
 * different products sharing a route, which is why the split is a branch at
 * the top rather than a few hidden controls further down.
 */

interface IncidentRow {
  id: string;
  incidentNumber: string;
  status: IncidentStatus;
  isDirectTransfer: boolean;
  notes: string | null;
  createdAt: string;
  resolvedAt: string | null;
  elevator: {
    id: string;
    elevatorCode: string;
    building: { id: string; name: string };
  };
  errorCode: { id: string; code: string; title: string } | null;
  technician: { id: string; name: string | null } | null;
}

interface ElevatorRow {
  id: string;
  elevatorCode: string;
  /** L'état de service, pour la pastille verte/orange/rouge du résumé. */
  status: string;
  building: { id: string; name: string };
}

interface InvoiceRow {
  id: string;
  number: string;
  issuedAt: string;
  amount: string | number;
  currency: string;
  orderNumber: string;
  orderTitle: string;
  buildingName: string;
}

interface WorkOrderRow {
  id: string;
  orderNumber: string;
  title: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  elevator: {
    elevatorCode: string;
    building: { name: string };
  };
}

function formatDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

/**
 * Un appareil tel que ce portail le lit : ce que le bouton d'urgence et
 * l'assistant attendent, plus l'état de service qui alimente la pastille.
 */
type PortalElevator = EmergencyElevator & { status: string };

export default function ClientPortalPage() {
  const { data: session, status } = useSession();
  const [elevators, setElevators] = useState<PortalElevator[]>([]);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [invoiceError, setInvoiceError] = useState("");
  /**
   * Les contrats qui couvrent le portefeuille de ce compte.
   *
   * La route ne reçoit aucun identifiant : elle lit le client dans la session.
   * Un client ne peut donc pas demander les contrats d'un autre en changeant
   * une adresse.
   */
  const [contracts, setContracts] = useState<CoverageContract[]>([]);
  const [contractsLoaded, setContractsLoaded] = useState(false);
  const [contractError, setContractError] = useState("");
  /**
   * L'historique des interventions, chargé à part.
   *
   * Une panne de cette lecture ne doit pas priver le client du bouton
   * d'urgence : la section affiche son propre message et le reste du portail
   * continue de fonctionner.
   */
  const [workOrders, setWorkOrders] = useState<WorkOrderRow[]>([]);
  const [workOrdersLoaded, setWorkOrdersLoaded] = useState(false);
  const [workOrderError, setWorkOrderError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // NULL reads as contracted — an account created before this distinction
  // existed keeps the portal it has always had. See `@/types`.
  const nonContracted = isNonContractedClient(session?.user);

  const load = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true);
    setError("");

    try {
      const [elevatorRes, incidentRes] = await Promise.all([
        fetch("/api/elevators"),
        // `mine=true` rather than relying on the portfolio scope alone: a
        // building owner with colleagues would otherwise see fault reports
        // filed by staff at other sites under the same owner.
        fetch("/api/incidents?mine=true&limit=25"),
      ]);

      if (!elevatorRes.ok) {
        throw new Error(`Impossible de charger vos ascenseurs (${elevatorRes.status})`);
      }
      if (!incidentRes.ok) {
        throw new Error(`Impossible de charger vos signalements (${incidentRes.status})`);
      }

      const elevatorJson = await elevatorRes.json();
      const incidentJson = await incidentRes.json();

      setElevators(
        (elevatorJson.data ?? []).map((e: ElevatorRow) => ({
          id: e.id,
          elevatorCode: e.elevatorCode,
          status: e.status,
          buildingName: e.building?.name ?? "Bâtiment inconnu",
        }))
      );
      setIncidents(incidentJson.data ?? []);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Une erreur est survenue. Réessayez."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Les factures sont chargées à part, et leur échec ne contamine rien.
   *
   * C'est délibéré. Ce portail porte le bouton d'urgence, et ce bouton doit
   * rester disponible même si la facturation est en panne : demander les
   * factures dans le même `Promise.all` que les ascenseurs ferait basculer
   * l'écran entier sur une erreur, et une personne devant une cabine bloquée
   * verrait un message d'erreur à la place du seul bouton qui compte.
   */
  const loadInvoices = useCallback(async () => {
    setInvoiceError("");
    try {
      const res = await fetch("/api/invoices?limit=20");
      if (!res.ok) {
        throw new Error(`Impossible de charger vos factures (${res.status})`);
      }
      const json = await res.json();
      setInvoices(json.data ?? []);
    } catch (e) {
      setInvoiceError(
        e instanceof Error ? e.message : "Impossible de charger vos factures."
      );
    }
  }, []);

  /**
   * Les contrats sont chargés à part, comme les factures.
   *
   * Une panne de la couverture ne doit pas priver le client du bouton
   * d'urgence : la section affiche son propre message, le reste du portail
   * continue de fonctionner. Aucun identifiant n'est envoyé — le serveur lit le
   * titulaire dans la session.
   */
  const loadContracts = useCallback(async () => {
    setContractError("");
    try {
      const res = await fetch("/api/contracts/coverage");
      if (!res.ok) {
        throw new Error(`Impossible de charger vos contrats (${res.status})`);
      }
      const json = await res.json();
      setContracts(Array.isArray(json?.data) ? json.data : []);
    } catch (e) {
      setContractError(
        e instanceof Error ? e.message : "Impossible de charger vos contrats."
      );
    } finally {
      setContractsLoaded(true);
    }
  }, []);

  const loadWorkOrders = useCallback(async () => {
    setWorkOrderError("");
    try {
      const res = await fetch("/api/work-orders?limit=20");
      if (!res.ok) {
        throw new Error(
          `Impossible de charger l'historique des interventions (${res.status})`
        );
      }
      const json = await res.json();
      setWorkOrders(Array.isArray(json?.data) ? json.data : []);
    } catch (e) {
      setWorkOrderError(
        e instanceof Error
          ? e.message
          : "Impossible de charger l'historique des interventions."
      );
    } finally {
      setWorkOrdersLoaded(true);
    }
  }, []);

  useEffect(() => {
    // Wait for the session before fetching: until it resolves we do not know
    // which portal this account gets, and firing both requests for a
    // non-contracted client would surface two errors for data that does not
    // exist for them by design.
    if (status === "loading") return;

    if (nonContracted) {
      setLoading(false);
      return;
    }

    void load();
    void loadInvoices();
    void loadContracts();
    void loadWorkOrders();

    /**
     * L'état « en direct » demandé par le portail : les appareils et les
     * signalements sont relus toutes les trente secondes. Les factures, les
     * contrats et l'historique ne changent pas à cette cadence — les recharger
     * aussi serait du trafic pour rien.
     */
    const id = window.setInterval(() => {
      void load({ silent: true });
    }, 30_000);

    return () => window.clearInterval(id);
  }, [load, loadContracts, loadInvoices, loadWorkOrders, nonContracted, status]);

  const refresh = useCallback(() => {
    void load({ silent: true });
    void loadInvoices();
    void loadContracts();
    void loadWorkOrders();
  }, [load, loadContracts, loadInvoices, loadWorkOrders]);

  // Checked before the loading state so a non-contracted client never sees the
  // emergency skeleton of a portal that is not theirs.
  if (nonContracted) return <NonContractedPortal />;

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-40 rounded-2xl bg-gray-100 dark:bg-gray-800 animate-pulse" />
        <div className="h-64 rounded-2xl bg-gray-100 dark:bg-gray-800 animate-pulse" />
      </div>
    );
  }

  if (error && elevators.length === 0) {
    return <ErrorState message={error} onRetry={load} />;
  }

  /**
   * Le résumé visuel, compté une fois.
   *
   * Le client n'a pas à lire dix lignes de statut pour savoir si son immeuble
   * va bien : il doit voir un chiffre et une couleur. Le détail par appareil
   * reste juste en dessous, mais la première information est un état, pas une
   * liste.
   */
  const counts: Record<TrafficLevel, number> = {
    ok: 0,
    warning: 0,
    danger: 0,
    neutral: 0,
  };
  for (const elevator of elevators) {
    counts[elevatorTrafficLevel(elevator.status)] += 1;
  }
  const buildingCount = new Set(elevators.map((e) => e.buildingName)).size;

  function scrollToReport(event: React.MouseEvent<HTMLAnchorElement>) {
    const target = document.getElementById("signaler");
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.querySelector<HTMLElement>("button, input, textarea, select")?.focus({
      preventScroll: true,
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/*
        Le résumé passe avant le bouton d'urgence : il répond à la question que
        le client se pose en arrivant — « est-ce que mes appareils vont bien ? »
        — puis offre l'action de signalement à côté de la réponse, sans qu'il
        faille chercher plus bas.
      */}
      <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <div className="px-5 py-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                État de mes appareils
              </p>
              <h2 className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                {elevators.length === 0
                  ? "Aucun appareil rattaché"
                  : `${elevators.length} ascenseur${
                      elevators.length > 1 ? "s" : ""
                    } · ${buildingCount} immeuble${buildingCount > 1 ? "s" : ""}`}
              </h2>

              {elevators.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {counts.ok > 0 && (
                    <TrafficPill level="ok" label={`${counts.ok} en service`} />
                  )}
                  {counts.warning > 0 && (
                    <TrafficPill
                      level="warning"
                      label={`${counts.warning} à surveiller`}
                    />
                  )}
                  {counts.danger > 0 && (
                    <TrafficPill
                      level="danger"
                      label={`${counts.danger} en panne`}
                    />
                  )}
                  {counts.neutral > 0 && (
                    <TrafficPill
                      level="neutral"
                      label={`${counts.neutral} hors ligne`}
                    />
                  )}
                </div>
              )}
            </div>

            {elevators.length > 0 && (
              <a
                href="#signaler"
                onClick={scrollToReport}
                className="inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-base font-bold text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900 sm:w-auto"
              >
                <AlertTriangle className="h-5 w-5" aria-hidden="true" />
                Signaler une panne
              </a>
            )}
          </div>

          {elevators.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
              Aucun équipement n&apos;est encore rattaché à votre compte.
              Contactez le bureau pour faire ajouter vos appareils.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-gray-100 dark:divide-gray-800">
              {/* Trois appareils au plus : le résumé doit tenir au-dessus de la
                  ligne de flottaison, pour que le bouton d'urgence qui suit
                  reste atteignable sans faire défiler une liste. */}
              {elevators.slice(0, 3).map((elevator) => {
                const level = elevatorTrafficLevel(elevator.status);
                return (
                  <li
                    key={elevator.id}
                    className="flex items-center gap-3 py-3"
                  >
                    <TrafficDot
                      level={level}
                      size="lg"
                      pulse
                      label={elevatorTrafficLabel(elevator.status)}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">
                        {elevator.elevatorCode}
                      </p>
                      <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                        {elevator.buildingName}
                      </p>
                    </div>
                    <span
                      className={`text-xs font-medium ${TRAFFIC_LEVELS[level].text}`}
                    >
                      {elevatorTrafficLabel(elevator.status)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {elevators.length > 3 && (
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              et {elevators.length - 3} autre
              {elevators.length - 3 > 1 ? "s" : ""} appareil
              {elevators.length - 3 > 1 ? "s" : ""} rattaché
              {elevators.length - 3 > 1 ? "s" : ""} à vos immeubles.
            </p>
          )}
        </div>

        <div className="border-t border-gray-100 bg-gray-50/60 px-5 py-3 dark:border-gray-800 dark:bg-gray-950/40">
          <TrafficLegend compact />
        </div>
      </section>

      {/* Order matters: the emergency path is first on the page and first in
          the reading order, so it is reachable without scrolling past prose. */}
      <EmergencyButton elevators={elevators} onEscalated={refresh} />

      {/* Deliberately BELOW the red button. The note above explains why the
          emergency path is first; putting a choice of two ordinary actions in
          front of it would push it below the fold on a phone, which is the one
          thing that ordering exists to prevent. */}
      <InterventionActions
        contracted
        elevators={elevators}
        onRequested={refresh}
      />

      {/* The anchor the « Démarrage Maintenance » tile points at. Wrapping the
          wizard here rather than reaching into its internal heading id keeps
          this page's navigation from breaking when that component is edited. */}
      <div id="signaler" className="scroll-mt-6">
        <IncidentWizard elevators={elevators} onSubmitted={refresh} />
      </div>

      {/* The « Fiche Technique » entry point is deliberately NOT here. This
          portal belongs to contracted customers — we hold their file, so there
          is nothing for them to declare. The form exists for prospects with no
          contract, and they get their own portal; see
          `src/components/client/non-contracted-portal.tsx`. */}

      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-white">
            <ClipboardList className="h-5 w-5 text-gray-400" aria-hidden="true" />
            Mes signalements
          </h2>
          <button
            type="button"
            onClick={() => void load({ silent: true })}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Actualiser
          </button>
        </div>

        {incidents.length === 0 ? (
          <EmptyState
            className="mt-4"
            icon={ClipboardList}
            title="Aucun signalement"
            description="Quand vous signalez une panne, elle apparaît ici avec son numéro et son avancement, jusqu'à la clôture de l'intervention."
            action={{
              label: "Signaler une panne",
              icon: AlertTriangle,
              onClick: () =>
                document
                  .getElementById("signaler")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" }),
            }}
          />
        ) : (
          <ul className="mt-4 space-y-4">
            {incidents.map((incident) => (
              <li
                key={incident.id}
                className="rounded-xl border border-gray-200 dark:border-gray-800 p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                    {incident.incidentNumber}
                  </span>
                  <span className="font-semibold text-gray-900 dark:text-white">
                    {incident.elevator.elevatorCode}
                  </span>
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {incident.elevator.building.name}
                  </span>
                  {incident.isDirectTransfer && (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-800 dark:bg-red-900/40 dark:text-red-300">
                      Urgence
                    </span>
                  )}
                  <span className="ml-auto text-xs text-gray-400">
                    {formatDistanceToNow(new Date(incident.createdAt), {
                      addSuffix: true,
                      locale: fr,
                    })}
                  </span>
                </div>

                {incident.errorCode && (
                  <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                    <span className="font-mono font-semibold text-blue-700 dark:text-blue-400">
                      {incident.errorCode.code}
                    </span>{" "}
                    — {incident.errorCode.title}
                  </p>
                )}

                {incident.notes && !incident.isDirectTransfer && (
                  <p className="mt-1.5 text-sm text-gray-600 dark:text-gray-400">
                    {incident.notes}
                  </p>
                )}

                <div className="mt-3">
                  <ValidationBadge status={incident.status} locale="fr" />
                </div>

                <ProgressTrack
                  status={incident.status}
                  locale="fr"
                  className="mt-3"
                />

                {incident.technician && (
                  <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">
                    Technicien affecté :{" "}
                    <span className="font-medium text-gray-900 dark:text-white">
                      {incident.technician.name ?? "—"}
                    </span>
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ─── Historique des interventions ─────────────────────── */}
      <Card className="p-5">
        <h2 className="flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-white">
          <ClipboardList className="h-5 w-5 text-gray-400" aria-hidden="true" />
          Historique des interventions
        </h2>

        {workOrderError ? (
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
            {workOrderError}
          </p>
        ) : !workOrdersLoaded ? (
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
            Chargement de votre historique…
          </p>
        ) : workOrders.length === 0 ? (
          <EmptyState
            className="mt-4"
            icon={ClipboardList}
            title="Aucune intervention"
            description="Les visites d'entretien et les dépannages réalisés sur vos appareils apparaîtront ici, avec leur numéro et leur résultat."
            action={{
              label: "Signaler une panne",
              icon: AlertTriangle,
              onClick: () =>
                document
                  .getElementById("signaler")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" }),
            }}
          />
        ) : (
          <ul className="mt-4 divide-y divide-gray-100 dark:divide-gray-800">
            {workOrders.map((order) => (
              <li
                key={order.id}
                className="flex flex-wrap items-center justify-between gap-2 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    <span className="font-mono text-xs text-gray-500">
                      {order.orderNumber}
                    </span>{" "}
                    {order.title}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    {order.elevator.elevatorCode} —{" "}
                    {order.elevator.building.name} ·{" "}
                    {formatDay(order.completedAt ?? order.createdAt)}
                  </p>
                </div>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                  {enumLabel(order.status)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ─── Mes contrats & SLA ───────────────────────────────── */}
      <Card className="p-5">
        <h2 className="flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-white">
          <FileCheck className="h-5 w-5 text-gray-400" aria-hidden="true" />
          {session?.user?.role === "BUILDING_OWNER"
            ? "Mes contrats de maintenance"
            : "Contrats de maintenance"}
          <InfoHint term="coverage" />
        </h2>

        {!contractsLoaded ? (
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
            Chargement de vos contrats…
          </p>
        ) : contractError ? (
          // Le message reste dans la section : le reste du portail, dont le
          // bouton d'urgence, ne dépend pas de la couverture contractuelle.
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
            {contractError}
          </p>
        ) : contracts.length === 0 ? (
          <EmptyState
            className="mt-4"
            icon={FileCheck}
            title="Aucun contrat actif"
            description="Aucun contrat en vigueur ne couvre vos immeubles pour le moment. Le bureau peut vous indiquer la marche à suivre pour régulariser la situation."
          />
        ) : (
          <ul className="mt-4 space-y-4">
            {contracts.map((contract) => (
              <li
                key={contract.id}
                className="rounded-xl border border-gray-200 dark:border-gray-800 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-sm font-semibold text-gray-900 dark:text-white">
                    {contract.reference}
                  </span>
                  <ContractSlaBadge contract={contract} size="sm" />
                </div>

                <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                      Palier souscrit
                      <InfoHint term="tier" />
                    </dt>
                    <dd className="font-medium text-gray-900 dark:text-white">
                      {enumLabel(contract.slaTier)}
                    </dd>
                  </div>
                  <div>
                    <dt className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                      Engagements de service
                      <InfoHint term="sla" />
                    </dt>
                    <dd className="text-gray-700 dark:text-gray-300">
                      Prise en charge {contract.responseHours} h · intervention{" "}
                      {contract.interventionHours} h
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-gray-500 dark:text-gray-400">
                      Période
                    </dt>
                    <dd className="text-gray-700 dark:text-gray-300">
                      Du {formatDay(contract.startsAt)} au{" "}
                      {formatDay(contract.effectiveEndsAt)}
                    </dd>
                  </div>
                  <div>
                    <dt className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                      Renouvellement
                      <InfoHint term="tacitRenewal" />
                    </dt>
                    <dd className="text-gray-700 dark:text-gray-300">
                      {enumLabel(contract.renewalMode)} · préavis{" "}
                      {contract.noticeDays} jours
                    </dd>
                  </div>
                </dl>

                <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                  Immeubles couverts :{" "}
                  {contract.buildings
                    .map((building) => building.name)
                    .join(", ") || "—"}
                </p>

                {contract.effectiveStatus === "SUSPENDED" && (
                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                    Service suspendu — contactez le bureau.
                  </p>
                )}

                {(contract.expiry.level === "notice" ||
                  contract.expiry.level === "urgent") && (
                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                    Échéance dans {contract.expiry.days} jour
                    {contract.expiry.days > 1 ? "s" : ""}
                    {contract.renewalMode === "AUTO"
                      ? " — reconduction tacite prévue."
                      : " — sans reconduction automatique."}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ClientQuotesCard />

      {/* Une section, et non un onglet : ce portail n'a aucun onglet — tout y
          est empilé, et en introduire un pour la seule facturation ferait de ce
          bloc le seul endroit qu'on ne trouve pas en faisant défiler la page.
          L'ordre suit celui du parcours : signaler, suivre, consulter ses
          contrats, puis payer. */}
      <Card className="p-5">
        <h2 className="flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-white">
          <Receipt className="h-5 w-5 text-gray-400" aria-hidden="true" />
          Mes factures
        </h2>

        {invoiceError ? (
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
            {invoiceError}
          </p>
        ) : invoices.length === 0 ? (
          <EmptyState
            className="mt-4"
            icon={Receipt}
            title="Aucune facture"
            description="Les interventions couvertes par votre contrat ne sont pas facturées. Une facture n'apparaît ici que pour des travaux hors contrat."
          />
        ) : (
          <ul className="mt-4 divide-y divide-gray-100 dark:divide-gray-800">
            {invoices.map((invoice) => (
              <li
                key={invoice.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="font-mono text-sm font-medium text-gray-900 dark:text-white">
                    {invoice.number}
                  </p>
                  <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-300">
                    {invoice.orderTitle}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    {invoice.buildingName} ·{" "}
                    {new Date(invoice.issuedAt).toLocaleDateString("fr-FR", {
                      day: "2-digit",
                      month: "long",
                      year: "numeric",
                    })}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold tabular-nums text-gray-900 dark:text-white">
                    {formatDzd(invoice.amount) ?? "—"}
                  </span>
                  <a
                    href={`/api/invoices/${invoice.id}/pdf`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    Télécharger
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
