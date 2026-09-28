/**
 * The reporting device's own position, captured once per page and shared.
 *
 * WHY IT IS NOT CAPTURED AT SUBMIT TIME
 * `getCurrentPosition` is not instant. On a phone indoors — which is where
 * somebody reporting a lift fault is standing — the first fix routinely takes
 * several seconds while the radio warms up, and asking for it at the moment the
 * reader presses « Envoyer » would either stall the report behind a permission
 * prompt or force a choice between a slow button and a missing position. So the
 * capture starts when the portal renders and the answer is waiting by the time
 * anyone has picked an elevator and typed a note.
 *
 * WHAT HAPPENS WHEN IT DOES NOT ARRIVE
 * Nothing. `readDevicePosition()` returns null, the API falls back to the
 * building's registered address (`ReportedPositionSource.SITE`), and the report
 * is filed either way. A refusal, a timeout, a browser with no geolocation at
 * all and a page served over plain HTTP are one outcome here, never an error
 * the reader has to clear before they can report a fault.
 *
 * WHY THE CACHE IS MODULE-LEVEL
 * The client portal renders the emergency button and the fault wizard on the
 * same screen. Capturing per component would fire two requests and show a
 * permission prompt twice on the platforms that ask per call. One module-level
 * promise means one capture, one prompt, and the same answer to both.
 *
 * The fix expires rather than living for the session. An hour-old position is
 * not "where the reporter is", it is where they were when they opened the tab —
 * so a stale entry is discarded and a fresh capture is started instead. A
 * *failed* capture is cached on the same clock, deliberately: without that, a
 * client who declined the prompt would be asked again on every render.
 *
 * Browser-only. `navigator` is guarded rather than assumed, so importing this
 * from a module that also runs on the server is harmless — but nothing on the
 * server has any business calling it.
 */

import { isCoordinates } from "./geofence";
import type { Coordinates } from "./geofence";

/** How long a fix stays usable before a new capture is started. */
const FIX_TTL_MS = 5 * 60_000;

/** How long to wait for the device before giving up on it. */
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * How stale a fix the platform may hand back without taking a new one.
 *
 * A minute rather than zero: taking a fresh reading means powering the GPS,
 * which on a phone in a basement buys nothing and costs battery and another
 * eight seconds. A position the platform already has from the last minute
 * answers the only question being asked here.
 */
const MAXIMUM_AGE_MS = 60_000;

interface CachedCapture {
  position: Coordinates | null;
  /** When the capture settled — not when it started. */
  at: number;
}

let cached: CachedCapture | null = null;
let inFlight: Promise<void> | null = null;

/**
 * Whether asking is worth anything.
 *
 * The secure-context test is not paranoia: over plain HTTP the platform does
 * not expose a position at all and rejects with the same error code a refusal
 * produces, so without this the record would say "the reporter declined" about
 * a reader who was never asked. Asking the platform first keeps the two apart.
 */
function isSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.geolocation !== "undefined" &&
    typeof window !== "undefined" &&
    window.isSecureContext !== false
  );
}

/**
 * Starts the capture if there is a reason to.
 *
 * Idempotent and safe to call from every component that will need the answer:
 * a fresh entry, a failed entry and an in-flight request all return immediately.
 */
export function primeDevicePosition(): void {
  if (!isSupported()) return;

  if (cached && Date.now() - cached.at < FIX_TTL_MS) return;
  if (inFlight) return;

  inFlight = new Promise<void>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (result) => {
        const candidate = {
          latitude: result.coords.latitude,
          longitude: result.coords.longitude,
        };
        // A device that answers with something outside the valid ranges has
        // told us nothing, and `readCoordinates` on the server would reject it
        // anyway. Storing null here means the fallback happens where it is
        // visible rather than at the far end of a request.
        cached = {
          position: isCoordinates(candidate) ? candidate : null,
          at: Date.now(),
        };
        resolve();
      },
      () => {
        cached = { position: null, at: Date.now() };
        resolve();
      },
      {
        enableHighAccuracy: true,
        timeout: REQUEST_TIMEOUT_MS,
        maximumAge: MAXIMUM_AGE_MS,
      }
    );
  }).finally(() => {
    inFlight = null;
  });
}

/**
 * The captured position, or null when there is not one.
 *
 * Never blocks: it reads whatever the capture has settled on so far, and a
 * capture still in flight simply reads as null. That is the whole point — the
 * report must not wait for it.
 */
export function readDevicePosition(): Coordinates | null {
  if (!cached) return null;
  if (Date.now() - cached.at >= FIX_TTL_MS) return null;
  return cached.position;
}
