"use client";

import { useCallback, useEffect, useState } from "react";
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
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { SignaturePad } from "@/components/technician/signature-pad";
import type { SignatureValue } from "@/components/technician/signature-pad";
import { enumLabel } from "@/lib/ui/enum-labels";
import { evaluateGeofence, formatDistance } from "@/lib/geo/geofence";
import type { Coordinates } from "@/lib/geo/geofence";

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
  photoUrls: string[];
  elevator: string;
  building: string;
  address: string;
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
  completedAt: string | null;
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

const PRIORITY_STYLES: Record<string, string> = {
  CRITICAL: "bg-red-100 text-red-800 border-red-300",
  EMERGENCY: "bg-red-100 text-red-800 border-red-300",
  HIGH: "bg-orange-100 text-orange-800 border-orange-300",
  MEDIUM: "bg-blue-100 text-blue-800 border-blue-300",
  LOW: "bg-gray-100 text-gray-600 border-gray-300",
};

export default function TechnicianPage() {
  const [techName, setTechName] = useState("Technicien de terrain");
  const [jobs, setJobs] = useState<ActiveJob[]>([]);
  const [completed, setCompleted] = useState<CompletedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [checklist, setChecklist] = useState<Record<string, CheckState[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
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
            if (!next[j.id]) next[j.id] = DEFAULT_CHECKLIST.map(() => null);
            continue;
          }
          const byName = new Map(saved.map((c) => [c.checkName, c.result]));
          next[j.id] = DEFAULT_CHECKLIST.map((name) => byName.get(name) ?? null);
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
          DEFAULT_CHECKLIST.forEach((name, index) => {
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

  const cycleCheck = (jobId: string, index: number) => {
    setChecklist((prev) => {
      const arr = [...(prev[jobId] ?? DEFAULT_CHECKLIST.map(() => null))];
      const current = arr[index] ?? null;
      const position = RESULT_CYCLE.indexOf(current);
      arr[index] = RESULT_CYCLE[(position + 1) % RESULT_CYCLE.length];
      return { ...prev, [jobId]: arr };
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
  const checkIn = async (jobId: string) => {
    setBusyId(jobId);
    setError("");
    try {
      const notes = (arrivalNotes[jobId] ?? "").trim();

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
          ...(position
            ? { latitude: position.latitude, longitude: position.longitude }
            : {}),
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
   * File the inspection report, then close the work order.
   *
   * The order matters: if the report fails to save we must not mark the job
   * complete, otherwise the checklist that gated completion is lost and the
   * work order closes with no evidence of what was inspected.
   *
   * Every line must carry a result before the job closes — but "result" now
   * includes FAIL and N/A. A job that found a fault is a completed inspection,
   * and blocking it would push the technician to tick boxes that are not true.
   */
  const completeJob = async (job: ActiveJob) => {
    const checks = checklist[job.id] ?? DEFAULT_CHECKLIST.map(() => null);
    if (checks.some((c) => c === null)) {
      setError(
        "Renseignez un résultat pour chaque point de contrôle avant de clôturer l'intervention."
      );
      return;
    }

    setBusyId(job.id);
    setError("");
    try {
      if (!job.inspection) {
        const jobPhotos = photos[job.id] ?? {};
        const signature = signatures[job.id] ?? null;

        const res = await fetch("/api/inspection-reports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workOrderId: job.id,
            summary: notes[job.id]?.trim() || undefined,
            items: DEFAULT_CHECKLIST.map((checkName, index) => ({
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
        body: JSON.stringify({ status: "COMPLETED" }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(
          json.error ?? "Échec de la clôture du bon de travail"
        );
      }

      await load();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Échec de la clôture de l'intervention"
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

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">
          Espace technicien
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          {techName} — Technicien de terrain
        </p>
      </div>

      {/* Status Banner */}
      <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-4 flex items-center gap-3">
        <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse" />
        <div>
          <p className="text-sm font-medium text-green-800 dark:text-green-300">
            En service — {jobs.length}{" "}
            {jobs.length > 1 ? "affectations actives" : "affectation active"}
          </p>
          <p className="text-xs text-green-600 dark:text-green-400">
            Dernière synchro : {new Date().toLocaleTimeString("fr-FR")}
          </p>
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">
          {error}
        </p>
      )}

      {/* Active Assignments */}
      {jobs.length === 0 ? (
        <EmptyState
          title="Aucune affectation active"
          hint="Les nouvelles affectations du tableau des bons de travail apparaîtront ici."
        />
      ) : (
        jobs.map((job) => {
          // `null` means "not yet recorded" and is not the same as a recorded
          // NOT_APPLICABLE — an item nobody assessed must not count towards
          // completion, and must not be silently filed as a Pass either.
          const checks = checklist[job.id] ?? DEFAULT_CHECKLIST.map(() => null);
          const done = checks.filter((c) => c !== null).length;
          const progress = checks.length > 0 ? (done / checks.length) * 100 : 0;

          // Computed once per row, so the button's enabled state and the
          // explanation beneath it can never disagree with each other.
          const verdict = verdictFor(job);
          /**
           * A full bar is not the same as a clean inspection. The bar measures
           * how much has been *recorded*, so a checklist that is complete and
           * contains a FAIL would otherwise fill green and read as all-clear —
           * on the one screen where that message matters most. The fill takes
           * the colour of the worst result found.
           */
          const failures = checks.filter((c) => c === "FAIL").length;
          const attention = checks.filter((c) => c === "NEEDS_ATTENTION").length;
          const progressFill =
            failures > 0
              ? "bg-red-500"
              : attention > 0
                ? "bg-amber-500"
                : "bg-green-500";

          const recordedPhotos = photos[job.id] ?? {};
          const attached = Object.keys(recordedPhotos).length;
          const signature = signatures[job.id] ?? null;
          // The button opens the first item still missing evidence, so the
          // technician does not have to hunt for which row has a slot free.
          const nextUnphotographed = DEFAULT_CHECKLIST.findIndex(
            (_, i) => !recordedPhotos[i]
          );
          const isCritical = job.priority === "CRITICAL" || job.priority === "EMERGENCY";

          return (
            <Card
              key={job.id}
              className={`overflow-hidden ${isCritical ? "!border-red-300 dark:!border-red-800 border-2" : ""}`}
            >
              {/* Job Header */}
              <div className={`${isCritical ? "bg-red-50 dark:bg-red-900/20" : "bg-gray-50 dark:bg-gray-800/50"} px-5 py-4 border-b border-gray-200 dark:border-gray-800`}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-mono text-gray-500">{job.orderNumber}</span>
                  <span className={`px-2 py-0.5 text-[10px] font-bold rounded border ${PRIORITY_STYLES[job.priority] ?? PRIORITY_STYLES.MEDIUM}`}>
                    {enumLabel(job.priority)}
                  </span>
                </div>
                <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                  {job.title}
                </h3>
                {job.description && (
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{job.description}</p>
                )}
                <div className="mt-2 space-y-1">
                  <p className="text-sm text-gray-600 dark:text-gray-400 flex items-center gap-1.5">
                    <Wrench className="w-3.5 h-3.5" />
                    {job.elevator} — {job.building}
                  </p>
                  <p className="text-sm text-gray-500 flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5" />
                    {job.address}
                  </p>
                  <p className="text-sm text-gray-500 flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5" />
                    {job.scheduledDate
                      ? `Planifié : ${new Date(job.scheduledDate).toLocaleString(
                          "fr-FR"
                        )}`
                      : "Non planifié"}
                    {job.estimatedHours != null &&
                      ` • Est. ${job.estimatedHours} h`}
                    {job.component && ` • ${job.component}`}
                  </p>
                </div>
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
                          : "📍 J'ai pointé mon arrivée"}
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
                    {!verdict.allowed && (
                      <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                        Vous êtes à {formatDistance(verdict.distanceM)} du
                        chantier — au-delà du rayon de{" "}
                        {formatDistance(verdict.radiusM)}. Rapprochez-vous du
                        site pour pointer votre arrivée.
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

              {/* Checklist Progress */}
              <div className="px-5 py-4">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
                    Points de contrôle
                  </h4>
                  <span className="text-xs font-medium text-gray-500">
                    {done}/{checks.length} renseignés
                    {failures > 0 && (
                      <span className="ml-1.5 font-semibold text-red-600 dark:text-red-400">
                        · {failures} en échec
                      </span>
                    )}
                  </span>
                </div>
                {job.inspection && (
                  <p className="text-xs text-green-600 dark:text-green-400 mb-2 font-mono">
                    Enregistré sous{" "}
                    <Link
                      href={`/rapports-inspection/${job.inspection.id}`}
                      className="underline decoration-dotted underline-offset-2 hover:text-green-700"
                    >
                      {job.inspection.reportNumber}
                    </Link>
                  </p>
                )}
                <div className="h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden mb-4">
                  <div
                    className={`h-full ${progressFill} rounded-full transition-all duration-500`}
                    style={{ width: `${progress}%` }}
                  />
                </div>

                <div className="space-y-2">
                  {DEFAULT_CHECKLIST.map((item, i) => {
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
                            onClick={() => cycleCheck(job.id, i)}
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

              {/* Notes editor */}
              {showNotes === job.id ? (
                <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-800">
                  <textarea
                    value={notes[job.id] ?? ""}
                    onChange={(e) => setNotes({ ...notes, [job.id]: e.target.value })}
                    rows={3}
                    placeholder="Notes de terrain, constats, mesures…"
                    className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
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
                    label={`Signature du technicien — ${job.orderNumber}`}
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
                  onClick={() => completeJob(job)}
                  className={`flex items-center justify-center gap-2 p-3 rounded-lg text-sm font-bold transition-colors ${
                    progress === 100
                      ? "bg-green-600 text-white hover:bg-green-700"
                      : "bg-gray-200 text-gray-400 cursor-not-allowed"
                  }`}
                  disabled={progress < 100 || busyId === job.id}
                >
                  <CheckCircle2 className="w-4 h-4" />
                  {busyId === job.id
                    ? "Enregistrement…"
                    : "Clôturer l'intervention"}
                </button>
              </div>
            </Card>
          );
        })
      )}

      {/* Completed Today */}
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
          Terminées aujourd&apos;hui
        </h3>
        {completed.length === 0 ? (
          <p className="text-sm text-gray-500">
            Aucune intervention terminée aujourd&apos;hui.
          </p>
        ) : (
          completed.map((job) => (
            <div
              key={job.id}
              className="flex items-center justify-between p-3 bg-green-50 dark:bg-green-900/10 rounded-lg border border-green-200 dark:border-green-800 mb-2"
            >
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-5 h-5 text-green-500" />
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{job.title}</p>
                  <p className="text-xs text-gray-500 font-mono">{job.elevator}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-500">
                  {job.completedAt
                    ? new Date(job.completedAt).toLocaleTimeString("fr-FR")
                    : "—"}
                </p>
                <p className="text-xs text-gray-400">
                  {job.actualHours ?? "—"} h
                </p>
              </div>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
