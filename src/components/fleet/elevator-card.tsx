"use client";

/**
 * La carte d'un appareil, pour le registre du parc.
 *
 * Une carte, un appareil, six informations dans l'ordre où on les cherche :
 * qui il est, s'il fonctionne, comment on entre, sous quel contrat, son état de
 * santé, et ce que disent ses capteurs. Les deux actions du pied sont des
 * boutons, pas des liens enveloppants — une carte entière cliquable qui contient
 * des boutons transforme chaque clic manqué en navigation.
 */

import {
  Activity,
  Building2,
  ChevronRight,
  Clock,
  Key,
  ShieldAlert,
  ShieldCheck,
  Thermometer,
  Wrench,
  Zap,
} from "lucide-react";

export interface ElevatorData {
  /** Le code appareil, ex. `EP-BLD01-EL02`. */
  id: string;
  buildingName: string;
  city: string;
  accessCode?: string | null;
  brandModel: string;
  underContract: boolean;
  healthScore: number;
  status: "OPERATIONAL" | "WARNING" | "CRITICAL";
  telemetry?: {
    temperature?: number | null;
    /** Vitesse de porte, en m/s. */
    speed?: number | null;
    /** Heures de service, en milliers d'heures (12.4 = 12 400 h). */
    operatingHours?: number | null;
  };
}

interface ElevatorCardProps {
  elevator: ElevatorData;
  onViewDetails?: (id: string) => void;
  onCreateWorkOrder?: (id: string) => void;
}

function healthStyle(score: number) {
  if (score >= 70) {
    return { bar: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400" };
  }
  if (score >= 40) {
    return { bar: "bg-amber-500", text: "text-amber-700 dark:text-amber-400" };
  }
  return { bar: "bg-red-600", text: "text-red-700 dark:text-red-400" };
}

export function ElevatorCard({
  elevator,
  onViewDetails,
  onCreateWorkOrder,
}: ElevatorCardProps) {
  const meter = healthStyle(elevator.healthScore);

  /**
   * Une mesure n'est affichée que si elle existe.
   *
   * Les trois cases étaient rendues des que la carte recevait un objet
   * télémétrie, même rempli de `null` : on obtenait trois `N/A` et un tiret
   * là où il n'y a rien à lire. La connectivité se juge donc sur les valeurs,
   * et chaque case ne se dessine que si sa valeur est présente.
   */
  const temperature = elevator.telemetry?.temperature ?? null;
  const speed = elevator.telemetry?.speed ?? null;
  const operatingHours = elevator.telemetry?.operatingHours ?? null;
  const hasTelemetry =
    temperature !== null || speed !== null || operatingHours !== null;

  return (
    <div className="group relative flex flex-col justify-between gap-4 overflow-visible rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm transition-all duration-200 hover:shadow-md dark:border-slate-800 dark:bg-slate-900">
      {/* 1. Identifiant & statut opérationnel */}
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <span className="block break-words font-mono text-base font-extrabold leading-tight tracking-tight text-slate-900 dark:text-white">
            {elevator.id}
          </span>
          <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
            <Building2 className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
            <span className="truncate">
              {elevator.buildingName} · {elevator.city}
            </span>
          </div>
        </div>

        {elevator.status === "CRITICAL" && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-red-100 px-2.5 py-1 text-xs font-extrabold text-red-800 dark:bg-red-950 dark:text-red-300">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-600" />
            🔴 Arrêt critique
          </span>
        )}
        {elevator.status === "WARNING" && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            <span className="h-2 w-2 rounded-full bg-amber-500" />
            🟠 Vigilance
          </span>
        )}
        {elevator.status === "OPERATIONAL" && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-bold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            🟢 En service
          </span>
        )}
      </div>

      {/* 2. Accès immeuble & contrat */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2 dark:border-slate-800/80">
        <div className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1 font-mono text-xs font-bold text-white shadow-sm dark:bg-black">
          <Key className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
          <span>Code : {elevator.accessCode || "Non renseigné"}</span>
        </div>

        {elevator.underContract ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
            Sous contrat
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-md border border-red-200/50 bg-red-50 px-2.5 py-1 text-xs font-bold text-red-700 dark:border-red-900/50 dark:bg-red-950/50 dark:text-red-400">
            <ShieldAlert className="h-3.5 w-3.5 text-red-600" aria-hidden="true" />
            Hors contrat
          </span>
        )}
      </div>

      {/* 3. Modèle & santé */}
      <div className="space-y-1.5 rounded-xl border border-slate-100 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-800/40">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-slate-600 dark:text-slate-400">
            {elevator.brandModel}
          </span>
          <span className={`text-xs font-extrabold ${meter.text}`}>
            Santé {elevator.healthScore.toFixed(1)} %
          </span>
        </div>

        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
          <div
            className={`h-full rounded-full ${meter.bar} transition-all duration-500`}
            style={{
              width: `${Math.min(100, Math.max(0, elevator.healthScore))}%`,
            }}
          />
        </div>
      </div>

      {/* 4. Télémétrie — aucune case vide, et un bandeau si rien n'est raccordé */}
      {hasTelemetry ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {temperature !== null && (
            <div className="min-w-[88px] flex-1 rounded-lg border border-slate-100 bg-slate-50 p-2 text-center dark:border-slate-800 dark:bg-slate-800/60">
              <Thermometer
                className="mx-auto mb-0.5 h-3.5 w-3.5 text-red-500"
                aria-hidden="true"
              />
              <div className="text-xs font-bold text-slate-800 dark:text-slate-200">
                {temperature}°C
              </div>
              <div className="text-[10px] text-slate-400">Temp.</div>
            </div>
          )}

          {speed !== null && (
            <div className="min-w-[88px] flex-1 rounded-lg border border-slate-100 bg-slate-50 p-2 text-center dark:border-slate-800 dark:bg-slate-800/60">
              <Zap
                className="mx-auto mb-0.5 h-3.5 w-3.5 text-blue-500"
                aria-hidden="true"
              />
              <div className="text-xs font-bold text-slate-800 dark:text-slate-200">
                {speed} m/s
              </div>
              <div className="text-[10px] text-slate-400">Vitesse</div>
            </div>
          )}

          {operatingHours !== null && (
            <div className="min-w-[88px] flex-1 rounded-lg border border-slate-100 bg-slate-50 p-2 text-center dark:border-slate-800 dark:bg-slate-800/60">
              <Clock
                className="mx-auto mb-0.5 h-3.5 w-3.5 text-amber-500"
                aria-hidden="true"
              />
              <div className="text-xs font-bold text-slate-800 dark:text-slate-200">
                {operatingHours} k h
              </div>
              <div className="text-[10px] text-slate-400">Heures</div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-400 dark:border-slate-800 dark:bg-slate-800/30">
          <Activity className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
          <span>📡 Télémétrie IoT hors ligne</span>
        </div>
      )}

      {/* 5. Actions */}
      <div className="flex items-center gap-2 border-t border-slate-100 pt-2 dark:border-slate-800">
        <button
          type="button"
          onClick={() => onViewDetails?.(elevator.id)}
          className="inline-flex flex-1 items-center justify-center gap-1 rounded-xl bg-slate-100 px-3 py-2 text-xs font-bold text-slate-800 transition-all hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
        >
          <span>Fiche &amp; Historique</span>
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={() => onCreateWorkOrder?.(elevator.id)}
          className="inline-flex items-center justify-center gap-1 rounded-xl bg-amber-500 px-3 py-2 text-xs font-bold text-slate-950 shadow-sm transition-all hover:bg-amber-600 active:scale-95"
          title="Créer un bon ou dispatcher une intervention"
        >
          <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
          <span>⚡ Intervenir</span>
        </button>
      </div>
    </div>
  );
}
