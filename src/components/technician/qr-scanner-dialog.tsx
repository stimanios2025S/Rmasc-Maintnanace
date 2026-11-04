"use client";

import {
  Camera,
  CameraOff,
  Loader2,
  QrCode,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * « Scanner un QR » — la caméra du téléphone, et un repli qui marche partout.
 *
 * POURQUOI UNE DÉTECTION NATIVE PLUTÔT QU'UNE BIBLIOTHÈQUE
 * `BarcodeDetector` est fourni par le navigateur : aucun paquet à embarquer,
 * aucune image envoyée à un service. Sur un chantier, la connexion est souvent
 * mauvaise — un décodeur qui fonctionne hors ligne est la seule option
 * honnête.
 *
 * CE QUI SE PASSE QUAND IL N'EXISTE PAS
 * Safari et Firefox ne l'implémentent pas encore. La boîte ne prétend alors pas
 * scanner : elle propose de saisir le matricule et le résout contre le parc.
 * Un bouton qui échoue silencieusement est pire qu'un champ de saisie.
 *
 * LE QR EST LU COMME UNE ADRESSE
 * Les QR imprimés par le produit ouvrent `/scan/<elevatorId>`. On extrait
 * l'identifiant et on l'ouvre dans la fiche appareil du personnel — la page
 * publique `/scan` s'adresse au client, pas au technicien.
 */

interface ElevatorOption {
  id: string;
  elevatorCode: string;
  building: { name: string };
}

/** La forme minimale de l'API `BarcodeDetector`, absente de lib.dom. */
type DetectedBarcode = { rawValue: string };
type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
};
type BarcodeDetectorConstructor = new (options?: {
  formats?: string[];
}) => BarcodeDetectorLike;

function detectorConstructor(): BarcodeDetectorConstructor | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as {
    BarcodeDetector?: BarcodeDetectorConstructor;
  }).BarcodeDetector;
  return typeof ctor === "function" ? ctor : null;
}

/** Extrait l'identifiant d'appareil d'un QR, ou rend la valeur brute. */
function parseScan(raw: string): { elevatorId: string | null; code: string | null } {
  const value = raw.trim();
  if (!value) return { elevatorId: null, code: null };

  try {
    const url = new URL(value, window.location.origin);
    const match = url.pathname.match(/\/scan\/([^/?#]+)/);
    if (match) {
      return { elevatorId: decodeURIComponent(match[1]), code: null };
    }
    const fromQuery = url.searchParams.get("elevatorId");
    if (fromQuery) return { elevatorId: fromQuery, code: null };
  } catch {
    // Ce n'est pas une URL : on la traite comme un matricule.
  }

  return { elevatorId: null, code: value };
}

export function QrScannerDialog({
  open,
  onClose,
  onFound,
}: {
  open: boolean;
  onClose: () => void;
  /** Appelé avec l'identifiant de l'appareil reconnu. */
  onFound: (elevatorId: string) => void;
}) {
  const [elevators, setElevators] = useState<ElevatorOption[]>([]);
  const [cameraState, setCameraState] = useState<
    "idle" | "starting" | "running" | "denied" | "unsupported" | "error"
  >("idle");
  const [manualCode, setManualCode] = useState("");
  const [error, setError] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  /**
   * La résolution passe par une référence.
   *
   * Sans elle, l'effet qui démarre la caméra dépendrait de `elevators` : le
   * parc arrive une seconde après l'ouverture, et la caméra redémarrerait à
   * chaque chargement — un clignotement visible en plein scan.
   */
  const resolveRef = useRef<(elevatorId: string | null, code: string | null) => void>(() => undefined);

  const stopCamera = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const resolve = useCallback(
    (elevatorId: string | null, code: string | null) => {
      if (elevatorId) {
        onFound(elevatorId);
        return;
      }
      if (!code) return;

      const needle = code.toLowerCase();
      const match = elevators.find(
        (elevator) => elevator.elevatorCode.toLowerCase() === needle
      );
      if (match) {
        onFound(match.id);
        return;
      }
      setError(
        `Aucun appareil ne porte le matricule « ${code} ». Vérifiez la saisie ou cherchez dans le parc.`
      );
    },
    [elevators, onFound]
  );

  useEffect(() => {
    resolveRef.current = resolve;
  }, [resolve]);

  // Le parc, pour résoudre un matricule scanné ou saisi à la main.
  useEffect(() => {
    if (!open) return;
    setError("");
    setManualCode("");
    setCameraState("idle");

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/elevators");
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) setElevators(Array.isArray(json.data) ? json.data : []);
      } catch {
        // La saisie manuelle reste possible ; la résolution dira simplement
        // qu'aucun appareil ne correspond.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  // Démarrage de la caméra, uniquement quand la boîte est ouverte.
  useEffect(() => {
    if (!open) return;

    const Detector = detectorConstructor();
    if (!Detector) {
      setCameraState("unsupported");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState("unsupported");
      return;
    }

    let cancelled = false;
    setCameraState("starting");

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setCameraState("running");

        const detector = new Detector({ formats: ["qr_code"] });

        timerRef.current = window.setInterval(async () => {
          const video = videoRef.current;
          if (!video || video.readyState < 2) return;
          try {
            const codes = await detector.detect(video);
            if (codes.length === 0) return;

            const parsed = parseScan(codes[0].rawValue);
            stopCamera();
            setCameraState("idle");
            resolveRef.current(parsed.elevatorId, parsed.code);
          } catch {
            // Une lecture ratée est normale ; on réessaie au tick suivant.
          }
        }, 300);
      } catch (e) {
        if (cancelled) return;
        const name = e instanceof DOMException ? e.name : "";
        setCameraState(
          name === "NotAllowedError" || name === "SecurityError"
            ? "denied"
            : "error"
        );
      }
    })();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [open, stopCamera]);

  // Échap ferme.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-end justify-center bg-gray-900/50 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="qr-dialog-title"
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white shadow-2xl dark:bg-gray-900 sm:max-w-md sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4 dark:border-gray-800">
          <div>
            <h2
              id="qr-dialog-title"
              className="flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-white"
            >
              <QrCode className="h-5 w-5 text-blue-500" aria-hidden="true" />
              Scanner un QR
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Visez le code collé sur l&apos;appareil.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div className="relative overflow-hidden rounded-2xl bg-gray-900">
            <video
              ref={videoRef}
              className="h-56 w-full object-cover"
              muted
              playsInline
              aria-label="Flux de la caméra"
            />
            {cameraState !== "running" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-sm text-gray-200">
                {cameraState === "starting" && (
                  <>
                    <Loader2 className="h-6 w-6 animate-spin" />
                    Activation de la caméra…
                  </>
                )}
                {cameraState === "unsupported" && (
                  <>
                    <CameraOff className="h-7 w-7 text-gray-400" />
                    <span>
                      Ce navigateur ne décode pas les QR à la caméra. Saisissez
                      le matricule ci-dessous.
                    </span>
                  </>
                )}
                {cameraState === "denied" && (
                  <>
                    <CameraOff className="h-7 w-7 text-amber-400" />
                    <span>
                      Accès à la caméra refusé. Autorisez-le dans les réglages
                      du navigateur, ou saisissez le matricule.
                    </span>
                  </>
                )}
                {cameraState === "error" && (
                  <>
                    <CameraOff className="h-7 w-7 text-amber-400" />
                    <span>
                      La caméra n&apos;a pas pu démarrer. Saisissez le matricule.
                    </span>
                  </>
                )}
                {cameraState === "idle" && (
                  <>
                    <Camera className="h-7 w-7 text-gray-400" />
                    <span>Caméra arrêtée.</span>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 text-xs uppercase tracking-wider text-gray-400">
            <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
            ou
            <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              setError("");
              resolve(null, manualCode.trim() || null);
            }}
            className="space-y-2"
          >
            <label
              htmlFor="qr-manual-code"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Saisir le matricule de l&apos;appareil
            </label>
            <div className="flex gap-2">
              <input
                id="qr-manual-code"
                value={manualCode}
                onChange={(event) => setManualCode(event.target.value)}
                placeholder="Ex. ASC-2026-0001"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-xl border border-gray-300 bg-white px-3 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
              />
              <button
                type="submit"
                disabled={!manualCode.trim()}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                <Search className="h-4 w-4" aria-hidden="true" />
                Ouvrir
              </button>
            </div>
          </form>

          {error && (
            <p
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
            >
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
