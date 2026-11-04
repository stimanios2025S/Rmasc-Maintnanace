import type { ElevatorStatus } from "@/types";
import { TRAFFIC_LEVELS, type TrafficLevel } from "@/lib/ui/traffic";

/**
 * Presentation tokens for an elevator's operational status.
 *
 * These used to be duplicated per screen, and the detail page had drifted to a
 * hardcoded green pill — a unit in CRITICAL_SHUTDOWN displayed the same green
 * badge as a healthy one. One definition, used everywhere, prevents that.
 *
 * Depuis la refonte UX, cette table ne choisit plus ses couleurs : elle les
 * reçoit de `TRAFFIC_LEVELS`. Le vert/orange/rouge est désormais le même sur un
 * ascenseur, un contrat et un incident — un utilisateur n'a qu'un code à
 * apprendre.
 */
export type StatusStyle = {
  /** Pill background + border. */
  bg: string;
  /** Status dot fill. */
  dot: string;
  /** Text colour. */
  text: string;
};

function fromTraffic(level: TrafficLevel, dot?: string): StatusStyle {
  const tone = TRAFFIC_LEVELS[level];
  return {
    bg: `${tone.bg} ${tone.border}`,
    dot: dot ?? tone.dot,
    text: tone.text,
  };
}

export const ELEVATOR_STATUS_STYLES: Record<ElevatorStatus, StatusStyle> = {
  OPERATIONAL: fromTraffic("ok"),
  SERVICE_REQUIRED: fromTraffic("warning"),
  // Une anomalie est une dérive, pas un arrêt : orange, comme la vigilance.
  ANOMALY_DETECTED: fromTraffic("warning"),
  CRITICAL_SHUTDOWN: fromTraffic("danger", "bg-red-500 animate-pulse"),
  // L'état d'une machine qui ne remonte rien n'est pas connu — gris, et la
  // légende le dit, plutôt que de la peindre en vert ou en rouge.
  OFFLINE: fromTraffic("neutral"),
};

/** Falls back to the OFFLINE tokens for any value the API does not recognise. */
export function elevatorStatusStyle(status: string): StatusStyle {
  return (
    ELEVATOR_STATUS_STYLES[status as ElevatorStatus] ??
    ELEVATOR_STATUS_STYLES.OFFLINE
  );
}
