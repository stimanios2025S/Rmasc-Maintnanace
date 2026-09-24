import type { ElevatorStatus } from "@/types";

/**
 * Presentation tokens for an elevator's operational status.
 *
 * These used to be duplicated per screen, and the detail page had drifted to a
 * hardcoded green pill — a unit in CRITICAL_SHUTDOWN displayed the same green
 * badge as a healthy one. One definition, used everywhere, prevents that.
 */
export type StatusStyle = {
  /** Pill background + border. */
  bg: string;
  /** Status dot fill. */
  dot: string;
  /** Text colour. */
  text: string;
};

export const ELEVATOR_STATUS_STYLES: Record<ElevatorStatus, StatusStyle> = {
  OPERATIONAL: {
    bg: "bg-green-50 border-green-200",
    dot: "bg-green-500",
    text: "text-green-700",
  },
  SERVICE_REQUIRED: {
    bg: "bg-yellow-50 border-yellow-200",
    dot: "bg-yellow-500",
    text: "text-yellow-700",
  },
  ANOMALY_DETECTED: {
    bg: "bg-orange-50 border-orange-200",
    dot: "bg-orange-500",
    text: "text-orange-700",
  },
  CRITICAL_SHUTDOWN: {
    bg: "bg-red-50 border-red-200",
    dot: "bg-red-500 animate-pulse",
    text: "text-red-700",
  },
  OFFLINE: {
    bg: "bg-gray-50 border-gray-200",
    dot: "bg-gray-500",
    text: "text-gray-700",
  },
};

/** Falls back to the OFFLINE tokens for any value the API does not recognise. */
export function elevatorStatusStyle(status: string): StatusStyle {
  return (
    ELEVATOR_STATUS_STYLES[status as ElevatorStatus] ??
    ELEVATOR_STATUS_STYLES.OFFLINE
  );
}
