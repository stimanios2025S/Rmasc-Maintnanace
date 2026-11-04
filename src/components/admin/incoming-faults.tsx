"use client";

/**
 * La réception du bureau : ce qui vient d'arriver sur le parc.
 *
 * DEUX FILES, UNE SEULE QUESTION
 * « Qu'est-ce que je dois traiter maintenant ? » Les pannes signalées par les
 * clients et les visites d'entretien qui arrivent à échéance sont les deux
 * entrées du même travail. Les séparer dans deux écrans oblige un dispatcheur
 * à en consulter deux pour savoir par quoi commencer ; les poser côte à côte
 * sur le tableau de bord les remet dans l'ordre où il les traite.
 *
 * CE QUE CHAQUE LIGNE PORTE
 * Pour une panne : le client, l'appareil, l'immeuble, le code, le temps écoulé,
 * le contrat qui couvre l'immeuble et un lien vers sa position sur la carte.
 * C'est exactement ce qu'un dispatcheur demande au téléphone avant d'envoyer
 * quelqu'un.
 *
 * POURQUOI ÇA S'ACTUALISE SEUL
 * Une panne signalée pendant que la page est ouverte doit apparaître sans
 * rechargement — c'est le « instantanément » du parcours. Trente secondes,
 * comme le reste du tableau de bord : plus court ferait des requêtes pour rien,
 * plus long laisserait une urgence invisible le temps qu'on regarde ailleurs.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  MapPin,
  Zap,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { ContractSlaBadge } from "@/components/contracts/contract-sla-badge";
import { TrafficPill } from "@/components/ui/traffic";
import { DispatchModal } from "@/components/admin/dispatch-modal";
import { TRAFFIC_LEVELS, priorityTrafficLevel } from "@/lib/ui/traffic";
import type { TrafficLevel } from "@/lib/ui/traffic";
import { contractForBuilding } from "@/lib/contracts/coverage";
import type { CoverageContract } from "@/lib/contracts/coverage";
import { MANAGEMENT_ROLES } from "@/types";

const POLL_MS = 30_000;
const DUE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface IncomingIncident {
  id: string;
  incidentNumber: string;
  status: string;
  isDirectTransfer: boolean;
  createdAt: string;
  /** Le texte du signalement, tel que le client l'a écrit. */
  notes: string | null;
  errorCode: { code: string; title: string } | null;
  client: { id: string; name: string; phone: string | null } | null;
  elevator: {
    id: string;
    elevatorCode: string;
    building: {
      id: string;
      name: string;
      city: string;
      /** Code d'accès immeuble / local technique, s'il est renseigné. */
      accessCode: string | null;
    };
  };
  workOrder: {
    id: string;
    orderNumber: string;
    status: string;
    priority: string;
  } | null;
}

/**
 * Le feu d'une panne, aligné sur celui de la cloche et du cockpit terrain.
 *
 * Une panne sans bon n'a pas de priorité propre : on retombe alors sur son
 * mode de arrivée — un transfert direct est traité comme critique, un
 * signalement ordinaire comme moyen.
 */
function faultUrgency(incident: IncomingIncident): {
  level: TrafficLevel;
  label: string;
} {
  const priority =
    incident.workOrder?.priority ??
    (incident.isDirectTransfer ? "CRITICAL" : "MEDIUM");

  // Le vert, l'orange et le rouge viennent de la table unique
  // (`TRAFFIC_LEVELS`) : ce panneau ne définit pas sa propre palette.
  const level = priorityTrafficLevel(priority);

  if (level === "danger") return { level, label: "Critique / Élevée" };
  if (level === "warning") return { level, label: "Moyenne" };
  if (level === "ok") return { level, label: "Faible / Routine" };
  // Une priorité que l'énumération ne connaît pas ne se lit pas comme une
  // routine : le gris dit « je ne sais pas », comme partout ailleurs.
  return { level, label: "Priorité inconnue" };
}

/**
 * Le libellé du feu, tel qu'il se lit sur la carte de panne.
 *
 * Un mot et une couleur, pas une phrase : le dispatcheur balaie la file, il
 * n'a pas à interpréter une nuance. Le vocabulaire est celui de la cloche, pour
 * qu'une urgence se reconnaisse au même mot partout dans l'application.
 */
const URGENCY_META: Record<
  TrafficLevel,
  { emoji: string; label: string }
> = {
  danger: { emoji: "🔴", label: "URGENT / CRITIQUE" },
  warning: { emoji: "🟠", label: "À TRAITER / MOYEN" },
  ok: { emoji: "🟢", label: "ROUTINE" },
  neutral: { emoji: "⚪", label: "PRIORITÉ INCONNUE" },
};

interface DueSchedule {
  id: string;
  title: string;
  nextDueDate: string;
  elevator: {
    id: string;
    elevatorCode: string;
    building: { id: string; name: string; city: string };
  };
  activeWorkOrder: { id: string; orderNumber: string; status: string } | null;
}

async function readData<T>(result: PromiseSettledResult<Response>): Promise<T[]> {
  if (result.status !== "fulfilled" || !result.value.ok) return [];
  try {
    const json = (await result.value.json()) as { data?: T[] };
    return Array.isArray(json.data) ? json.data : [];
  } catch {
    return [];
  }
}

export function IncomingFaults() {
  const { data: session } = useSession();
  const role = session?.user?.role;
  /**
   * Le tableau de bord a déjà séparé les deux publics — ce composant n'est
   * rendu que dans la vue du personnel. Il ne refait donc pas le test : en
   * accès libre, `useSession()` rend `null` alors que le serveur a déjà décidé
   * que la vue est celle du bureau, et une seconde garde masquerait le panneau
   * à l'utilisateur qui en a le plus besoin.
   *
   * Le rôle ne sert plus qu'à masquer le lien de dispatch à un technicien, qui
   * n'a pas accès au tableau des incidents.
   */
  const canDispatch = !role || MANAGEMENT_ROLES.includes(role);

  const [incidents, setIncidents] = useState<IncomingIncident[]>([]);
  const [schedules, setSchedules] = useState<DueSchedule[]>([]);
  const [contracts, setContracts] = useState<CoverageContract[]>([]);
  const [loading, setLoading] = useState(true);
  /** La panne dont le sélecteur de technicien est ouvert. */
  const [dispatchTarget, setDispatchTarget] = useState<{
    id: string;
    incidentNumber: string;
    elevatorCode: string;
  } | null>(null);
  /**
   * L'acquittement d'une affectation.
   *
   * La ligne disparaît de la file à l'affectation — c'est voulu, elle n'est
   * plus à traiter — mais un écran qui se vide sans un mot laisse croire à une
   * perte. Le message dit aussi que le technicien a été prévenu, parce que
   * c'est la partie que le dispatcheur ne voit pas se produire.
   */
  const [dispatchNotice, setDispatchNotice] = useState("");
  /**
   * L'onglet actif du centre de dispatch.
   *
   * « Pannes à affecter » par défaut : c'est le travail qui n'attend pas. Les
   * visites, elles, ont une date et se planifient ; une file qu'on consulte
   * d'abord pour ce qui est déjà en retard serait consultée dans le mauvais
   * ordre.
   */
  const [tab, setTab] = useState<"faults" | "visits">("faults");

  const load = useCallback(async () => {
    const [incidentResult, scheduleResult, coverageResult] =
      await Promise.allSettled([
        fetch("/api/incidents?status=ESCALATED&limit=6"),
        fetch("/api/maintenance-schedules"),
        fetch("/api/contracts/coverage"),
      ]);

    const [incidentRows, scheduleRows, coverageRows] = await Promise.all([
      readData<IncomingIncident>(incidentResult),
      readData<DueSchedule>(scheduleResult),
      readData<CoverageContract>(coverageResult),
    ]);

    setIncidents(incidentRows);
    setSchedules(scheduleRows);
    setContracts(coverageRows);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  /**
   * Les visites des sept prochains jours, les plus proches d'abord.
   *
   * Une visite en retard reste dans la liste : c'est même la première chose à
   * voir. La filtrer parce que sa date est passée reviendrait à cacher le
   * travail qu'on a déjà manqué.
   */
  const dueSchedules = useMemo(() => {
    const limit = Date.now() + DUE_WINDOW_MS;
    return schedules
      .filter((schedule) => {
        const due = new Date(schedule.nextDueDate).getTime();
        return Number.isFinite(due) && due <= limit;
      })
      .sort(
        (a, b) =>
          new Date(a.nextDueDate).getTime() - new Date(b.nextDueDate).getTime()
      )
      .slice(0, 6);
  }, [schedules]);

  return (
    <>
      {/*
        UNE CARTE, DEUX FILES.

        Les pannes qui attendent une affectation et les visites qui arrivent à
        échéance sont les deux entrées du même travail. Les poser côte à côte
        en deux cartes obligeait à lire deux blocs pour savoir par quoi
        commencer ; les réunir sous deux onglets remet la journée dans l'ordre
        où elle se traite, et l'onglet des pannes reste celui qui s'ouvre.
      */}
      <Card className="overflow-hidden">
        <div className="border-b border-gray-200 px-5 pt-5 dark:border-gray-800">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-xl font-bold text-gray-900 dark:text-white">
                <AlertTriangle
                  className="h-5 w-5 text-red-500"
                  aria-hidden="true"
                />
                Centre de Dispatching &amp; Planning
              </h2>
              <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
                Les pannes à affecter et les visites à planifier, au même
                endroit.
              </p>
            </div>
            {canDispatch && (
              <Link
                href="/administration/incidents"
                className="inline-flex flex-none items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
              >
                Tableau des incidents
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            )}
          </div>

          <div
            className="mt-4 flex gap-1"
            role="tablist"
            aria-label="Files du dispatch"
          >
            <button
              type="button"
              role="tab"
              id="tab-faults"
              aria-selected={tab === "faults"}
              aria-controls="panel-faults"
              onClick={() => setTab("faults")}
              className={`-mb-px inline-flex items-center gap-2 rounded-t-lg border-b-2 px-4 py-2.5 text-sm font-bold transition-colors ${
                tab === "faults"
                  ? "border-red-500 bg-red-50/60 text-red-700 dark:bg-red-950/20 dark:text-red-300"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              }`}
            >
              🔴 Pannes à affecter
              <span
                className={`rounded-full px-1.5 py-0.5 text-[11px] font-extrabold ${
                  tab === "faults"
                    ? "bg-red-600 text-white"
                    : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                }`}
              >
                {incidents.length}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              id="tab-visits"
              aria-selected={tab === "visits"}
              aria-controls="panel-visits"
              onClick={() => setTab("visits")}
              className={`-mb-px inline-flex items-center gap-2 rounded-t-lg border-b-2 px-4 py-2.5 text-sm font-bold transition-colors ${
                tab === "visits"
                  ? "border-blue-500 bg-blue-50/60 text-blue-700 dark:bg-blue-950/20 dark:text-blue-300"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              }`}
            >
              📅 Visites &amp; Entretien
              <span
                className={`rounded-full px-1.5 py-0.5 text-[11px] font-extrabold ${
                  tab === "visits"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                }`}
              >
                {dueSchedules.length}
              </span>
            </button>
          </div>
        </div>

        <div className="p-5">
          {dispatchNotice && tab === "faults" && (
            <p
              role="status"
              className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
            >
              {dispatchNotice}
            </p>
          )}

          {tab === "faults" ? (
            loading ? (
              <div className="space-y-3">
                {[0, 1].map((index) => (
                  <div
                    key={index}
                    className="h-40 animate-pulse rounded-2xl bg-gray-100 dark:bg-gray-800"
                  />
                ))}
              </div>
            ) : incidents.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <CheckCircle2 className="h-8 w-8 text-green-500" />
                <p className="text-sm font-medium text-gray-900 dark:text-white">
                  Aucune panne en attente
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Les nouveaux signalements apparaîtront ici automatiquement.
                </p>
              </div>
            ) : (
              <div id="panel-faults" role="tabpanel" aria-labelledby="tab-faults">
                <ul className="space-y-3">
                  {incidents.map((incident) => {
                    const cover = contractForBuilding(
                      contracts,
                      incident.elevator.building.id
                    );
                    const urgency = faultUrgency(incident);
                    const style = TRAFFIC_LEVELS[urgency.level];
                    const meta = URGENCY_META[urgency.level];
                    const building = incident.elevator.building;
                    const problem =
                      incident.notes?.trim() ||
                      incident.errorCode?.title ||
                      (incident.isDirectTransfer
                        ? "Assistance d'urgence demandée — aucune description fournie."
                        : "Aucune description fournie.");

                    return (
                      <li
                        key={incident.id}
                        className={`rounded-2xl border-2 p-4 ${
                          urgency.level === "danger"
                            ? "border-red-300 bg-red-50/40 dark:border-red-900 dark:bg-red-950/10"
                            : "border-gray-200 dark:border-gray-800"
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wide ${style.bg} ${style.text} ${style.border}`}
                          >
                            {meta.emoji} {meta.label}
                          </span>
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            {formatDistanceToNow(new Date(incident.createdAt), {
                              addSuffix: true,
                              locale: fr,
                            })}
                          </span>
                        </div>

                        <p className="mt-2.5 text-lg font-bold leading-snug text-gray-900 dark:text-white">
                          {building.name}
                          {building.city && (
                            <>
                              <span className="mx-1 text-gray-400">·</span>
                              <span className="font-semibold text-gray-600 dark:text-gray-300">
                                {building.city}
                              </span>
                            </>
                          )}
                        </p>
                        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                          Appareil{" "}
                          <Link
                            href={`/ascenseurs/${incident.elevator.id}`}
                            className="font-mono font-semibold hover:text-blue-600 hover:underline dark:hover:text-blue-400"
                          >
                            {incident.elevator.elevatorCode}
                          </Link>
                          {" · "}Signalé par{" "}
                          {incident.client?.name ??
                            "un visiteur via le QR public"}
                          {incident.errorCode && (
                            <span className="text-gray-400">
                              {" "}
                              · code {incident.errorCode.code}
                            </span>
                          )}
                        </p>

                        {/* Le code d'accès : la question suivante au téléphone. */}
                        <p className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 font-mono text-xs font-bold text-white shadow-sm dark:bg-black">
                          🔑 Code accès :{" "}
                          {building.accessCode ?? "non renseigné"}
                        </p>

                        <p className="mt-2.5 text-sm leading-relaxed text-gray-700 dark:text-gray-300">
                          {problem}
                        </p>

                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 pt-3 dark:border-gray-800">
                          <div className="flex flex-wrap items-center gap-2">
                            <ContractSlaBadge contract={cover} size="sm" />
                            <Link
                              href={`/carte?site=${building.id}`}
                              className="inline-flex items-center gap-1 text-[11px] font-medium text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400"
                            >
                              <MapPin className="h-3 w-3" aria-hidden="true" />
                              Voir sur la carte
                            </Link>
                          </div>
                          {canDispatch && (
                            <button
                              type="button"
                              onClick={() =>
                                setDispatchTarget({
                                  id: incident.id,
                                  incidentNumber: incident.incidentNumber,
                                  elevatorCode:
                                    incident.elevator.elevatorCode,
                                })
                              }
                              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-2 text-sm font-bold text-white shadow-sm hover:bg-red-700"
                            >
                              <Zap className="h-4 w-4" aria-hidden="true" />
                              Dispatcher en 1-clic
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )
          ) : loading ? (
            <div className="space-y-2">
              {[0, 1].map((index) => (
                <div
                  key={index}
                  className="h-16 animate-pulse rounded-xl bg-gray-100 dark:bg-gray-800"
                />
              ))}
            </div>
          ) : dueSchedules.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <CheckCircle2 className="h-8 w-8 text-green-500" />
              <p className="text-sm font-medium text-gray-900 dark:text-white">
                Aucune visite dans les sept jours
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Le programme d&apos;entretien est à jour.
              </p>
            </div>
          ) : (
            <div id="panel-visits" role="tabpanel" aria-labelledby="tab-visits">
              <ul className="space-y-2.5">
                {dueSchedules.map((schedule) => {
                  const due = new Date(schedule.nextDueDate);
                  const late = due.getTime() < Date.now();

                  return (
                    <li
                      key={schedule.id}
                      className="flex items-start gap-3 rounded-xl border border-gray-200 p-3 dark:border-gray-800"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-gray-900 dark:text-white">
                          {schedule.elevator.building.name}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {schedule.elevator.elevatorCode} · {schedule.title}
                        </p>
                        <p className="mt-1 text-[11px] text-gray-400">
                          {due.toLocaleDateString("fr-FR", {
                            day: "2-digit",
                            month: "long",
                            year: "numeric",
                          })}
                          {schedule.activeWorkOrder
                            ? ` · intervention ${schedule.activeWorkOrder.orderNumber}`
                            : ""}
                        </p>
                      </div>
                      <TrafficPill
                        level={late ? "danger" : "warning"}
                        size="sm"
                        label={late ? "En retard" : "À planifier"}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </Card>

      {/*
        Le sélecteur de technicien, partagé avec le tableau des incidents et la
        cloche. Il affiche le statut réel de chacun et déclenche, côté serveur,
        la notification in-app puis l'envoi WhatsApp — c'est la route
        d'affectation qui s'en charge, pas cet écran.
      */}
      <DispatchModal
        incident={dispatchTarget}
        onClose={() => setDispatchTarget(null)}
        onDispatched={() => {
          setDispatchTarget(null);
          setDispatchNotice(
            "Affectation enregistrée · le technicien a reçu la notification in-app et le message WhatsApp."
          );
          void load();
        }}
      />
    </>
  );
}
