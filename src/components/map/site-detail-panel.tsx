"use client";

/**
 * Everything behind one pin.
 *
 * The map can only say "something here needs attention, and it is this urgent".
 * This panel is where the answer to "what, exactly" lives, and it is the reason
 * the map draws one pin per site rather than one per elevator: a pin is a
 * pointer, and the list underneath it is the content.
 *
 * The list is ordered worst-first, using the same `compareAttention` the map
 * colours itself by, so the unit that made the pin red is the first row rather
 * than wherever the database happened to return it.
 */

import Link from "next/link";
import {
  X,
  Phone,
  MapPin,
  User,
  Ruler,
  ArrowUpRight,
  Crosshair,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import {
  ATTENTION_STYLES,
  compareAttention,
  daysUntil,
  formatDays,
} from "@/lib/map/attention";
import type { FleetMapElevator, FleetMapSite } from "@/lib/map/types";
import { enumLabel } from "@/lib/ui/enum-labels";
import { formatDistance } from "@/lib/geo/geofence";
import { cn } from "@/lib/utils";

export interface SiteDetailPanelProps {
  site: FleetMapSite;
  onClose: () => void;
  /**
   * Hands the site to the caller to be re-placed on the map.
   *
   * Optional, and absent wherever the caller cannot write a position back — a
   * button that opens a mode nobody can complete is worse than no button.
   */
  onReposition?: () => void;
  className?: string;
}

export function SiteDetailPanel({
  site,
  onClose,
  onReposition,
  className,
}: SiteDetailPanelProps) {
  const siteStyle = ATTENTION_STYLES[site.level];

  // A new array then sorted: `site.elevators` is the payload's own array and
  // `Array.prototype.sort` mutates in place, which would reorder the caller's
  // data behind its back.
  const units = [...site.elevators].sort(
    (a, b) =>
      compareAttention(a.level, b.level) ||
      a.elevatorCode.localeCompare(b.elevatorCode)
  );

  return (
    <aside
      className={cn(
        "flex flex-col rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900",
        className
      )}
      aria-label={`Détail du site ${site.name}`}
    >
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="border-b border-gray-200 p-4 dark:border-gray-800">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-gray-900 dark:text-white">
              {site.name}
            </h3>
            <p className="mt-0.5 flex items-start gap-1 text-sm text-gray-500 dark:text-gray-400">
              <MapPin className="mt-0.5 h-3.5 w-3.5 flex-none" />
              <span>
                {site.address}, {site.city}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            aria-label="Fermer le détail"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
              siteStyle.badge
            )}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: siteStyle.color }}
              aria-hidden="true"
            />
            {siteStyle.label}
          </span>
          <span className="rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300">
            {site.elevatorCount}{" "}
            {site.elevatorCount > 1 ? "ascenseurs" : "ascenseur"}
          </span>
          <span className="rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300">
            {enumLabel(site.slaTier)}
          </span>
        </div>
      </div>

      {/* ── Site facts ─────────────────────────────────────── */}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-b border-gray-200 p-4 text-sm dark:border-gray-800">
        <Fact icon={User} label="Contact" value={site.contactPerson} />
        <Fact
          icon={Phone}
          label="Téléphone"
          value={site.contactPhone ?? "Non renseigné"}
        />
        <Fact
          icon={Ruler}
          label="Rayon de pointage"
          value={formatDistance(site.geofenceRadiusM)}
          hint="Distance à laquelle un technicien peut pointer son arrivée sur ce site."
        />
        <Fact
          icon={MapPin}
          action={
            onReposition
              ? { label: "Repositionner", onClick: onReposition }
              : undefined
          }
          label="Position"
          value={`${site.latitude.toFixed(5)}, ${site.longitude.toFixed(5)}`}
        />
      </dl>

      {/* ── Units ──────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Ascenseurs du site
        </h4>

        <ul className="space-y-2">
          {units.map((unit) => (
            <ElevatorRow key={unit.id} unit={unit} />
          ))}
        </ul>
      </div>
    </aside>
  );
}

function Fact({
  icon: Icon,
  label,
  value,
  hint,
  action,
}: {
  icon: typeof User;
  label: string;
  value: string;
  hint?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    // A fact that carries a control takes the whole row: two half-width columns
    // leave roughly 170px, which is not enough for a coordinate pair and a
    // button side by side, and the value would truncate to nothing.
    <div className={cn("min-w-0", action && "col-span-2")} title={hint}>
      <dt className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
        <Icon className="h-3 w-3 flex-none" />
        {label}
      </dt>
      <dd className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium text-gray-800 dark:text-gray-200">
          {value}
        </span>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="flex flex-none items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 dark:text-blue-400 dark:hover:bg-blue-950"
          >
            <Crosshair className="h-3 w-3" />
            {action.label}
          </button>
        )}
      </dd>
    </div>
  );
}

function ElevatorRow({ unit }: { unit: FleetMapElevator }) {
  const style = ATTENTION_STYLES[unit.level];

  // Rounded to whole days here rather than in `attention.ts`: the module
  // deliberately takes `now` as a parameter and never reads the clock itself.
  const due = unit.nextMaintenance
    ? daysUntil(new Date(unit.nextMaintenance), new Date())
    : null;

  return (
    <li className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 flex-none rounded-full ring-1 ring-black/10"
              style={{ backgroundColor: style.color }}
              aria-hidden="true"
            />
            <span className="truncate font-mono text-sm font-semibold text-gray-900 dark:text-white">
              {unit.elevatorCode}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
            {enumLabel(unit.brand)} {unit.model} · {unit.floorsServed} niveaux
          </p>
        </div>

        <Link
          href={`/ascenseurs/${unit.id}`}
          className="flex flex-none items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 dark:text-blue-400 dark:hover:bg-blue-950"
        >
          Fiche
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>

      {/* Every finding, not only the headline — this is the one place with room
          to list them, and a unit that is both overdue and degraded should say
          so here rather than only reporting its worst problem. */}
      {unit.reasons.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {unit.reasons.map((reason, index) => (
            <li
              key={`${reason.level}-${index}`}
              className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300"
            >
              <span
                className="h-1.5 w-1.5 flex-none rounded-full"
                style={{ backgroundColor: ATTENTION_STYLES[reason.level].color }}
                aria-hidden="true"
              />
              {reason.label}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Aucune action en attente.
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-gray-100 pt-2 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
        <span>{enumLabel(unit.status)}</span>
        <span>Santé {Math.round(unit.overallHealth)} %</span>
        {due !== null && (
          <span>
            {due < 0
              ? `Entretien dépassé de ${formatDays(due)}`
              : due === 0
                // `formatDays(0)` reads "aujourd'hui", and the branch above it
                // would have produced "Entretien dans aujourd'hui". Due today
                // is a case of its own.
                ? "Entretien prévu aujourd'hui"
                : `Entretien dans ${formatDays(due)}`}
          </span>
        )}
        {unit.lastMaintenance && (
          <span>
            Dernier passage{" "}
            {formatDistanceToNow(new Date(unit.lastMaintenance), {
              addSuffix: true,
              locale: fr,
            })}
          </span>
        )}
      </div>
    </li>
  );
}
