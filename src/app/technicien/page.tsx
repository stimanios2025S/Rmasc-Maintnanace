"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  Clock,
  Camera,
  FileText,
  MapPin,
  Wrench,
  Circle,
  PenTool,
  XCircle,
  MinusCircle,
  Link2,
  ExternalLink,
  Ruler,
  ClipboardList,
  AlertTriangle,
  MessageSquare,
  Mic,
  ArrowRight,
  CheckCheck,
  KeyRound,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { SignaturePad } from "@/components/technician/signature-pad";
import type { SignatureValue } from "@/components/technician/signature-pad";
import { PartRequirementsPanel } from "@/components/maintenance/part-requirements-panel";
import { ENTRETIEN_CHECK_NAMES } from "@/lib/maintenance/entretien-checklist";
import type { ReportKind } from "@/types";
import {
  CompletionReportForm,
  completionActionLabel,
} from "@/components/technician/completion-report-form";
import type { CompletionReport } from "@/components/technician/completion-report-form";
import { IncidentDialog } from "@/components/technician/incident-dialog";
import { MessagesDialog } from "@/components/technician/messages-dialog";
import { NotificationBell } from "@/components/layout/notification-bell";
import { enumLabel } from "@/lib/ui/enum-labels";
import { evaluateGeofence, formatDistance } from "@/lib/geo/geofence";
import type { Coordinates } from "@/lib/geo/geofence";

/**
 * How often this device tells the office where it is.
 *
 * Forty-five seconds, chosen against what the number is *for*: a dispatcher
 * reading "1,2 km" off a list does not need better than that, and a faster
 * clock would spend a technician's battery and mobile data redrawing a dot
 * that has moved the length of a street. The server enforces its own floor of
 * twenty seconds (see `POST /api/technician/position`), so this cadence is a
 * courtesy rather than the only thing holding the write rate down.
 */
const POSITION_INTERVAL_MS = 45_000;

// ─── Types ────────────────────────────────────────────────────

interface ActiveJob {
  id: string;
  orderNumber: string;
  title: string;
  description: string | null;
  type: string;
  priority: string;
  status: string;
  scheduledDate: string | null;
  estimatedHours: number | null;
  /**
   * When the technician pressed « J'ai pointé mon arrivée », or null.
   *
   * Distinct from the job simply being `IN_PROGRESS`: an order can have been
   * started from the van. This is the field that answers "is anyone actually
   * in the building", which is what the customer ringing us wants to know.
   */
  arrivedAt: string | null;
  /** The optional note captured at check-in — access details, a keyholder. */
  checkInNotes: string | null;
  notes: string | null;
  partsReplaced: Array<{ name: string; partNumber?: string; qty: number }> | null;
  /**
   * What the technician already entered on a previous report attempt.
   *
   * Carried even though the completion form is only reachable before the first
   * submission: a report the office sends back comes round again, and arriving
   * at an empty form to retype a part list is how a correction turns into a
   * second, different report.
   */
  isBillable: boolean;
  invoiceAmount: number | null;
  photoUrls: string[];
  elevator: string;
  building: string;
  address: string;
  /**
   * Le lieu exact préparé pour ce bon, ou l'adresse du site à défaut.
   *
   * Ce que le bureau a saisi — cage, étage, entrée — et non seulement
   * l'adresse de l'immeuble. Le serveur le compose déjà : l'écran l'affiche
   * tel quel et n'a pas à deviner.
   */
  interventionAddress: string | null;
  /** Code d'accès immeuble / local technique, communiqué avec l'affectation. */
  accessCode: string | null;
  /**
   * Where the site is, and how close a technician must be to check in.
   *
   * Null coordinates mean the building has never been geolocated. The button
   * then stays enabled on purpose — see `evaluateGeofence` — because refusing
   * would strand a technician at a site nobody ever mapped.
   */
  siteLatitude: number | null;
  siteLongitude: number | null;
  geofenceRadiusM: number | null;
  component: string | null;
  /**
   * Les points que ce bon doit couvrir, tels que le programme d'entretien les
   * définit. Vide sur un dépannage : un bon de panne n'a pas de programme, et
   * la liste standard prend alors le relais — voir `checklistFor`.
   */
  checklist: string[];
  inspection: {
    id: string;
    reportNumber: string;
    summary: string | null;
    submittedAt: string;
    checkItems: Array<{
      checkName: string;
      result: CheckResult;
      notes: string | null;
      photoUrl: string | null;
    }>;
  } | null;
}

/**
 * What a checklist line can be recorded as.
 *
 * A checkbox has one outcome and a safety inspection has several. "The brake
 * holds" and "the brake slips" are both results of having inspected the brake,
 * and the previous UI could only express the first — so a technician who found
 * a fault had to either tick the box and lie, or leave it unticked and be
 * unable to close the job at all.
 *
 * `null` (not `NOT_APPLICABLE`) means "not yet inspected": N/A is a finding —
 * this check does not apply to this unit — and it has to be distinguishable
 * from not having looked.
 */
type CheckResult = "PASS" | "FAIL" | "NEEDS_ATTENTION" | "NOT_APPLICABLE";
type CheckState = CheckResult | null;

const RESULT_ICON = {
  PASS: CheckCircle2,
  FAIL: XCircle,
  NEEDS_ATTENTION: XCircle,
  NOT_APPLICABLE: MinusCircle,
} as const;

const RESULT_STYLE: Record<CheckResult, string> = {
  PASS: "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800",
  FAIL: "bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-800",
  NEEDS_ATTENTION: "bg-amber-50 dark:bg-amber-900/20 border-amber-300 dark:border-amber-800",
  NOT_APPLICABLE: "bg-gray-50 dark:bg-gray-800/60 border-gray-200 dark:border-gray-700",
};

const RESULT_ICON_COLOR: Record<CheckResult, string> = {
  PASS: "text-green-500",
  FAIL: "text-red-500",
  NEEDS_ATTENTION: "text-amber-500",
  NOT_APPLICABLE: "text-gray-400",
};

/** Cycles Pass → Fail → N/A → cleared, so one control covers all outcomes. */
const RESULT_CYCLE: CheckState[] = ["PASS", "FAIL", "NOT_APPLICABLE", null];

interface CompletedJob {
  id: string;
  orderNumber: string;
  title: string;
  elevator: string;
  /**
   * `COMPLETED` once the office has accepted the report, `PENDING_APPROVAL`
   * while it is still in their queue. The two are listed together on purpose —
   * see the note on the "Aujourd'hui" panel.
   */
  status: string;
  completedAt: string | null;
  reportSubmittedAt: string | null;
  actualHours: number | null;
}

/**
 * The standard checklist, in French.
 *
 * These strings are not only displayed: each one is written into
 * `InspectionCheck.checkName` when a report is filed, and the restore pass
 * above matches a saved report back to this list *by name*. Translating them
 * therefore changes what new reports store, and a report filed before this
 * change (whose lines are in English) will no longer re-match and will come
 * back unset. The deployment holds no such report today; if one is restored
 * from a backup, re-file it or add the old spellings as aliases here.
 */
const DEFAULT_CHECKLIST = [
  "Inspection visuelle du carter moteur",
  "Contrôle de l'étalonnage du capteur de température",
  "Mesure de la résistance des enroulements moteur",
  "Inspection du système de refroidissement",
  "Contrôle thermique du système de freinage",
  "Extraction du journal d'erreurs de la commande",
  "Essai de fonctionnement après action corrective",
];

/**
 * La liste de points d'un bon : celle du programme d'entretien s'il en a un,
 * la liste standard sinon.
 *
 * Un bon de dépannage n'a pas de programme et garde donc la liste générique ;
 * une visite planifiée porte celle du contrat, et c'est celle-là que le
 * technicien doit cocher. Se tromper de liste ne se verrait pas à l'écran : le
 * rapport partirait simplement avec des lignes qui ne répondent pas à
 * l'obligation pour laquelle la visite a été ouverte.
 *
 * Une liste vide est traitée comme « pas de liste » plutôt que comme « rien à
 * contrôler » : un programme dont les points ont été effacés ne doit pas
 * envoyer quelqu'un sur site avec un formulaire vide et un bouton de
 * validation qui refuse tout.
 */
function checklistFor(job: ActiveJob): string[] {
  if (job.checklist.length > 0) return job.checklist;
  /**
   * OÙ PASSE LA FICHE D'ENTRETIEN MENSUEL
   * Une visite préventive sans programme — ou dont le programme n'a pas de
   * points — reçoit la grille officielle For: APP/DA/04/13 plutôt que la liste
   * générique. Un contrat qui déclare ses propres points les garde : c'est ce
   * que le client a signé, et le remplacer par la grille standard ferait
   * contrôler autre chose que ce qui a été vendu.
   */
  return kindFor(job) === "ENTRETIEN"
    ? [...ENTRETIEN_CHECK_NAMES]
    : DEFAULT_CHECKLIST;
}

/**
 * Quelle feuille ce bon produit.
 *
 * Dérivée du type du bon, et dérivée seulement : offrir le choix au technicien
 * l'obligerait à savoir laquelle des deux feuilles l'entreprise attend, et il
 * répondrait au hasard une fois sur deux. Une visite préventive est un entretien
 * contractuel ; tout le reste est une intervention, donc une inspection.
 *
 * La même dérivation est faite côté schéma, où `INSPECTION` est la valeur par
 * défaut : un appelant qui n'envoie rien obtient la feuille générique.
 */
function kindFor(job: ActiveJob): ReportKind {
  return job.type === "PREVENTIVE" ? "ENTRETIEN" : "INSPECTION";
}

const PRIORITY_STYLES: Record<string, string> = {
  CRITICAL: "bg-red-100 text-red-800 border-red-300",
  EMERGENCY: "bg-red-100 text-red-800 border-red-300",
  HIGH: "bg-orange-100 text-orange-800 border-orange-300",
  MEDIUM: "bg-blue-100 text-blue-800 border-blue-300",
  LOW: "bg-gray-100 text-gray-600 border-gray-300",
};

/**
 * Le repère d'une étape du parcours guidé.
 *
 * Quatre étapes, dans l'ordre où le travail se fait. Le numéro est dans un
 * cercle plein plutôt qu'un simple titre : sur un téléphone, c'est ce qui dit
 * « vous êtes ici » sans lire la phrase.
 */
/** Les initiales d'un nom, pour l'avatar de la bannière de profil. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "T";
  return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}

function StepHeader({
  step,
  title,
  subtitle,
  done = false,
}: {
  step: number;
  title: string;
  subtitle?: string;
  done?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        className={`grid h-8 w-8 flex-none place-items-center rounded-full text-sm font-bold ${
          done
            ? "bg-green-600 text-white"
            : "bg-blue-600 text-white"
        }`}
        aria-hidden="true"
      >
        {done ? <CheckCheck className="h-4 w-4" /> : step}
      </span>
      <div className="min-w-0">
        <h4 className="text-sm font-bold text-gray-900 dark:text-white">
          {title}
        </h4>
        {subtitle && (
          <p className="text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>
        )}
      </div>
    </div>
  );
}

/**
 * La dictée vocale, sur le champ des notes.
 *
 * Web Speech API uniquement — aucun service externe, aucun enregistrement
 * stocké. Le bouton disparaît quand le navigateur ne l'implémente pas (Firefox
 * sur certaines versions), plutôt que d'offrir un micro qui ne fait rien.
 */
function DictationButton({ onText }: { onText: (text: string) => void }) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);

  useEffect(() => {
    const w = window as unknown as {
      SpeechRecognition?: unknown;
      webkitSpeechRecognition?: unknown;
    };
    setSupported(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition));
  }, []);

  function toggle() {
    if (!supported) return;
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.lang = "fr-FR";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (transcript) onText(transcript);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }

  if (!supported) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={listening ? "Arrêter la dictée" : "Dicter les notes"}
      title={listening ? "Arrêter la dictée" : "Dicter les notes"}
      className={`absolute bottom-2 right-2 grid h-9 w-9 place-items-center rounded-full shadow-sm transition-colors ${
        listening
          ? "bg-red-600 text-white animate-pulse"
          : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:border-gray-700"
      }`}
    >
      <Mic className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

/** Le sous-ensemble de l'API SpeechRecognition que ce fichier utilise. */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

export default function TechnicianPage() {
  const [techName, setTechName] = useState("Technicien de terrain");
  const [jobs, setJobs] = useState<ActiveJob[]>([]);
  const [completed, setCompleted] = useState<CompletedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /** L'action terrain qui ouvre une boîte de dialogue. */
  const [incidentOpen, setIncidentOpen] = useState(false);
  /**
   * La mission demandée par un lien de notification (`?mission=<id>`).
   *
   * La cloche peut ouvrir directement le bon concerné ; sans ce paramètre,
   * l'écran choisit la mission en cours ou la plus prioritaire.
   */
  const [requestedMissionId, setRequestedMissionId] = useState<string | null>(
    null
  );

  useEffect(() => {
    const mission = new URLSearchParams(window.location.search).get("mission");
    if (mission) setRequestedMissionId(mission);
  }, []);

  /**
   * Depuis une notification, on arrive sur la bonne carte : le défilement
   * évite de la chercher dans la page. L'effet vit ici, avant tout retour
   * anticipé, pour que l'ordre des hooks reste stable entre le chargement et
   * l'écran chargé.
   */
  useEffect(() => {
    if (!requestedMissionId) return;
    const target = document.getElementById(`job-${requestedMissionId}`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [requestedMissionId, jobs.length]);
  /** Le bon dont le canal de discussion est ouvert, s'il y en a un. */
  const [messagesJob, setMessagesJob] = useState<{
    id: string;
    orderNumber: string;
  } | null>(null);
  const [checklist, setChecklist] = useState<Record<string, CheckState[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  /**
   * The job whose completion report is open, if any.
   *
   * Held as the whole job rather than its id so the form has its order number,
   * type and site to render without another lookup, and so a background refresh
   * of the queue cannot swap the report under the technician's cursor.
   */
  const [reportFor, setReportFor] = useState<ActiveJob | null>(null);
  /** A failure reported by the API, kept out of the form's own validation. */
  const [reportError, setReportError] = useState("");
  const [showNotes, setShowNotes] = useState<string | null>(null);
  /** jobId → checklist index → photo URL documenting that line. */
  const [photos, setPhotos] = useState<Record<string, Record<number, string>>>({});
  /** The line whose photo field is open, if any. */
  const [photoPrompt, setPhotoPrompt] = useState<{
    jobId: string;
    index: number;
  } | null>(null);
  const [photoDraft, setPhotoDraft] = useState("");
  /** jobId → the signature captured for that job, or null. */
  const [signatures, setSignatures] = useState<Record<string, SignatureValue | null>>({});
  /** The job whose signature pad is open, if any. */
  const [signingJob, setSigningJob] = useState<string | null>(null);
  /** The job whose optional arrival note is open, if any. */
  const [arrivalNoteFor, setArrivalNoteFor] = useState<string | null>(null);
  /** jobId → the arrival note being typed. Not the job's saved `notes`. */
  const [arrivalNotes, setArrivalNotes] = useState<Record<string, string>>({});
  /**
   * jobId → whether the technician agreed to place an unmapped site using the
   * position captured at check-in.
   *
   * Stored as "the exceptions, not the rule": an absent key means yes, so the
   * common case — an unmapped site, a technician standing on it — needs no
   * interaction at all, and only an explicit untick has to be remembered.
   */
  const [placeSiteOnCheckIn, setPlaceSiteOnCheckIn] = useState<
    Record<string, boolean>
  >({});

  /**
   * The device's last known position, or null while there is not one.
   *
   * Watched rather than read once. The portal is opened in the van and looked
   * at again at the door, so a single reading taken on page load would place
   * the technician wherever they happened to be when they unlocked the phone —
   * which is exactly the situation the geofence exists to catch.
   */
  const [position, setPosition] = useState<Coordinates | null>(null);
  /** Set when the browser cannot or will not provide a position. */
  const [geoNotice, setGeoNotice] = useState<string | null>(null);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      // Not fatal: the server allows a check-in with no coordinates, so the
      // technician can still work. Only the pre-warning is lost.
      setGeoNotice(
        "Ce navigateur ne fournit pas la position : le pointage reste possible, sans contrôle de distance."
      );
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (reading) => {
        setPosition({
          latitude: reading.coords.latitude,
          longitude: reading.coords.longitude,
        });
        setGeoNotice(null);
      },
      () => {
        setGeoNotice(
          "Position indisponible. Autorisez la localisation pour que le pointage vérifie automatiquement votre présence sur le chantier."
        );
      },
      // A reading up to 30 s old is fine: the technician is standing still at
      // the moment it matters, and a fresh fix is worth waiting through.
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 15_000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  /**
   * Reports that position to the office, on a slow clock.
   *
   * WHY THIS IS A SECOND EFFECT AND NOT PART OF THE WATCH
   * The watch fires whenever the device has a new fix — on a walk, that can be
   * several times a second, and sending each one would cost battery and
   * bandwidth to redraw a dot that has moved four metres. Dispatching reads
   * distances in hundreds of metres, so the effect samples rather than
   * forwards: it sends at most one update every 45 seconds, and only when the
   * position has genuinely changed since the last send.
   *
   * The first reading is sent immediately, because the one case that matters
   * most is a technician who opens the portal in the van and is then watched
   * for the whole approach.
   *
   * A failure is swallowed on purpose. This is telemetry about a person, called
   * from a background timer, on a phone that may be in a basement: a rejected
   * request must never surface as an error in front of the technician, whose
   * work does not depend on it.
   */
  const lastSentRef = useRef<{ latitude: number; longitude: number; at: number } | null>(
    null
  );

  useEffect(() => {
    if (!position) return;

    const last = lastSentRef.current;
    const moved =
      last === null ||
      last.latitude !== position.latitude ||
      last.longitude !== position.longitude;
    if (!moved) return;
    if (last !== null && Date.now() - last.at < POSITION_INTERVAL_MS) return;

    // Recorded before the request rather than after it: a send that never
    // resolves must not leave the timer free to fire again on the next reading.
    lastSentRef.current = {
      latitude: position.latitude,
      longitude: position.longitude,
      at: Date.now(),
    };

    void fetch("/api/technician/position", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        latitude: position.latitude,
        longitude: position.longitude,
      }),
    }).catch(() => {
      // Deliberately silent. See above.
    });
  }, [position]);

  /**
   * Whether this job's site accepts a check-in from where the device is.
   *
   * The identical function the server runs, so the button never greys out for
   * a check-in the API would have accepted — and, more importantly, never
   * looks available for one it would refuse.
   */
  const verdictFor = useCallback(
    (job: ActiveJob) => {
      const site =
        job.siteLatitude !== null && job.siteLongitude !== null
          ? { latitude: job.siteLatitude, longitude: job.siteLongitude }
          : null;
      return evaluateGeofence(site, position, job.geofenceRadiusM);
    },
    [position]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/technician");
      if (!res.ok)
        throw new Error(`L'API technicien a répondu ${res.status}`);
      const json = await res.json();
      // Typed here rather than left as `any`: the checklist restore below
      // reads nested arrays, and an untyped payload made every callback
      // parameter implicitly `any`.
      const activeJobs: ActiveJob[] = json.data.active ?? [];
      const completedJobs: CompletedJob[] = json.data.completedToday ?? [];

      setTechName(json.data.technician?.name ?? "Technicien de terrain");
      setJobs(activeJobs);
      setCompleted(completedJobs);
      // Restore each checklist. Previously this always reset to all-unchecked,
      // so ticking boxes and refreshing silently lost the work. If a saved
      // report exists, each line comes back with the result it was filed with
      // — not just whether it passed.
      setChecklist((prev) => {
        const next = { ...prev };
        for (const j of activeJobs) {
          const saved = j.inspection?.checkItems ?? [];
          if (saved.length === 0) {
            if (!next[j.id]) next[j.id] = checklistFor(j).map(() => null);
            continue;
          }
          const byName = new Map(saved.map((c) => [c.checkName, c.result]));
          next[j.id] = checklistFor(j).map((name) => byName.get(name) ?? null);
        }
        return next;
      });
      setPhotos((prev) => {
        const next = { ...prev };
        for (const j of activeJobs) {
          if (next[j.id]) continue;
          const saved = j.inspection?.checkItems ?? [];
          if (saved.length === 0) continue;

          const byName = new Map(
            saved.filter((c) => c.photoUrl).map((c) => [c.checkName, c.photoUrl as string])
          );
          const restored: Record<number, string> = {};
          checklistFor(j).forEach((name, index) => {
            const url = byName.get(name);
            if (url) restored[index] = url;
          });
          if (Object.keys(restored).length > 0) next[j.id] = restored;
        }
        return next;
      });
      setNotes((prev) => {
        const next = { ...prev };
        for (const j of activeJobs) {
          if (next[j.id] === undefined) next[j.id] = j.notes ?? "";
        }
        return next;
      });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Échec du chargement des affectations"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const cycleCheck = (job: ActiveJob, index: number) => {
    setChecklist((prev) => {
      const arr = [...(prev[job.id] ?? checklistFor(job).map(() => null))];
      const current = arr[index] ?? null;
      const position = RESULT_CYCLE.indexOf(current);
      arr[index] = RESULT_CYCLE[(position + 1) % RESULT_CYCLE.length];
      return { ...prev, [job.id]: arr };
    });
  };

  /**
   * Deux gestes directs, 🟢 OK / 🔴 Défaut, à côté du cycle à quatre états.
   *
   * Le cycle reste pour « à surveiller » et « sans objet », mais l'immense
   * majorité des lignes se tranchent en OK ou en défaut. Deux boutons de 44 px
   * valent mieux qu'un cycle de quatre appuis quand on est dans une gaine.
   * Réappuyer sur le même résultat l'efface — c'est le seul retour en arrière.
   */
  const setCheck = (job: ActiveJob, index: number, value: CheckResult) => {
    setChecklist((prev) => {
      const arr = [...(prev[job.id] ?? checklistFor(job).map(() => null))];
      arr[index] = arr[index] === value ? null : value;
      return { ...prev, [job.id]: arr };
    });
  };

  function savePhoto(jobId: string, index: number) {
    const url = photoDraft.trim();
    setPhotos((prev) => ({
      ...prev,
      [jobId]: { ...(prev[jobId] ?? {}), [index]: url },
    }));
    setPhotoPrompt(null);
    setPhotoDraft("");
  }

  function clearPhoto(jobId: string, index: number) {
    setPhotos((prev) => {
      const forJob = { ...(prev[jobId] ?? {}) };
      delete forJob[index];
      return { ...prev, [jobId]: forJob };
    });
  }

  const updateStatus = async (jobId: string, status: string, extra: Record<string, unknown> = {}) => {
    setBusyId(jobId);
    try {
      const res = await fetch(`/api/work-orders?id=${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, ...extra }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? "Échec de la mise à jour");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Échec de la mise à jour");
    } finally {
      setBusyId(null);
    }
  };

  /**
   * « J'ai pointé mon arrivée » — the technician is on site.
   *
   * A dedicated endpoint rather than the status PATCH above, because arrival
   * is not merely a status. The server stamps `arrivedAt`, advances the linked
   * incident so the customer's progress bar moves, and notifies both the
   * customer and the office. None of that is expressible as a status change,
   * which is why the old "Démarrer l'intervention" button is gone: it claimed
   * the work had begun while telling the waiting customer nothing.
   *
   * The note is optional and only sent when one was actually typed. The main
   * button must work with no note at all — it is pressed one-handed, in a
   * machine room, and anything that adds a required step is a step that gets
   * skipped.
   */
  const checkIn = async (jobId: string, options?: { skipGps?: boolean }) => {
    setBusyId(jobId);
    setError("");
    try {
      const notes = (arrivalNotes[jobId] ?? "").trim();
      /**
       * « Pointer sans GPS / Sous-sol » : on omet la position.
       *
       * Le serveur n'applique le geofence que sur des coordonnées fournies ;
       * une lecture GPS aberrante dans un sous-sol ne doit pas empêcher de
       * pointer son arrivée. Le pointage sans coordonnées reste un fait
       * enregistré, simplement non vérifié par la distance.
       */
      const includePosition = position !== null && !options?.skipGps;

      /**
       * Whether this check-in should also place the site on the map.
       *
       * Three conditions, all necessary: there is a position to send at all;
       * the technician has not unticked the box (`!== false`, because an
       * absent key means ticked — see the state declaration); and the site is
       * genuinely unmapped. The last one is also enforced server-side, so a
       * stale `jobs` array cannot overwrite a position an administrator has
       * set in the meantime.
       */
      const job = jobs.find((j) => j.id === jobId);
      const wantsPlacement =
        includePosition &&
        placeSiteOnCheckIn[jobId] !== false &&
        job !== undefined &&
        (job.siteLatitude === null || job.siteLongitude === null);

      const res = await fetch(`/api/work-orders/${jobId}/check-in`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        /**
         * The position is sent whenever there is one, and omitted otherwise.
         *
         * The server decides what a missing coordinate means, and allows it —
         * so a refused permission or a failed fix in a basement never costs a
         * technician their check-in. Both keys are spread conditionally rather
         * than sent as `null`, because the route's schema is strict and an
         * explicit null would be a validation error.
         */
        body: JSON.stringify({
          ...(notes ? { notes } : {}),
          ...(includePosition && position
            ? { latitude: position.latitude, longitude: position.longitude }
            : {}),
          ...(wantsPlacement ? { usePositionAsSiteLocation: true } : {}),
        }),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        // A 409 means the arrival is already recorded — most often a second
        // tap. The server's message says so, and it is more useful than a
        // generic failure: the technician learns their first tap worked.
        throw new Error(json.error ?? "Le pointage a échoué");
      }

      setArrivalNoteFor(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Le pointage a échoué");
    } finally {
      setBusyId(null);
    }
  };

  const saveNotes = async (jobId: string) => {
    await updateStatus(jobId, jobs.find((j) => j.id === jobId)?.status ?? "IN_PROGRESS", {
      notes: notes[jobId] ?? "",
    });
    setShowNotes(null);
  };

  /**
   * File the inspection report and the completion report, then hand the order
   * to the office for validation.
   *
   * The order of the two writes matters, and it is the one the screen used
   * before: evidence first. If the inspection report fails to save, nothing
   * else is attempted — otherwise the checklist that gated completion is lost
   * and the order lands in the approval queue with no record of what was
   * inspected. The reverse failure is tolerable: a report filed with the status
   * unchanged is an order the technician can simply send again.
   *
   * The work order is *not* completed here. It moves to PENDING_APPROVAL, which
   * takes it off this technician's queue and frees him — `syncTechnicianStatus`
   * on the server counts that transition as the end of his part — and puts it
   * in front of the office. Completing it would mean an amount typed on a phone
   * reached a client with nobody having read it.
   */
  const submitCompletionReport = async (
    job: ActiveJob,
    report: CompletionReport
  ) => {
    const checks = checklist[job.id] ?? checklistFor(job).map(() => null);
    if (checks.some((c) => c === null)) {
      setReportError(
        "Renseignez un résultat pour chaque point de contrôle avant de valider le rapport."
      );
      return;
    }

    setBusyId(job.id);
    setReportError("");
    try {
      if (!job.inspection) {
        const jobPhotos = photos[job.id] ?? {};
        const signature = signatures[job.id] ?? null;

        const res = await fetch("/api/inspection-reports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workOrderId: job.id,
            kind: kindFor(job),
            summary: report.description,
            items: checklistFor(job).map((checkName, index) => ({
              checkName,
              result: checks[index] as CheckResult,
              ...(jobPhotos[index] ? { photoUrl: jobPhotos[index] } : {}),
            })),
            ...(signature
              ? { signatures: [{ role: "TECHNICIAN", ...signature }] }
              : {}),
          }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(
            json.error ?? "Échec de l'enregistrement du rapport d'inspection"
          );
        }
      }

      const res = await fetch(`/api/work-orders?id=${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "PENDING_APPROVAL",
          /**
           * The description is written onto the order as well as into the
           * report, and this is the one duplication in the flow. The two are
           * not the same record: the report's summary is the evidence filed at
           * the moment of completion and is never rewritten, while `notes` is
           * the current account of the job that the office can correct while
           * validating it. Keeping only the first would freeze a typo; keeping
           * only the second would leave an approved order whose report says
           * something else.
           */
          notes: report.description,
          partsReplaced: report.parts,
          isBillable: report.isBillable,
          invoiceAmount: report.isBillable ? report.invoiceAmount : null,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(
          json.error ?? "Échec de l'envoi du rapport au bureau"
        );
      }

      setReportFor(null);
      await load();
    } catch (e) {
      setReportError(
        e instanceof Error
          ? e.message
          : "Échec de l'envoi du rapport au bureau"
      );
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6 max-w-2xl mx-auto">
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  if (error && jobs.length === 0) {
    return (
      <div className="max-w-2xl mx-auto">
        <ErrorState message={error} onRetry={load} />
      </div>
    );
  }

  /**
   * L'intervention qui pilote la barre fixe : la première à faire, dans
   * l'ordre où le serveur les a triées (priorité puis date).
   */
  /**
   * La mission active, et une seule.
   *
   * Celle qui est commencée d'abord ; sinon la plus prioritaire — le serveur
   * trie déjà par priorité puis par date. Les autres attendent en bas, en
   * lecture seule : un technicien ne mène pas deux chantiers de front dans une
   * cage d'ascenseur.
   */
  const requestedJob = requestedMissionId
    ? jobs.find((job) => job.id === requestedMissionId)
    : undefined;
  const activeJob =
    requestedJob ??
    jobs.find((job) => job.status === "IN_PROGRESS") ??
    jobs[0];
  const otherJobs = activeJob
    ? jobs.filter((job) => job.id !== activeJob.id)
    : [];
  const stickyJob = activeJob;
  const stickyStarted =
    Boolean(stickyJob?.arrivedAt) || stickyJob?.status === "IN_PROGRESS";
  const stickyChecks = stickyJob
    ? checklist[stickyJob.id] ?? checklistFor(stickyJob).map(() => null)
    : [];
  const stickyProgress =
    stickyChecks.length > 0
      ? stickyChecks.filter((value) => value !== null).length /
        stickyChecks.length
      : 0;
  const stickyLabel = !stickyJob
    ? ""
    : !stickyStarted
      ? "Démarrer l'intervention"
      : stickyProgress >= 1
        ? "Valider & Clôturer"
        : "Étape suivante";

  return (
    <div className="space-y-6 max-w-2xl mx-auto pb-28">
      {/* En-tête mobile : identité, présence, contact bureau, cloche. */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="grid h-12 w-12 flex-none place-items-center rounded-full bg-blue-600 text-lg font-bold text-white shadow-sm"
            aria-hidden="true"
          >
            {initials(techName)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-base font-bold text-gray-900 dark:text-white">
              {techName}
            </p>
            <span className="mt-0.5 inline-flex items-center gap-1.5 rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-semibold text-green-700 dark:bg-green-950/40 dark:text-green-300">
              <span
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500"
                aria-hidden="true"
              />
              En service
            </span>
          </div>
        </div>
        <div className="flex flex-none items-center gap-1">
          <button
            type="button"
            onClick={() => {
              const job = activeJob;
              if (job)
                setMessagesJob({ id: job.id, orderNumber: job.orderNumber });
              else setIncidentOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-xs font-semibold text-gray-700 shadow-sm transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            <MessageSquare className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Contacter le bureau</span>
            <span className="sm:hidden">Bureau</span>
          </button>
          <NotificationBell enabled />
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">
          {error}
        </p>
      )}

      {/* L'ancre du bouton « Mes bons du jour ». */}
      <span id="mes-bons" className="block scroll-mt-6" aria-hidden="true" />

      {/* Mission active — une seule à l'écran */}
      {!activeJob ? (
        <EmptyState
          icon={ClipboardList}
          title="Aucune mission planifiée pour le moment"
          description="Vous êtes en attente d'affectation."
        />
      ) : (
        [activeJob].map((job) => {
          // `null` means "not yet recorded" and is not the same as a recorded
          // NOT_APPLICABLE — an item nobody assessed must not count towards
          // completion, and must not be silently filed as a Pass either.
          const checks = checklist[job.id] ?? checklistFor(job).map(() => null);
          const done = checks.filter((c) => c !== null).length;
          const progress = checks.length > 0 ? (done / checks.length) * 100 : 0;

          // Computed once per row, so the button's enabled state and the
          // explanation beneath it can never disagree with each other.
          const verdict = verdictFor(job);
          /** Whether this site has ever been placed on the map. */
          const siteIsUnmapped =
            job.siteLatitude === null || job.siteLongitude === null;
          /**
           * L'itinéraire, calculé comme le fait le message WhatsApp : les
           * coordonnées du site d'abord, l'adresse en recherche ensuite. Un
           * lien qui ouvre une carte au hasard vaut moins que pas de lien.
           */
          const preciseLocation = job.interventionAddress?.trim() || job.address;
          const itineraryUrl =
            job.siteLatitude !== null && job.siteLongitude !== null
              ? `https://www.google.com/maps/dir/?api=1&destination=${job.siteLatitude},${job.siteLongitude}`
              : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                  `${preciseLocation}, ${job.building}`
                )}`;
          /**
           * A full bar is not the same as a clean inspection. The bar measures
           * how much has been *recorded*, so a checklist that is complete and
           * contains a FAIL would otherwise fill green and read as all-clear —
           * on the one screen where that message matters most. The fill takes
           * the colour of the worst result found.
           */
          const failures = checks.filter((c) => c === "FAIL").length;

          const recordedPhotos = photos[job.id] ?? {};
          const attached = Object.keys(recordedPhotos).length;
          const signature = signatures[job.id] ?? null;
          // The button opens the first item still missing evidence, so the
          // technician does not have to hunt for which row has a slot free.
          const nextUnphotographed = checklistFor(job).findIndex(
            (_, i) => !recordedPhotos[i]
          );
          const isCritical = job.priority === "CRITICAL" || job.priority === "EMERGENCY";
          /**
           * Le pointage est le seul seuil : `ASSIGNED` = carte condensée,
           * `IN_PROGRESS` = parcours guidé. Le serveur pose `IN_PROGRESS` au
           * check-in, donc l'écran et la base ne peuvent pas diverger.
           */
          const started = job.status === "IN_PROGRESS" || Boolean(job.arrivedAt);

          return (
            <div key={job.id} id={`job-${job.id}`} className="scroll-mt-6">
            <Card
              className={`overflow-hidden ${isCritical ? "!border-red-300 dark:!border-red-800 border-2" : ""}`}
            >
              {/* Job Header */}
              <div className={`${isCritical ? "bg-red-50 dark:bg-red-900/20" : "bg-gray-50 dark:bg-gray-800/50"} px-5 py-4 border-b border-gray-200 dark:border-gray-800`}>
                <div className="mb-2 flex items-center justify-end">
                  <span className={`px-2 py-0.5 text-[10px] font-bold rounded border ${PRIORITY_STYLES[job.priority] ?? PRIORITY_STYLES.MEDIUM}`}>
                    {enumLabel(job.priority)}
                  </span>
                </div>
                {/* 1. Immeuble et adresse, en tête de carte */}
                <h3 className="text-lg font-bold leading-tight text-gray-900 dark:text-white">
                  {job.building}
                </h3>
                {/*
                  Le lieu exact d'abord, l'adresse du site ensuite.

                  Le bon porte ce que le bureau a préparé — une cage, un
                  étage, une entrée — et c'est cette phrase que le technicien
                  doit lire en arrivant. L'adresse de l'immeuble reste sous
                  elle quand elle diffère, pour lever l'ambiguïté sur un site
                  à plusieurs accès.
                */}
                <div className="mt-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 dark:border-blue-900 dark:bg-blue-950/30">
                  <p className="flex items-start gap-1.5 text-sm font-semibold text-blue-950 dark:text-blue-100">
                    <MapPin
                      className="mt-0.5 h-4 w-4 flex-none"
                      aria-hidden="true"
                    />
                    <span>
                      {job.interventionAddress?.trim() || job.address}
                    </span>
                  </p>
                  {job.interventionAddress?.trim() &&
                    job.interventionAddress.trim() !== job.address && (
                      <p className="mt-0.5 pl-5 text-xs text-blue-800/80 dark:text-blue-200/80">
                        Site : {job.address}, {job.building}
                      </p>
                    )}
                </div>
                <p className="mt-1 flex items-center gap-1.5 text-xs text-gray-500">
                  <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
                  {job.elevator} · {job.title}
                </p>

                {/* 2. Code d'accès, mis en valeur : c'est ce qu'on cherche des
                    yeux en arrivant devant la porte. */}
                <div className="mt-3 flex items-center gap-2.5 rounded-xl bg-blue-600 px-4 py-3 text-white shadow-sm">
                  <KeyRound className="h-5 w-5 flex-none" aria-hidden="true" />
                  <span className="text-xs font-bold uppercase tracking-wide text-blue-100">
                    Code
                  </span>
                  <span className="font-mono text-2xl font-black tracking-[0.18em]">
                    {job.accessCode ?? "—"}
                  </span>
                </div>

                {/* 3. Créneau et estimation */}
                <p className="mt-3 flex items-center gap-1.5 text-xs text-gray-500">
                  <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                  {job.scheduledDate
                    ? `Planifié : ${new Date(job.scheduledDate).toLocaleString(
                        "fr-FR"
                      )}`
                    : "Non planifié"}
                  {job.estimatedHours != null &&
                    ` • Est. ${job.estimatedHours} h`}
                  {job.component && ` • ${job.component}`}
                </p>

                {job.description && (
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                    {job.description}
                  </p>
                )}
                {/* Itinéraire immédiatement accessible, avant même le
                    pointage : on le touche dans la voiture ou devant la porte. */}
                <a
                  href={itineraryUrl}
                  target="_blank"
                  rel="noopener"
                  className="mt-3 inline-flex items-center gap-2 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
                >
                  <MapPin className="h-4 w-4" aria-hidden="true" />
                  Itinéraire vers le site
                </a>

                {/*
                  Check-in replaces the old "Démarrer l'intervention" button
                  rather than sitting beside it. Two controls that both mean
                  "I am starting" is a worse interface than one that means it
                  precisely — and the precise one is the arrival, because that
                  is the fact the waiting customer is told about.
                */}
                {job.arrivedAt ? (
                  <p className="mt-3 inline-flex items-start gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                    <MapPin
                      className="mt-0.5 h-4 w-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span>
                      Arrivée pointée à{" "}
                      {new Date(job.arrivedAt).toLocaleTimeString("fr-FR", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      {job.checkInNotes && (
                        <span className="block font-normal">
                          {job.checkInNotes}
                        </span>
                      )}
                    </span>
                  </p>
                ) : (
                  <>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {/*
                        Disabled until the device sits inside the site's radius.

                        The server refuses the very same check-in, so this is a
                        courtesy and not the rule — but a button that looks
                        available and then fails is worse than one that explains
                        itself before the tap. It stays enabled when the site has
                        no coordinates: see `evaluateGeofence`.
                      */}
                      <button
                        type="button"
                        onClick={() => void checkIn(job.id)}
                        disabled={busyId === job.id || !verdict.allowed}
                        className="px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {busyId === job.id
                          ? "Pointage…"
                          : "📍 Pointer mon arrivée (GPS)"}
                      </button>
                      {/*
                        Le pointage manuel reste toujours offert.
                        Le GPS est une commodité, pas une condition d'accès au
                        chantier : un sous-sol, une permission refusée ou un
                        téléphone sans fix ne doivent pas empêcher de dire
                        « je suis arrivé ». Le serveur enregistre le fait sans
                        coordonnées et le signale comme non vérifié.
                      */}
                      <button
                        type="button"
                        onClick={() =>
                          void checkIn(job.id, { skipGps: true })
                        }
                        disabled={busyId === job.id}
                        className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                      >
                        Je suis sur place (sans GPS)
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setArrivalNoteFor(
                            arrivalNoteFor === job.id ? null : job.id
                          )
                        }
                        className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                      >
                        {arrivalNoteFor === job.id
                          ? "Masquer la note"
                          : "Ajouter une note"}
                      </button>
                    </div>

                    {/*
                      Says why the button above is greyed out, and by how much.
                      "Trop loin" without a number would leave the technician to
                      guess the direction; the site's own radius is quoted too,
                      because a site configured at 400 m behaves very
                      differently from one at 100 m.
                    */}
                    {/*
                      An unmapped site, and the one chance to map it.

                      A building with no coordinates is absent from the fleet
                      map entirely — no pin, no count, not even a greyed-out
                      placeholder — so nothing on any screen reveals that it is
                      missing. This is the only point in the system where
                      somebody is standing at the address, which makes it the
                      best position that building will ever get; an
                      administrator placing one from the office is reading a
                      map rather than looking at a door.

                      Ticked by default, because that is the whole purpose of
                      the control and an unticked default would mean the
                      feature never fires. It cannot overwrite a position
                      anybody has already set — the server only writes when the
                      building still has none — so the worst case is a pin an
                      administrator reviews and moves.
                    */}
                    {siteIsUnmapped && (
                      <label className="mt-2 flex items-start gap-2.5 rounded-lg border border-gray-200 p-2.5 dark:border-gray-700">
                        <input
                          type="checkbox"
                          checked={placeSiteOnCheckIn[job.id] !== false}
                          onChange={(event) =>
                            setPlaceSiteOnCheckIn((current) => ({
                              ...current,
                              [job.id]: event.target.checked,
                            }))
                          }
                          disabled={!position}
                          className="mt-0.5 h-4 w-4 flex-none rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-gray-800 dark:text-gray-200">
                            Placer ce chantier sur la carte
                          </span>
                          <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                            {position
                              ? `Ce chantier n'a pas encore de position. La vôtre (${position.latitude.toFixed(
                                  5
                                )}, ${position.longitude.toFixed(
                                  5
                                )}) sera enregistrée comme emplacement du site.`
                              : "Ce chantier n'a pas encore de position. Activez la localisation sur votre téléphone pour pouvoir le placer en pointant votre arrivée."}
                          </span>
                        </span>
                      </label>
                    )}

                    {/*
                      The télémètre.

                      Always on screen when both ends of the measurement are
                      known — not only when the technician is outside the
                      radius, which is what this used to be. A readout that
                      appears only on failure is silent for the whole of the
                      approach, which is exactly the minute someone wants to
                      know whether they are nearly there.

                      It re-renders on every position the watch reports, so it
                      counts down as the technician walks. The value comes from
                      `evaluateGeofence`, the same haversine the check-in
                      verdict uses, so the number on screen cannot disagree
                      with the number the server enforces.
                    */}
                    {verdict.distanceM !== null ? (
                      <div
                        className={`mt-2 rounded-lg px-3 py-2 text-sm ${
                          verdict.allowed
                            ? "bg-gray-50 text-gray-700 dark:bg-gray-800/60 dark:text-gray-300"
                            : "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                        }`}
                      >
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <Ruler
                            className="h-4 w-4 flex-none"
                            aria-hidden="true"
                          />
                          <span>
                            Distance au chantier :{" "}
                            <span className="font-semibold">
                              {formatDistance(verdict.distanceM)}
                            </span>
                            <span className="opacity-75">
                              {" "}
                              (rayon {formatDistance(verdict.radiusM)})
                            </span>
                          </span>
                        </p>
                        {!verdict.allowed && (
                          <p className="mt-1">
                            Rapprochez-vous du site pour pointer votre arrivée.
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                        {verdict.reason === "no-site-coordinates"
                          ? "📍 Localisation non partagée : ce site n'a pas encore de position. Vous pouvez pointer votre arrivée avec le bouton « Je suis sur place »."
                          : "📍 Localisation non partagée : votre position n'est pas connue. Vous pouvez pointer votre arrivée avec le bouton « Je suis sur place »."}
                      </p>
                    )}

                    {/*
                      Only shown when the position is genuinely unavailable.
                      Check-in still works in that case, so this is information
                      rather than a warning.
                    */}
                    {geoNotice && verdict.allowed && (
                      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                        {geoNotice}
                      </p>
                    )}

                    {arrivalNoteFor === job.id && (
                      <textarea
                        value={arrivalNotes[job.id] ?? ""}
                        onChange={(event) =>
                          setArrivalNotes((current) => ({
                            ...current,
                            [job.id]: event.target.value,
                          }))
                        }
                        rows={2}
                        maxLength={2000}
                        placeholder="Accès, personne qui a remis les clés, stationnement…"
                        aria-label="Note d'arrivée (facultative)"
                        className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                      />
                    )}
                  </>
                )}
              </div>

              {!started && (
                <div className="border-t border-gray-200 px-5 py-4 dark:border-gray-800">
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    La check-list, les photos, les pièces et la signature
                    s&apos;ouvrent après le pointage.
                  </p>
                  <p className="mt-1 text-xs text-gray-400">
                    Appuyez sur «&nbsp;Pointer / Démarrer l&apos;intervention&nbsp;»
                    ci-dessus.
                  </p>
                </div>
              )}

              {started && (
                <>
                  {/* Étape 1 — le pointage est déjà fait (statut IN_PROGRESS). */}
                  <div className="border-t border-gray-200 px-5 py-4 dark:border-gray-800">
                    <StepHeader
                      step={1}
                      title="Pointage & présence"
                      done
                      subtitle={
                        job.arrivedAt
                          ? `Arrivée pointée à ${new Date(
                              job.arrivedAt
                            ).toLocaleTimeString("fr-FR", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}`
                          : "Présence enregistrée"
                      }
                    />
                    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                      Réseau absent ou sous-sol : le pointage reste possible, la
                      position est simplement omise.
                    </p>
                  </div>

              {/* Checklist Progress */}
              <div
                id={`checklist-${job.id}`}
                className="scroll-mt-6 px-5 py-4"
              >
                <StepHeader
                  step={2}
                  title="Check-list de contrôle"
                  subtitle={`${done}/${checks.length} validés${
                    failures > 0 ? ` · ${failures} défaut(s)` : ""
                  }`}
                />
                {job.checklist.length > 0 && (
                  <p className="mt-3 text-xs text-blue-700 dark:text-blue-400">
                    Liste du programme d&apos;entretien de ce site.
                  </p>
                )}
                {job.inspection && (
                  <p className="mt-2 text-xs text-green-600 dark:text-green-400">
                    <Link
                      href={`/rapports-inspection/${job.inspection.id}`}
                      className="underline decoration-dotted underline-offset-2 hover:text-green-700"
                    >
                      Rapport enregistré ✓
                    </Link>
                  </p>
                )}

                <div className="mt-3 space-y-2">
                  {checklistFor(job).map((item, i) => {
                    const result = checks[i] ?? null;
                    const Icon = result ? RESULT_ICON[result] : Circle;
                    const photo = (photos[job.id] ?? {})[i];

                    return (
                      <div key={i} className="space-y-1.5">
                        <div
                          className={`flex items-center gap-2 rounded-lg border p-1 ${
                            result
                              ? RESULT_STYLE[result]
                              : "bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700"
                          }`}
                        >
                          {/* The whole row cycles the outcome: Pass → Fail →
                              N/A → unset. One control, no menu, usable with
                              gloves on. */}
                          <button
                            onClick={() => cycleCheck(job, i)}
                            aria-label={`${item} — ${
                              result
                                ? `actuellement ${enumLabel(result).toLowerCase()}`
                                : "pas encore renseigné"
                            }. Appuyez pour changer.`}
                            className="flex flex-1 items-center gap-3 rounded-md p-2 text-left hover:bg-black/5"
                          >
                            <Icon
                              className={`h-5 w-5 flex-shrink-0 ${
                                result ? RESULT_ICON_COLOR[result] : "text-gray-300"
                              }`}
                              aria-hidden="true"
                            />
                            <span
                              className={`flex-1 text-sm ${
                                result && result !== "NOT_APPLICABLE"
                                  ? "text-gray-800 dark:text-gray-200"
                                  : "text-gray-600 dark:text-gray-400"
                              }`}
                            >
                              {item}
                            </span>
                            {result && (
                              <span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                {enumLabel(result)}
                              </span>
                            )}
                          </button>

                          {/* Deux gestes directs : OK / Défaut. Le cycle à
                              quatre états reste sur la ligne du libellé. */}
                          <button
                            type="button"
                            onClick={() => setCheck(job, i, "PASS")}
                            aria-pressed={result === "PASS"}
                            aria-label={`Marquer OK : ${item}`}
                            className={`rounded-md px-2 py-1.5 text-xs font-bold transition-colors ${
                              result === "PASS"
                                ? "bg-green-600 text-white"
                                : "bg-green-50 text-green-700 hover:bg-green-100 dark:bg-green-950/40 dark:text-green-300"
                            }`}
                          >
                            OK
                          </button>
                          <button
                            type="button"
                            onClick={() => setCheck(job, i, "FAIL")}
                            aria-pressed={result === "FAIL"}
                            aria-label={`Marquer un défaut : ${item}`}
                            className={`rounded-md px-2 py-1.5 text-xs font-bold transition-colors ${
                              result === "FAIL"
                                ? "bg-red-600 text-white"
                                : "bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-300"
                            }`}
                          >
                            Défaut
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setPhotoPrompt(
                                photoPrompt?.jobId === job.id &&
                                  photoPrompt.index === i
                                  ? null
                                  : { jobId: job.id, index: i }
                              );
                              setPhotoDraft(photo ?? "");
                            }}
                            aria-label={
                              photo
                                ? `Photo jointe à ${item}. Appuyez pour modifier.`
                                : `Joindre une photo à ${item}`
                            }
                            title={photo ? "Photo jointe" : "Joindre une photo"}
                            className={`rounded-md p-2 hover:bg-black/5 ${
                              photo
                                ? "text-blue-600 dark:text-blue-400"
                                : "text-gray-400"
                            }`}
                          >
                            {photo ? (
                              <ExternalLink className="h-4 w-4" aria-hidden="true" />
                            ) : (
                              <Link2 className="h-4 w-4" aria-hidden="true" />
                            )}
                          </button>
                        </div>

                        {photoPrompt?.jobId === job.id &&
                          photoPrompt.index === i && (
                            <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                              <label
                                htmlFor={`photo-${job.id}-${i}`}
                                className="text-xs font-medium text-gray-600 dark:text-gray-400"
                              >
                                URL de la photo pour « {item} »
                              </label>
                              <div className="mt-1 flex gap-2">
                                <input
                                  id={`photo-${job.id}-${i}`}
                                  type="url"
                                  value={photoDraft}
                                  onChange={(e) => setPhotoDraft(e.target.value)}
                                  placeholder="https://…"
                                  className="flex-1 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2.5 py-1.5 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:focus:ring-blue-900"
                                />
                                <button
                                  type="button"
                                  onClick={() => savePhoto(job.id, i)}
                                  disabled={!photoDraft.trim()}
                                  className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                                >
                                  Joindre
                                </button>
                                {photo && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      clearPhoto(job.id, i);
                                      setPhotoPrompt(null);
                                    }}
                                    className="rounded-md px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                                  >
                                    Retirer
                                  </button>
                                )}
                              </div>
                              <p className="mt-1 text-[11px] text-gray-400">
                                Le téléversement n&apos;est pas configuré sur ce
                                déploiement — joignez une URL depuis votre
                                stockage de photos.
                              </p>
                            </div>
                          )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="border-t border-gray-200 px-5 pt-4 dark:border-gray-800">
                <StepHeader
                  step={3}
                  title="Photos & pièces"
                  subtitle="Preuves photo par point de contrôle, pièces posées et demandes de commande."
                />
              </div>

              {/* Parts Used */}
              {job.partsReplaced && job.partsReplaced.length > 0 && (
                <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-800">
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">
                    Pièces remplacées
                  </h4>
                  <div className="space-y-1.5">
                    {job.partsReplaced.map((part, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-800 rounded text-sm"
                      >
                        <div>
                          <span className="font-medium text-gray-900 dark:text-white">{part.name}</span>
                          {part.partNumber && (
                            <span className="text-gray-400 ml-2 font-mono text-xs">{part.partNumber}</span>
                          )}
                        </div>
                        <span className="text-gray-500">×{part.qty}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/*
                Les pièces à commander. Placées juste après celles qui ont été
                posées, et pour une raison de terrain : c'est au moment où le
                technicien écrit ce qu'il a monté qu'il sait ce qui lui manque.
                Les deux listes côte à côte disent la même chose à deux temps
                différents, et la seconde est celle qui déclenche une commande.

                Le technicien ne décide pas — il demande. Le panneau n'affiche
                donc jamais les boutons de validation ici, et la route les
                refuse de toute façon : `PATCH` demande les rôles de gestion.
              */}
              <PartRequirementsPanel
                workOrderId={job.id}
                canDecide={false}
                canRequest={job.status !== "CANCELLED"}
                embedded
              />

              <div
                id={`close-${job.id}`}
                className="scroll-mt-6 border-t border-gray-200 px-5 pt-4 dark:border-gray-800"
              >
                <StepHeader
                  step={4}
                  title="Dictée, signature & clôture"
                  subtitle="Dictez vos notes ou saisissez-les, faites signer, puis envoyez au bureau."
                />
              </div>

              {/* Notes editor */}
              {showNotes === job.id ? (
                <div className="px-5 py-4">
                  <div className="relative">
                    <textarea
                      value={notes[job.id] ?? ""}
                      onChange={(e) => setNotes({ ...notes, [job.id]: e.target.value })}
                      rows={3}
                      placeholder="Notes de terrain, constats, mesures…"
                      className="w-full px-3 py-2 pr-12 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <DictationButton
                      onText={(text) =>
                        setNotes((current) => ({
                          ...current,
                          [job.id]: `${current[job.id] ?? ""}${
                            current[job.id] ? " " : ""
                          }${text}`,
                        }))
                      }
                    />
                  </div>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => saveNotes(job.id)}
                      disabled={busyId === job.id}
                      className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
                    >
                      Enregistrer les notes
                    </button>
                    <button
                      onClick={() => setShowNotes(null)}
                      className="px-4 py-2 bg-gray-100 dark:bg-gray-800 text-sm font-medium rounded-lg text-gray-700 dark:text-gray-300"
                    >
                      Annuler
                    </button>
                  </div>
                </div>
              ) : null}

              {/* Signature capture. Rendered only for the job being signed, so
                  a page of ten assignments does not carry ten canvases. */}
              {signingJob === job.id && (
                <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-800">
                  <SignaturePad
                    label={`Signature du technicien — ${job.building}`}
                    onCancel={() => setSigningJob(null)}
                    onSave={(value) => {
                      setSignatures((prev) => ({ ...prev, [job.id]: value }));
                      setSigningJob(null);
                    }}
                  />
                </div>
              )}

              {/* Action Buttons */}
              <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-800 grid grid-cols-2 gap-3">
                <button
                  onClick={() => {
                    if (nextUnphotographed < 0) return;
                    setPhotoPrompt({ jobId: job.id, index: nextUnphotographed });
                    setPhotoDraft(recordedPhotos[nextUnphotographed] ?? "");
                    document
                      .getElementById(`photo-${job.id}-${nextUnphotographed}`)
                      ?.focus();
                  }}
                  disabled={nextUnphotographed < 0}
                  className="flex items-center justify-center gap-2 p-3 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 disabled:opacity-50 transition-colors"
                >
                  <Camera className="w-4 h-4" />
                  {attached > 0
                    ? `Preuves photo (${attached})`
                    : "Preuves photo"}
                </button>
                <button
                  onClick={() => setShowNotes(showNotes === job.id ? null : job.id)}
                  className="flex items-center justify-center gap-2 p-3 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 transition-colors"
                >
                  <FileText className="w-4 h-4" />
                  {notes[job.id] ? "Modifier les notes" : "Ajouter des notes"}
                </button>
                <button
                  onClick={() => setSigningJob(signingJob === job.id ? null : job.id)}
                  className={`flex items-center justify-center gap-2 p-3 rounded-lg text-sm font-medium transition-colors ${
                    signature
                      ? "bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300"
                      : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200"
                  }`}
                  title={signature ? `Signé par ${signature.name}` : undefined}
                >
                  <PenTool className="w-4 h-4" />
                  {signature
                    ? `Signé : ${signature.name}`
                    : "Signature numérique"}
                </button>
                <button
                  onClick={() => {
                    setReportError("");
                    setReportFor(job);
                  }}
                  className={`col-span-2 flex items-center justify-center gap-2 p-3 rounded-lg text-sm font-bold transition-colors ${
                    progress === 100
                      ? "bg-green-600 text-white hover:bg-green-700"
                      : "bg-gray-200 text-gray-400 cursor-not-allowed"
                  }`}
                  disabled={progress < 100 || busyId === job.id}
                >
                  <CheckCircle2 className="w-4 h-4" />
                  {busyId === job.id
                    ? "Enregistrement…"
                    : completionActionLabel(job.type)}
                </button>
              </div>
                </>
              )}
            </Card>
            </div>
          );
        })
      )}

      {/* Les autres affectations, en lecture seule tant que la mission active
          n'est pas clôturée. Repliées par défaut : elles ne doivent pas
          concurrencer visuellement le chantier en cours. */}
      {otherJobs.length > 0 && (
        <details className="rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-gray-900 dark:text-white">
            <span>Missions suivantes en attente ({otherJobs.length})</span>
            <span className="text-xs font-normal text-gray-400">
              Après clôture de la mission en cours
            </span>
          </summary>
          <ul className="divide-y divide-gray-100 border-t border-gray-100 dark:divide-gray-800 dark:border-gray-800">
            {otherJobs.map((job) => (
              <li
                key={job.id}
                className="flex items-start justify-between gap-3 px-4 py-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-mono text-xs text-gray-500">
                    {job.orderNumber}
                  </p>
                  <p className="truncate font-medium text-gray-900 dark:text-white">
                    {job.title}
                  </p>
                  <p className="truncate text-xs text-gray-500">
                    {job.building} —{" "}
                    {job.interventionAddress?.trim() || job.address}
                  </p>
                </div>
                <div className="flex flex-none flex-col items-end gap-1">
                  <span
                    className={`rounded border px-2 py-0.5 text-[10px] font-bold ${
                      PRIORITY_STYLES[job.priority] ?? PRIORITY_STYLES.MEDIUM
                    }`}
                  >
                    {enumLabel(job.priority)}
                  </span>
                  {job.scheduledDate && (
                    <span className="text-[11px] text-gray-400">
                      {new Date(job.scheduledDate).toLocaleDateString("fr-FR")}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/*
        Today's hand-overs, accepted and waiting together.

        A report leaves the technician's queue the moment he validates it — the
        job is off his hands and the office has it — so if this panel kept only
        the accepted ones, the order he just sent would vanish from the screen
        in the same second, with no confirmation that anything was saved. The
        badge is the confirmation.
      */}
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
          Aujourd&apos;hui
        </h3>
        {completed.length === 0 ? (
          <p className="text-sm text-gray-500">
            Aucune intervention terminée aujourd&apos;hui.
          </p>
        ) : (
          completed.map((job) => {
            const pending = job.status === "PENDING_APPROVAL";
            const stamp = job.completedAt ?? job.reportSubmittedAt;
            return (
              <div
                key={job.id}
                className={`flex items-center justify-between gap-3 p-3 rounded-lg border mb-2 ${
                  pending
                    ? "bg-amber-50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-800"
                    : "bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800"
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  {pending ? (
                    <Clock className="w-5 h-5 shrink-0 text-amber-500" />
                  ) : (
                    <CheckCircle2 className="w-5 h-5 shrink-0 text-green-500" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                      {job.title}
                    </p>
                    <p className="text-xs text-gray-500 font-mono">
                      {job.elevator}
                    </p>
                    {pending && (
                      <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300 mt-0.5">
                        Envoyé au bureau — en attente de validation
                      </p>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs text-gray-500 tabular-nums">
                    {stamp ? new Date(stamp).toLocaleTimeString("fr-FR") : "—"}
                  </p>
                  <p className="text-xs text-gray-400">
                    {job.actualHours ?? "—"} h
                  </p>
                </div>
              </div>
            );
          })
        )}
      </Card>

      {reportFor && (
        <CompletionReportForm
          job={{
            orderNumber: reportFor.orderNumber,
            type: reportFor.type,
            elevator: reportFor.elevator,
            building: reportFor.building,
          }}
          initialDescription={
            notes[reportFor.id] ?? reportFor.notes ?? ""
          }
          initialParts={reportFor.partsReplaced}
          initialIsBillable={reportFor.isBillable}
          initialAmount={reportFor.invoiceAmount}
          busy={busyId === reportFor.id}
          serverError={reportError}
          onCancel={() => {
            setReportFor(null);
            setReportError("");
          }}
          onSubmit={(report) => submitCompletionReport(reportFor, report)}
        />
      )}

      <IncidentDialog
        open={incidentOpen}
        onClose={() => setIncidentOpen(false)}
        onCreated={() => void load()}
      />

      {messagesJob && (
        <MessagesDialog
          workOrderId={messagesJob.id}
          onClose={() => setMessagesJob(null)}
        />
      )}

      {/* Barre d'action fixe — téléphone uniquement. Le geste contextuel de
          l'intervention courante reste sous le pouce, sans remonter la page. */}
      {stickyJob && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-4px_20px_rgba(0,0,0,0.08)] backdrop-blur dark:border-gray-800 dark:bg-gray-950/95 md:hidden">
          <button
            type="button"
            onClick={() => {
              if (!stickyStarted) {
                document
                  .getElementById(`job-${stickyJob.id}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
                return;
              }
              if (stickyProgress >= 1) {
                setReportError("");
                setReportFor(stickyJob);
                return;
              }
              // « Étape suivante » mène à l'étape réellement incomplète : la
              // check-list d'abord, puis la clôture.
              document
                .getElementById(`checklist-${stickyJob.id}`)
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            className={`mx-auto flex w-full max-w-2xl items-center justify-center gap-2 rounded-xl px-4 py-3 text-base font-bold text-white transition-colors ${
              stickyStarted && stickyProgress >= 1
                ? "bg-green-600 hover:bg-green-700"
                : "bg-blue-600 hover:bg-blue-700"
            }`}
          >
            {stickyStarted && stickyProgress >= 1 ? (
              <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
            ) : (
              <ArrowRight className="h-5 w-5" aria-hidden="true" />
            )}
            {stickyLabel}
          </button>
        </div>
      )}
    </div>
  );
}
