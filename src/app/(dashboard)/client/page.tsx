"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import { ClipboardList, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { ProgressTrack } from "@/components/ui/progress-track";
import { ValidationBadge } from "@/components/ui/validation-badge";
import { EmergencyButton } from "@/components/client/emergency-button";
import type { EmergencyElevator } from "@/components/client/emergency-button";
import { IncidentWizard } from "@/components/client/incident-wizard";
import { NonContractedPortal } from "@/components/client/non-contracted-portal";
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
  building: { id: string; name: string };
}

export default function ClientPortalPage() {
  const { data: session, status } = useSession();
  const [elevators, setElevators] = useState<EmergencyElevator[]>([]);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
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
  }, [load, nonContracted, status]);

  const refresh = useCallback(() => {
    void load({ silent: true });
  }, [load]);

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

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Order matters: the emergency path is first on the page and first in
          the reading order, so it is reachable without scrolling past prose. */}
      <EmergencyButton elevators={elevators} onEscalated={refresh} />

      <IncidentWizard elevators={elevators} onSubmitted={refresh} />

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
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
            Aucun signalement pour le moment.
          </p>
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
    </div>
  );
}
