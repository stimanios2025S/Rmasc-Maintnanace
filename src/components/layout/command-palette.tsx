"use client";

import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Building2,
  ClipboardList,
  CornerDownLeft,
  Loader2,
  ScrollText,
  Search,
  X,
  AlertOctagon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TrafficDot } from "@/components/ui/traffic";
import {
  contractTrafficLevel,
  elevatorTrafficLevel,
  type TrafficLevel,
} from "@/lib/ui/traffic";

/**
 * La recherche globale, ouverte par Ctrl + K (ou ⌘ + K).
 *
 * POURQUOI ELLE CHARGE TOUT PLUTÔT QUE D'INTERROGER À CHAQUE FRAPPE
 * Les quatre registres tiennent en quelques centaines de lignes, et les routes
 * existantes appliquent déjà le cloisonnement par rôle — un propriétaire
 * d'immeuble ne reçoit que son portefeuille, un technicien n'obtient pas les
 * contrats. Réutiliser ces routes plutôt qu'ajouter un `/api/search` évite de
 * réécrire quatre fois la même règle d'accès, et la frappe ne déclenche aucun
 * aller-retour : la liste est filtrée en mémoire.
 *
 * Ce qui est chargé est mémorisé une minute. Les écritures passent par les
 * écrans ; revenir dans les secondes qui suivent ne demande pas de tout
 * recharger, et une minute est assez courte pour qu'une intervention créée
 * entre-temps apparaisse.
 *
 * L'INDEX EST CELUI DU SERVEUR
 * La palette ne décide pas qui peut voir quoi. Si une route répond 403 (un
 * technicien sur les contrats, par exemple), son groupe est simplement absent.
 */

type ItemKind =
  | "elevator"
  | "building"
  | "workOrder"
  | "incident"
  | "contract";

interface SearchItem {
  id: string;
  kind: ItemKind;
  title: string;
  subtitle: string;
  href: string;
  level?: TrafficLevel;
  meta?: string;
}

const KIND_META: Record<ItemKind, { label: string; icon: LucideIcon }> = {
  elevator: { label: "Ascenseur", icon: Activity },
  building: { label: "Immeuble", icon: Building2 },
  workOrder: { label: "Intervention", icon: ClipboardList },
  incident: { label: "Signalement", icon: AlertOctagon },
  contract: { label: "Contrat", icon: ScrollText },
};

/** Ordre d'affichage des groupes — le parc avant le commercial. */
const KIND_ORDER: ItemKind[] = [
  "elevator",
  "building",
  "workOrder",
  "incident",
  "contract",
];

const CACHE_TTL_MS = 60_000;

interface RawElevator {
  id: string;
  elevatorCode: string;
  status?: string;
  building?: { name?: string };
}

interface RawBuilding {
  id: string;
  name: string;
  city?: string;
  elevatorCount?: number;
  statusBreakdown?: Record<string, number>;
}

interface RawWorkOrder {
  id: string;
  orderNumber: string;
  title: string;
  status?: string;
  elevatorId?: string;
  elevator?: {
    elevatorCode?: string;
    building?: { name?: string };
  };
}

interface RawIncident {
  id: string;
  incidentNumber: string;
  status?: string;
  notes?: string | null;
  elevator?: {
    elevatorCode?: string;
    building?: { name?: string };
  };
  workOrder?: { id?: string } | null;
}

interface RawContract {
  id: string;
  reference: string;
  effectiveStatus?: string;
  expiry?: { level?: string };
  client?: { name?: string };
  buildings?: { name?: string }[];
}

/** Retire les accents et la casse : « Atelier » doit trouver « atelier ». */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Le pire état d'un immeuble, pour sa pastille.
 *
 * Un immeuble n'a pas d'état propre : il a des appareils. Afficher du vert
 * parce que la majorité fonctionne cacherait la cabine bloquée. C'est donc le
 * pire niveau qui décide.
 */
function buildingLevel(breakdown: Record<string, number> | undefined): TrafficLevel {
  if (!breakdown || Object.keys(breakdown).length === 0) return "neutral";
  if ((breakdown.CRITICAL_SHUTDOWN ?? 0) > 0) return "danger";
  if ((breakdown.ANOMALY_DETECTED ?? 0) > 0) return "warning";
  if ((breakdown.SERVICE_REQUIRED ?? 0) > 0) return "warning";
  if ((breakdown.OPERATIONAL ?? 0) > 0) return "ok";
  return "neutral";
}

async function readList<T>(response: PromiseSettledResult<Response>): Promise<T[]> {
  if (response.status !== "fulfilled" || !response.value.ok) return [];
  try {
    const json = (await response.value.json()) as { data?: T[] };
    return Array.isArray(json.data) ? json.data : [];
  } catch {
    return [];
  }
}

export function CommandPalette({
  open,
  onOpen,
  onClose,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const { data: session } = useSession();
  /**
   * Un compte client ne peut ouvrir que son espace : `/ascenseurs` et
   * `/bons-de-travail` le renvoient au tableau de bord. La palette ne lui
   * propose donc que ce qu'il peut réellement ouvrir — sinon chaque résultat
   * serait un lien qui ne mène nulle part.
   */
  const isClient = session?.user?.role === "BUILDING_OWNER";
  /**
   * Un technicien n'a que faire de l'index du parc : ses interventions, ses
   * signalements, et les appareils sur lesquels il a un bon. Le reste n'est
   * pas chargé du tout — la palette ne télécharge pas ce qu'elle ne montrera
   * pas.
   */
  const isTechnician = session?.user?.role === "FIELD_TECHNICIAN";
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const cache = useRef<{
    at: number;
    items: SearchItem[];
    isClient: boolean;
    isTechnician: boolean;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Le raccourci, écouté au niveau du document.
   *
   * Il doit fonctionner depuis n'importe quel écran, y compris quand le focus
   * est dans un champ de saisie : Ctrl + K n'est pas un caractère que l'on
   * tape, et le navigateur n'en fait rien par défaut.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) onClose();
        else onOpen();
        return;
      }
      if (open && event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpen, onClose]);

  // Chargement de l'index, à la première ouverture ou après expiration.
  useEffect(() => {
    if (!open) return;

    setQuery("");
    setActive(0);

    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 30);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    let cancelled = false;

    async function load() {
      if (
        cache.current &&
        cache.current.isClient === isClient &&
        cache.current.isTechnician === isTechnician &&
        Date.now() - cache.current.at < CACHE_TTL_MS
      ) {
        setItems(cache.current.items);
        return;
      }

      setLoading(true);

      /**
       * Registre non chargé : la promesse est déjà « rejetée », donc
       * `readList` renvoie une liste vide sans qu'aucune requête ne parte.
       */
      const skipped = Promise.resolve({
        status: "rejected" as const,
        reason: null,
      });

      const [elevators, buildings, workOrders, contracts, incidents] =
        await Promise.all([
          fetch("/api/elevators").then((res) => ({ status: "fulfilled" as const, value: res })).catch(() => ({ status: "rejected" as const, reason: null })),
          // Les immeubles et les contrats sont des vues de bureau : un
          // technicien ne les reçoit ni dans le menu ni ici.
          isTechnician
            ? skipped
            : fetch("/api/buildings").then((res) => ({ status: "fulfilled" as const, value: res })).catch(() => ({ status: "rejected" as const, reason: null })),
          fetch("/api/work-orders?limit=100").then((res) => ({ status: "fulfilled" as const, value: res })).catch(() => ({ status: "rejected" as const, reason: null })),
          isTechnician
            ? skipped
            : fetch("/api/contracts").then((res) => ({ status: "fulfilled" as const, value: res })).catch(() => ({ status: "rejected" as const, reason: null })),
          // Les signalements du technicien : la route les cloisonne déjà à
          // `technicianId = lui-même`.
          isTechnician
            ? fetch("/api/incidents?limit=50").then((res) => ({ status: "fulfilled" as const, value: res })).catch(() => ({ status: "rejected" as const, reason: null }))
            : skipped,
        ]);

      const [elevatorRows, buildingRows, orderRows, contractRows, incidentRows] =
        await Promise.all([
          readList<RawElevator>(elevators),
          readList<RawBuilding>(buildings),
          readList<RawWorkOrder>(workOrders),
          readList<RawContract>(contracts),
          readList<RawIncident>(incidents),
        ]);

      /**
       * Ceinture et bretelles : la route `/api/elevators` ne renvoie déjà que
       * les appareils du technicien, mais un mode de démonstration peut servir
       * une fixture complète. On recroise avec ses bons pour que la palette ne
       * propose jamais un lien qui répondra 403.
       */
      const technicianElevatorIds = isTechnician
        ? new Set(
            orderRows
              .map((row) => row.elevatorId)
              .filter((value): value is string => Boolean(value))
          )
        : null;
      const visibleElevators = technicianElevatorIds
        ? elevatorRows.filter((row) => technicianElevatorIds.has(row.id))
        : elevatorRows;

      const next: SearchItem[] = [
        ...visibleElevators.map((row) => ({
          id: row.id,
          kind: "elevator" as const,
          title: row.elevatorCode,
          subtitle: row.building?.name ?? "Immeuble non renseigné",
          href: isClient ? "/client" : `/ascenseurs/${row.id}`,
          level: elevatorTrafficLevel(row.status ?? ""),
        })),
        ...buildingRows.map((row) => ({
          id: row.id,
          kind: "building" as const,
          title: row.name,
          subtitle: [row.city, row.elevatorCount ? `${row.elevatorCount} appareil${row.elevatorCount > 1 ? "s" : ""}` : null]
            .filter(Boolean)
            .join(" · "),
          href: isClient
            ? "/client"
            : `/ascenseurs?q=${encodeURIComponent(row.name)}`,
          level: buildingLevel(row.statusBreakdown),
        })),
        ...(isClient ? [] : orderRows).map((row) => ({
          id: row.id,
          kind: "workOrder" as const,
          title: `${row.orderNumber} · ${row.title}`,
          subtitle: [row.elevator?.elevatorCode, row.elevator?.building?.name]
            .filter(Boolean)
            .join(" — "),
          href: `/bons-de-travail/${row.id}`,
        })),
        ...(isTechnician ? incidentRows : []).map((row) => ({
          id: row.id,
          kind: "incident" as const,
          title: row.incidentNumber,
          subtitle: [
            row.elevator?.elevatorCode,
            row.elevator?.building?.name,
            row.notes ? row.notes.replace(/\s+/g, " ").slice(0, 70) : null,
          ]
            .filter(Boolean)
            .join(" — "),
          // Un signalement n'a pas d'écran propre : il s'ouvre par le bon de
          // travail qu'il a créé, sinon par le portail du terrain.
          href: row.workOrder?.id
            ? `/bons-de-travail/${row.workOrder.id}`
            : "/technicien",
        })),
        ...(isClient || isTechnician ? [] : contractRows).map((row) => ({
          id: row.id,
          kind: "contract" as const,
          title: row.reference,
          subtitle: [
            row.client?.name,
            row.buildings?.length
              ? `${row.buildings.length} immeuble${row.buildings.length > 1 ? "s" : ""}`
              : null,
          ]
            .filter(Boolean)
            .join(" · "),
          href: `/administration/contrats/${row.id}`,
          level: contractTrafficLevel({
            effectiveStatus: row.effectiveStatus ?? "DRAFT",
            expiry: { level: row.expiry?.level ?? "none" },
          }),
        })),
      ];

      if (cancelled) return;
      cache.current = {
        at: Date.now(),
        items: next,
        isClient,
        isTechnician,
      };
      setItems(next);
      setLoading(false);
    }

    void load();

    return () => {
      cancelled = true;
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, isClient, isTechnician]);

  // Quand la requête change, le premier résultat redevient la cible.
  useEffect(() => {
    setActive(0);
  }, [query]);

  const results = useMemo(() => {
    const needle = normalize(query);
    if (!needle) return items.slice(0, 12);

    const matched = items.filter((item) =>
      normalize(`${item.title} ${item.subtitle} ${item.meta ?? ""}`).includes(
        needle
      )
    );

    // Le parc d'abord, puis le commercial — le même ordre que les groupes.
    return KIND_ORDER.flatMap((kind) =>
      matched.filter((item) => item.kind === kind)
    ).slice(0, 30);
  }, [items, query]);

  const go = useCallback(
    (item: SearchItem | undefined) => {
      if (!item) return;
      onClose();
      router.push(item.href);
    },
    [onClose, router]
  );

  if (!open) return null;

  // L'index peut dépasser la liste quand un chargement réduit les résultats.
  const safeActive = results.length === 0 ? -1 : Math.min(active, results.length - 1);
  const activeItem = safeActive >= 0 ? results[safeActive] : undefined;

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-start justify-center bg-gray-900/50 p-0 backdrop-blur-sm sm:p-6 sm:pt-20"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Recherche globale"
        className="flex h-full w-full max-w-2xl flex-col overflow-hidden bg-white shadow-2xl dark:bg-gray-900 sm:h-auto sm:max-h-[75vh] sm:rounded-2xl sm:border sm:border-gray-200 sm:dark:border-gray-800"
      >
        {/* Saisie */}
        <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-800">
          <Search className="h-5 w-5 flex-none text-gray-400" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((index) =>
                  results.length === 0 ? 0 : (index + 1) % results.length
                );
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) =>
                  results.length === 0
                    ? 0
                    : (index - 1 + results.length) % results.length
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                go(activeItem);
              }
            }}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-results"
            aria-activedescendant={
              activeItem ? `command-palette-item-${safeActive}` : undefined
            }
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            placeholder="Rechercher un ascenseur, un immeuble, une intervention, un contrat…"
            className="min-w-0 flex-1 bg-transparent text-base text-gray-900 placeholder:text-gray-400 focus:outline-none dark:text-white"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer la recherche"
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Résultats */}
        <div
          id="command-palette-results"
          role="listbox"
          aria-label="Résultats de recherche"
          className="flex-1 overflow-y-auto px-2 py-2"
        >
          {loading && items.length === 0 ? (
            <p className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Chargement du parc…
            </p>
          ) : results.length === 0 ? (
            <div className="px-6 py-12 text-center">
              {query.trim() ? (
                <>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    Aucun résultat pour « {query.trim()} »
                  </p>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    Essayez un matricule d&apos;appareil, un nom
                    d&apos;immeuble, un numéro d&apos;intervention ou une
                    référence de contrat.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    Que cherchez-vous ?
                  </p>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    Tapez un matricule, un nom d&apos;immeuble, un numéro
                    d&apos;intervention ou une référence de contrat. Les
                    résultats apparaissent au fil de la frappe.
                  </p>
                </>
              )}
            </div>
          ) : (
            results.map((item, index) => {
              const meta = KIND_META[item.kind];
              const Icon = meta.icon;
              const showHeader =
                index === 0 || results[index - 1].kind !== item.kind;

              return (
                <div
                  key={`${item.kind}-${item.id}`}
                  role="presentation"
                >
                  {showHeader && (
                    <p
                      role="presentation"
                      className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-gray-400"
                    >
                      {meta.label}s
                    </p>
                  )}
                  <button
                    type="button"
                    id={`command-palette-item-${index}`}
                    role="option"
                    aria-selected={index === safeActive}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => go(item)}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                      index === safeActive
                        ? "bg-blue-50 dark:bg-blue-950/40"
                        : "hover:bg-gray-50 dark:hover:bg-gray-800/60"
                    }`}
                  >
                    <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        {item.level && (
                          <TrafficDot
                            level={item.level}
                            size="sm"
                            label={meta.label}
                          />
                        )}
                        <span className="truncate text-sm font-medium text-gray-900 dark:text-white">
                          {item.title}
                        </span>
                      </span>
                      {item.subtitle && (
                        <span className="mt-0.5 block truncate text-xs text-gray-500 dark:text-gray-400">
                          {item.subtitle}
                        </span>
                      )}
                    </span>
                    <span className="hidden flex-none text-[10px] font-medium uppercase tracking-wide text-gray-400 sm:block">
                      {meta.label}
                    </span>
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Pied : les raccourcis, pour que la palette s'apprenne en l'utilisant. */}
        <div className="hidden items-center justify-between gap-3 border-t border-gray-200 px-4 py-2.5 text-[11px] text-gray-500 dark:border-gray-800 dark:text-gray-400 sm:flex">
          <span className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded border border-gray-300 px-1 font-sans dark:border-gray-700">
                <ArrowUp className="inline h-3 w-3" />
              </kbd>
              <kbd className="rounded border border-gray-300 px-1 font-sans dark:border-gray-700">
                <ArrowDown className="inline h-3 w-3" />
              </kbd>
              naviguer
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded border border-gray-300 px-1 font-sans dark:border-gray-700">
                <CornerDownLeft className="inline h-3 w-3" />
              </kbd>
              ouvrir
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded border border-gray-300 px-1 font-sans dark:border-gray-700">
                Échap
              </kbd>
              fermer
            </span>
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="rounded border border-gray-300 px-1 font-sans dark:border-gray-700">
              Ctrl
            </kbd>
            +
            <kbd className="rounded border border-gray-300 px-1 font-sans dark:border-gray-700">
              K
            </kbd>
          </span>
        </div>
      </div>
    </div>
  );
}
