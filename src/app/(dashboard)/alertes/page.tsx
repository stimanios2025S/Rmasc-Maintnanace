"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { format, formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import {
  BellOff,
  CheckCheck,
  CircleCheck,
  CircleDashed,
  Loader2,
  RefreshCw,
  Undo2,
  UserCheck,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { enumLabel } from "@/lib/ui/enum-labels";
import { announceAlertsChanged } from "@/lib/ui/alert-events";
import { ALERT_SEVERITIES } from "@/types";
import type { AlertSeverity } from "@/types";

/**
 * La file des alertes — le seul écran où une alerte se traite.
 *
 * CE QUI MANQUAIT
 * `PATCH /api/alerts` savait acquitter et résoudre depuis le début, et
 * personne ne l'appelait : aucun écran ne l'exposait. Le badge de l'en-tête
 * comptait les alertes non acquittées en pointant vers le tableau des bons de
 * travail, faute de mieux — et une alerte qu'on ne peut pas acquitter
 * s'accumule jusqu'à ce qu'on cesse de la regarder, ce qui est exactement ce
 * que ce produit existe pour empêcher.
 *
 * « NON LUE » N'EST PAS LE MOT
 * Une alerte n'a pas d'état de lecture. Elle est *acquittée* ou non : quelqu'un
 * l'a prise en charge, ou personne ne l'a encore vue. Le mot « lu » appartient
 * aux notifications (`Notification.isRead`), qui sont des messages adressés à
 * une personne et non des signaux d'une machine. Confondre les deux ferait
 * croire qu'ouvrir l'écran suffit à traiter une surchauffe.
 *
 * LA SÉVÉRITÉ COMPTE CINQ NIVEAUX, PAS TROIS
 * `ALERT_SEVERITIES` définit INFO, WARNING, ANOMALY, CRITICAL et EMERGENCY.
 * Les filtres les exposent tous les cinq : replier EMERGENCY sur CRITICAL
 * cacherait une distinction que la donnée fait, et c'est justement celle qui
 * dit s'il faut réveiller quelqu'un.
 */

interface AlertRow {
  id: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  metricName: string | null;
  metricValue: number | null;
  isAcknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedByUser: { id: string; name: string } | null;
  createdAt: string;
  resolvedAt: string | null;
  elevator: {
    id: string;
    elevatorCode: string;
    status: string;
    building: { name: string };
  };
}

/**
 * Les quatre états d'une alerte, tels qu'on les filtre.
 *
 * Le serveur expose deux booléens indépendants ; l'écran les combine en quatre
 * buckets qui ne se chevauchent pas — sauf « Toutes », qui est la vue complète.
 * `a-traiter` demande les deux conditions : une alerte peut être résolue sans
 * avoir jamais été acquittée, et la compter comme « à traiter » ferait
 * remonter chaque jour des pannes déjà réparées.
 */
type StatusFilter = "a-traiter" | "acquittees" | "resolues" | "toutes";

const STATUS_FILTERS: { key: StatusFilter; label: string; query: string }[] = [
  { key: "a-traiter", label: "À traiter", query: "acknowledged=false&resolved=false" },
  { key: "acquittees", label: "Acquittées", query: "acknowledged=true&resolved=false" },
  { key: "resolues", label: "Résolues", query: "resolved=true" },
  { key: "toutes", label: "Toutes", query: "" },
];

/** Le nombre d'alertes demandé d'un coup, et au-delà duquel on le dit. */
const PAGE_SIZE = 100;

const SEVERITY_BADGE: Record<AlertSeverity, string> = {
  EMERGENCY: "bg-red-600 text-white",
  CRITICAL: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  ANOMALY: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  WARNING: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  INFO: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

/**
 * Le bord de la carte, qui porte la gravité de plus loin que le badge.
 *
 * Sur une file de trente lignes, l'œil ne lit pas les étiquettes : il balaie
 * les bords. La couleur du bord est donc la même règle que celle du badge, pas
 * une seconde décoration.
 */
const SEVERITY_CARD: Record<AlertSeverity, string> = {
  EMERGENCY: "border-red-400 bg-red-50/60 dark:border-red-800 dark:bg-red-950/20",
  CRITICAL: "border-red-300 bg-red-50/40 dark:border-red-900 dark:bg-red-950/10",
  ANOMALY: "border-orange-300 dark:border-orange-900",
  WARNING: "border-amber-300 dark:border-amber-900",
  INFO: "border-gray-200 dark:border-gray-800",
};

export default function AlertesPage() {
  const { data: session } = useSession();
  const role = session?.user?.role;

  /**
   * Mirrors the server rule on `PATCH /api/alerts` exactly: management roles
   * only. Showing the buttons to a technician would offer an action the route
   * refuses, and this project's rule is that a button and its refusal never
   * disagree.
   */
  const canAct = role === "ADMIN" || role === "MAINTENANCE_MANAGER";

  const [status, setStatus] = useState<StatusFilter>("a-traiter");
  const [severity, setSeverity] = useState<AlertSeverity | "ALL">("ALL");

  const [rows, setRows] = useState<AlertRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!silent) setLoading(true);
      setError("");

      const query = STATUS_FILTERS.find((f) => f.key === status)?.query ?? "";
      const params = new URLSearchParams(query);
      params.set("limit", String(PAGE_SIZE));
      if (severity !== "ALL") params.set("severity", severity);

      try {
        const res = await fetch(`/api/alerts?${params.toString()}`);
        if (!res.ok) throw new Error(`L'API des alertes a répondu ${res.status}`);
        const json = await res.json();
        setRows(Array.isArray(json.data) ? json.data : []);
        setTotal(typeof json.pagination?.total === "number" ? json.pagination.total : 0);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Échec du chargement des alertes"
        );
      } finally {
        setLoading(false);
      }
    },
    [status, severity]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // The badge in the shell polls on its own; this shorter tick keeps the file
  // current while an operator is working through it in another tab.
  useEffect(() => {
    const id = setInterval(() => void load({ silent: true }), 45_000);
    return () => clearInterval(id);
  }, [load]);

  /**
   * Ce que l'action de masse prendrait, calculé sur ce qui est *affiché*.
   *
   * Le bouton annonce ce nombre, et n'agit que sur ces identifiants. Acquitter
   * « tout » sans regarder le filtre permettrait à quelqu'un qui a restreint la
   * vue aux informations de signer en aveugle des alertes critiques qu'il n'a
   * pas vues.
   */
  const acknowledgeable = useMemo(
    () => rows.filter((row) => !row.isAcknowledged).map((row) => row.id),
    [rows]
  );

  async function patch(body: Record<string, unknown>, id?: string) {
    const url = id
      ? `/api/alerts?id=${encodeURIComponent(id)}`
      : "/api/alerts";

    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(
        payload?.error ?? payload?.message ?? "La mise à jour a été refusée."
      );
    }
    return payload;
  }

  async function act(row: AlertRow, next: { acknowledged?: boolean; resolved?: boolean }, verb: string) {
    setBusyId(row.id);
    setActionError(null);
    setNotice(null);

    try {
      await patch(next, row.id);
      // Le badge de la coque se remet à jour tout de suite, sans attendre son
      // sondage d'une minute — sinon le compteur contredit le bouton qu'on
      // vient de presser.
      announceAlertsChanged();
      setNotice(`${row.elevator.elevatorCode} — ${verb}.`);
      await load({ silent: true });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "L'action a échoué.");
    } finally {
      setBusyId(null);
    }
  }

  async function acknowledgeDisplayed() {
    if (acknowledgeable.length === 0) return;

    setBulkBusy(true);
    setActionError(null);
    setNotice(null);

    try {
      const payload = await patch({
        ids: acknowledgeable,
        acknowledged: true,
      });
      announceAlertsChanged();

      // Le serveur rend le nombre réellement écrit, jamais le nombre demandé :
      // une alerte disparue entre l'affichage et le clic n'est pas comptée.
      const updated: number = payload?.updated ?? acknowledgeable.length;
      setNotice(
        `${updated} alerte${updated > 1 ? "s" : ""} acquittée${updated > 1 ? "s" : ""}.`
      );
      await load({ silent: true });
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "L'acquittement groupé a échoué."
      );
    } finally {
      setBulkBusy(false);
    }
  }

  if (loading && rows.length === 0) {
    return (
      <div className="space-y-4">
        <div className="h-16 rounded-xl bg-gray-100 dark:bg-gray-800 animate-pulse" />
        <div className="h-64 rounded-xl bg-gray-100 dark:bg-gray-800 animate-pulse" />
      </div>
    );
  }

  if (error && rows.length === 0) {
    return <ErrorState message={error} onRetry={load} />;
  }

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="space-y-4">
          {/* ── Statut ─────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-16 flex-none text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Statut
            </span>
            <div role="tablist" aria-label="Filtrer par statut" className="flex flex-wrap gap-1.5">
              {STATUS_FILTERS.map((option) => (
                <button
                  key={option.key}
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

          {/* ── Sévérité ───────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-16 flex-none text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Sévérité
            </span>
            <div role="tablist" aria-label="Filtrer par sévérité" className="flex flex-wrap gap-1.5">
              <button
                type="button"
                role="tab"
                aria-selected={severity === "ALL"}
                onClick={() => setSeverity("ALL")}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  severity === "ALL"
                    ? "bg-gray-900 text-white dark:bg-gray-700"
                    : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                }`}
              >
                Toutes
              </button>
              {ALERT_SEVERITIES.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="tab"
                  aria-selected={severity === level}
                  onClick={() => setSeverity(level)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    severity === level
                      ? "bg-gray-900 text-white dark:bg-gray-700"
                      : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                  }`}
                >
                  {enumLabel(level)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-gray-200 pt-4 dark:border-gray-800">
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {total} alerte{total > 1 ? "s" : ""}
            {status !== "toutes" ? " dans ce filtre" : ""}
          </span>

          {canAct && acknowledgeable.length > 0 && (
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => void acknowledgeDisplayed()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {bulkBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCheck className="h-4 w-4" aria-hidden="true" />
              )}
              Acquitter les {acknowledgeable.length} affichée
              {acknowledgeable.length > 1 ? "s" : ""}
            </button>
          )}

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

        {total > rows.length && (
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            {total - rows.length} alerte{total - rows.length > 1 ? "s" : ""} de
            plus dans ce filtre. Affinez la sévérité ou le statut pour les
            atteindre.
          </p>
        )}
      </Card>

      {rows.length === 0 ? (
        <Card className="p-6">
          <p className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <BellOff className="h-4 w-4 flex-none" aria-hidden="true" />
            Aucune alerte dans ce filtre.
          </p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const isBusy = busyId === row.id;
            const resolved = row.resolvedAt !== null;

            return (
              <li
                key={row.id}
                className={`rounded-xl border p-4 ${SEVERITY_CARD[row.severity] ?? SEVERITY_CARD.INFO}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                      SEVERITY_BADGE[row.severity] ?? SEVERITY_BADGE.INFO
                    }`}
                  >
                    {enumLabel(row.severity)}
                  </span>

                  <Link
                    href={`/ascenseurs/${row.elevator.id}`}
                    className="font-mono text-xs text-blue-700 underline decoration-dotted underline-offset-2 dark:text-blue-400"
                  >
                    {row.elevator.elevatorCode}
                  </Link>
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {row.elevator.building.name}
                  </span>

                  {resolved ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-green-800 dark:bg-green-950 dark:text-green-300">
                      <CircleCheck className="h-3 w-3" aria-hidden="true" />
                      Résolue
                    </span>
                  ) : row.isAcknowledged ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-800 dark:bg-blue-950 dark:text-blue-300">
                      <UserCheck className="h-3 w-3" aria-hidden="true" />
                      Acquittée
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                      <CircleDashed className="h-3 w-3" aria-hidden="true" />
                      Non acquittée
                    </span>
                  )}

                  <span className="ml-auto text-xs text-gray-400">
                    {formatDistanceToNow(new Date(row.createdAt), {
                      locale: fr,
                      addSuffix: true,
                    })}
                  </span>
                </div>

                <p className="mt-2 text-sm font-medium text-gray-900 dark:text-white">
                  {row.title}
                </p>
                <p className="mt-0.5 text-sm text-gray-700 dark:text-gray-300">
                  {row.message}
                </p>

                {row.metricName && row.metricValue !== null && (
                  <p className="mt-1 font-mono text-xs text-gray-600 dark:text-gray-400">
                    {row.metricName} : {row.metricValue}
                  </p>
                )}

                {/*
                  Le détail de qui a signé, et quand. « Acquittée » sans nom ne
                  répond pas à la question qu'on pose à une file d'alertes.

                  Le nom est facultatif : la route ne le renvoie que par sa
                  relation, et un jeu de démonstration peut ne pas le porter.
                  Quand il manque, la phrase dit ce qu'elle sait — la date —
                  plutôt que d'affirmer qu'un compte a été supprimé.
                */}
                {row.acknowledgedAt && (
                  <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                    Acquittée
                    {row.acknowledgedByUser?.name
                      ? ` par ${row.acknowledgedByUser.name}`
                      : ""}{" "}
                    le{" "}
                    {format(new Date(row.acknowledgedAt), "d MMMM yyyy 'à' HH:mm", {
                      locale: fr,
                    })}
                  </p>
                )}

                {canAct && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {!row.isAcknowledged && !resolved && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          void act(row, { acknowledged: true }, "alerte acquittée")
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                      >
                        {isBusy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        Acquitter
                      </button>
                    )}

                    {!resolved && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          void act(row, { resolved: true }, "alerte résolue")
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                      >
                        <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" />
                        Résoudre
                      </button>
                    )}

                    {row.isAcknowledged && !resolved && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          void act(row, { acknowledged: false }, "acquittement retiré")
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800"
                      >
                        <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Retirer l&apos;acquittement
                      </button>
                    )}

                    {resolved && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          void act(row, { resolved: false }, "alerte rouverte")
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                      >
                        <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Rouvrir
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!canAct && rows.length > 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Acquitter et résoudre une alerte engagent l&apos;entreprise : ces
          actions sont réservées à l&apos;administrateur et au responsable
          maintenance.
        </p>
      )}
    </div>
  );
}
