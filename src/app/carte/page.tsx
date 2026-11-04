"use client";

/**
 * The fleet map.
 *
 * WHAT THIS SCREEN IS FOR
 * One question: where in the fleet is something wrong, and what is it. Every
 * other screen answers a version of that for a list of rows; this one answers
 * it for a place, which is the shape the answer actually has when you have to
 * send somebody somewhere.
 *
 * WHAT IS NOT HERE
 * The fetching, the poll and the level filter. All three are shared with the
 * dashboard panel and the technician's card and live in `useFleetMap` /
 * `filterSites`, so the three surfaces cannot drift apart on what "Panne" means
 * or on how stale the picture is allowed to get. What is left in this file is
 * the part that is genuinely this screen's own: a full-height workspace with the
 * map on the left and the detail beside it, and the placement flow, which no
 * other surface offers.
 *
 * PLACING A SITE
 * A site with no coordinates appears in no map, in no count and in no cluster —
 * it is simply absent, which is the one failure mode that leaves no trace on
 * screen. So the sites that cannot be drawn are listed above the map, and each
 * one can be placed by clicking its position. The same control repositions a
 * site that was placed roughly the first time.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  AlertTriangle,
  Check,
  MapPinOff,
  Navigation,
  RefreshCw,
  Undo2,
  X,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import { FleetMap } from "@/components/map/fleet-map";
import { AttentionLegend } from "@/components/map/attention-legend";
import { SiteDetailPanel } from "@/components/map/site-detail-panel";
import { DispatchModal } from "@/components/admin/dispatch-modal";
import { Card } from "@/components/ui/card";
import { ErrorState, LoadingSkeleton } from "@/components/ui/states";
import { filterSites, useFleetMap } from "@/lib/map/use-fleet-map";
import { ATTENTION_STYLES } from "@/lib/map/attention";
import { googleMapsDirectionsUrl } from "@/lib/map/directions";
import { SectionTabs, PARC_TABS } from "@/components/layout/section-tabs";
import type { AttentionFilter, FleetMapSite } from "@/lib/map/types";
import type { Coordinates } from "@/lib/geo/geofence";
import { cn } from "@/lib/utils";

/** What is being placed, and where it currently sits. */
interface PlacementTarget {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
}

export default function CartePage() {
  const { data: session } = useSession();
  const canDispatch =
    session?.user?.role === "ADMIN" ||
    session?.user?.role === "MAINTENANCE_MANAGER";

  const { payload, sites, faults, technicians, loading, error, refreshedAt, reload } =
    useFleetMap();

  const [filter, setFilter] = useState<AttentionFilter>("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * La panne ouverte dans la fiche rouge, et le technicien à lui affecter.
   *
   * Une notification de panne désigne un incident ; la carte l'ouvre dans une
   * carte de détail rouge au-dessus de l'épingle, avec le bouton d'assignation
   * rapide. Le même dialogue que la cloche est réutilisé pour ne pas offrir
   * deux listes de techniciens qui finiraient par diverger.
   */
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(
    null
  );
  const [dispatchTarget, setDispatchTarget] = useState<{
    id: string;
    incidentNumber: string;
    elevatorCode: string;
  } | null>(null);
  /**
   * L'appareil et le point désignés par une notification de panne.
   *
   * La notification d'incident n'envoie pas seulement un immeuble : elle
   * désigne l'ascenseur concerné et, quand le signalement portait une
   * position, l'endroit exact où la panne a été relevée. Le panneau du site
   * remonte la ligne de cet appareil ; la carte vole vers l'épingle de panne.
   */
  const [focusElevatorId, setFocusElevatorId] = useState<string | null>(null);
  const [focusPoint, setFocusPoint] = useState<Coordinates | null>(null);
  /**
   * La requête d'ouverture ne s'applique qu'une fois par adresse.
   *
   * `payload` est rafraîchi toutes les minutes ; rejouer le paramètre à chaque
   * poll rouvrirait le panneau que l'utilisateur vient de fermer et ramènerait
   * la carte sur l'épingle au moment où il lit ailleurs. La clé est la chaîne
   * de requête, pas un simple booléen : une seconde notification poussée vers
   * la même page doit, elle, déplacer la carte.
   */
  const openedFromQueryRef = useRef<string | null>(null);

  const [placingFor, setPlacingFor] = useState<PlacementTarget | null>(null);
  const [draft, setDraft] = useState<Coordinates | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(
    null
  );

  const visibleSites = useMemo<FleetMapSite[]>(
    () => filterSites(sites, filter),
    [sites, filter]
  );

  /**
   * Les pannes suivent le même filtre que les sites.
   *
   * La couche `faults` est indépendante de la couche `sites` : sans ce tri, un
   * filtre « Panne » masquait les immeubles sans panne mais laissait leurs
   * épingles de panne à l'écran — la carte montrait alors des points rouges
   * sans site, et le filtre semblait à moitié appliqué. Une panne ne reste
   * affichée que si son immeuble est encore visible.
   */
  const visibleFaults = useMemo(() => {
    if (filter === "ALL") return faults;

    // Une épingle de panne n'a de sens que sous le filtre « Panne ». La
    // laisser sous « Entretien » ou « À suivre » ferait réapparaître le
    // marqueur qu'on vient de demander à masquer.
    if (filter !== "PANNE") return [];

    const visibleSiteIds = new Set(visibleSites.map((site) => site.id));
    return faults.filter((fault) => visibleSiteIds.has(fault.buildingId));
  }, [faults, visibleSites, filter]);

  /**
   * Taken from the *unfiltered* list, not from `visibleSites`.
   *
   * Under an active filter the pins are levelled to one colour and their badges
   * count only the matching units, which is the right reading for a spread of
   * pins and the wrong one for a single site: the panel is that site's record,
   * and a header repainted to match the filter — or a count of two where there
   * are six units — would be the panel agreeing with a lens rather than with the
   * fleet. The panel always tells the truth about the site; the map tells the
   * truth about the filter.
   */
  const selectedSite = useMemo(
    () => sites.find((s) => s.id === selectedId) ?? null,
    [sites, selectedId]
  );

  const selectedFault = useMemo(
    () =>
      payload?.faults.find((fault) => fault.incidentId === selectedIncidentId) ??
      null,
    [payload, selectedIncidentId]
  );

  // Selecting a site, then filtering it out of view, must not leave the panel
  // describing something that is no longer on the map.
  useEffect(() => {
    if (selectedId && !visibleSites.some((s) => s.id === selectedId)) {
      setSelectedId(null);
    }
  }, [visibleSites, selectedId]);

  /**
   * L'épingle désignée par l'URL.
   *
   * Trois paramètres, et ils viennent de deux écrans différents :
   *  - `?site=` est envoyé par le tableau de bord (« Voir sur la carte ») ;
   *  - `?site=&elevator=&incident=` est envoyé par la notification de panne,
   *    pour désigner la machine et le point exact du signalement.
   *
   * Le paramètre est lu après le chargement du payload : appliqué avant, la
   * garde ci-dessus l'effacerait au premier rendu vide. Il n'est appliqué
   * qu'une fois — voir `openedFromQueryRef`.
   */
  useEffect(() => {
    if (!payload) return;

    try {
      const search = window.location.search;
      if (openedFromQueryRef.current === search) return;
      openedFromQueryRef.current = search;

      const params = new URLSearchParams(search);
      const siteParam = params.get("site");
      const elevatorParam = params.get("elevator");
      const incidentParam = params.get("incident");
      /**
       * Le point de centrage explicite.
       *
       * La notification envoie aussi `workOrderId` et les coordonnées de
       * l'immeuble. Les paramètres `site`/`elevator`/`incident` suffisent à
       * sélectionner l'épingle ; `lat`/`lng` garantissent un centrage même
       * quand le site n'est pas encore dans la couche cartographiée.
       */
      const latParam = params.get("lat");
      const lngParam = params.get("lng");
      const requestedLatitude = latParam === null ? NaN : Number(latParam);
      const requestedLongitude = lngParam === null ? NaN : Number(lngParam);
      const requestedPoint =
        Number.isFinite(requestedLatitude) &&
        Number.isFinite(requestedLongitude)
          ? {
              latitude: requestedLatitude,
              longitude: requestedLongitude,
            }
          : null;

      const siteFromElevator = elevatorParam
        ? payload.sites.find((site) =>
            site.elevators.some((unit) => unit.id === elevatorParam)
          ) ?? null
        : null;
      const requestedSite =
        siteFromElevator ??
        (siteParam
          ? payload.sites.find((site) => site.id === siteParam) ?? null
          : null);

      /**
       * La panne la plus précise que l'URL permet de retrouver.
       *
       * Une position relevée par le téléphone du signalant vaut mieux que le
       * centre de l'immeuble : c'est là que quelqu'un a constaté le problème.
       * À défaut, on retombe sur les coordonnées du site.
       */
      const fault = incidentParam
        ? payload.faults.find((f) => f.incidentId === incidentParam) ?? null
        : elevatorParam
          ? payload.faults.find((f) => f.elevatorId === elevatorParam) ?? null
          : null;
      const focusedUnit = elevatorParam ?? fault?.elevatorId ?? null;

      if (requestedSite) {
        // Une notification doit montrer son site, quel que soit le filtre
        // laissé par une visite précédente : sinon la garde ci-dessus
        // refermerait aussitôt le panneau qu'on vient d'ouvrir.
        setFilter("ALL");
        setSelectedId(requestedSite.id);
        setFocusElevatorId(focusedUnit);
        setSelectedIncidentId(fault?.incidentId ?? null);
        // Un lien « Voir sur la carte » ne porte qu'un site : le centrage est
        // déjà fait par la sélection, et un second `flyTo` vers le même point
        // ne ferait que rejouer l'animation. C'est la notification de panne,
        // qui désigne un appareil ou un signalement, qui a besoin du point.
        if (elevatorParam || incidentParam || requestedPoint) {
          setFocusPoint(
            fault
              ? { latitude: fault.latitude, longitude: fault.longitude }
              : requestedPoint ?? {
                  latitude: requestedSite.latitude,
                  longitude: requestedSite.longitude,
                }
          );
        } else {
          setFocusPoint(null);
        }
        return;
      }

      /**
       * Une panne peut avoir une position relevée alors que son immeuble n'a
       * pas encore de coordonnées. La carte peut la dessiner, même sans site :
       * on ouvre donc sa fiche rouge et on vole vers le point du signalement.
       */
      if (fault) {
        setFocusPoint({ latitude: fault.latitude, longitude: fault.longitude });
        setFocusElevatorId(fault.elevatorId);
        setSelectedIncidentId(fault.incidentId);
        return;
      }

      /**
       * Le site existe mais n'a pas de coordonnées, ou l'appareil n'est dans
       * aucun site cartographié. Le dire vaut mieux que d'ouvrir la carte sur
       * Alger et laisser croire que la panne est là.
       */
      /**
       * Aucun site ni aucune panne retrouvés, mais l'URL porte un point : on
       * centre dessus. C'est le cas d'un immeuble qui n'a pas encore été placé
       * dans la couche cartographiée, ou d'un lien qui ne connaît que les
       * coordonnées.
       */
      if (requestedPoint) {
        setFocusPoint(requestedPoint);
        return;
      }

      const unlocated = siteParam
        ? payload.unlocated.find((site) => site.id === siteParam)
        : null;
      if (elevatorParam || siteParam) {
        setNotice({
          tone: "error",
          text: unlocated
            ? `Le site « ${unlocated.name} » n'a pas encore de position sur la carte. Placez-le pour voir l'appareil signalé.`
            : "L'appareil signalé n'est rattaché à aucun site cartographié. Vérifiez la position de son immeuble.",
        });
      }
    } catch {
      // Sans paramètre, la carte s'ouvre sur le parc entier.
    }
  }, [payload]);

  const handleMapClick = useCallback(
    (position: Coordinates) => {
      if (!placingFor) return;
      setDraft(position);
      setNotice(null);
    },
    [placingFor]
  );

  const startPlacing = useCallback((target: PlacementTarget) => {
    setPlacingFor(target);
    setDraft(null);
    setNotice(null);
    setSelectedId(null);
  }, []);

  const cancelPlacing = useCallback(() => {
    setPlacingFor(null);
    setDraft(null);
  }, []);

  const savePlacement = useCallback(async () => {
    if (!placingFor || !draft) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/buildings/${placingFor.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latitude: draft.latitude,
          longitude: draft.longitude,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          body?.error ?? `L'enregistrement a échoué (${res.status})`
        );
      }

      setNotice({
        tone: "ok",
        text: `Position enregistrée pour ${placingFor.name}.`,
      });
      setPlacingFor(null);
      setDraft(null);
      await reload({ silent: true });
    } catch (e) {
      setNotice({
        tone: "error",
        text:
          e instanceof Error ? e.message : "Échec de l'enregistrement de la position",
      });
    } finally {
      setSaving(false);
    }
  }, [placingFor, draft, reload]);

  // ── Loading and failure ───────────────────────────────────

  if (loading && !payload) {
    return (
      <div className="space-y-4">
        <LoadingSkeleton rows={2} />
        <div className="h-[520px] animate-pulse rounded-xl bg-gray-100 dark:bg-gray-800" />
      </div>
    );
  }

  if (error && !payload) {
    return <ErrorState message={error} onRetry={() => void reload()} />;
  }

  if (!payload) {
    return (
      <ErrorState message="Aucune donnée de carte" onRetry={() => void reload()} />
    );
  }

  const { totals, unlocated } = payload;
  const needsPlacing = unlocated.filter((s) => s.reason === "no-coordinates");

  return (
    <div className="flex h-full min-h-[600px] flex-col gap-4">
      <SectionTabs tabs={PARC_TABS} ariaLabel="Parc ascenseurs" />

      {/* ── Toolbar ────────────────────────────────────────── */}
      <Card className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <AttentionLegend
            counts={totals.byLevel}
            active={filter}
            onChange={setFilter}
            hideEmpty
          />
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Les nombres comptent les ascenseurs, non les sites.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {totals.sitesLocated} site{totals.sitesLocated > 1 ? "s" : ""} sur{" "}
            {totals.sites} cartographié
            {totals.sitesLocated > 1 ? "s" : ""}
          </span>
          <span className="hidden text-xs text-gray-400 sm:inline">
            {refreshedAt
              ? `actualisé ${formatDistanceToNow(refreshedAt, {
                  addSuffix: true,
                  locale: fr,
                })}`
              : ""}
          </span>
          <button
            type="button"
            onClick={() => void reload({ silent: true })}
            className="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            aria-label="Actualiser la carte"
            title="Actualiser"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </button>
        </div>
      </Card>

      {/* ── Outcome of the last save ───────────────────────── */}
      {notice && (
        <div
          role="status"
          className={cn(
            "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
            notice.tone === "ok"
              ? "border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300"
              : "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          )}
        >
          {notice.tone === "ok" ? (
            <Check className="h-4 w-4 flex-none" />
          ) : (
            <AlertTriangle className="h-4 w-4 flex-none" />
          )}
          <span className="flex-1">{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="rounded p-0.5 hover:bg-black/5"
            aria-label="Masquer le message"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── Sites the map cannot show ──────────────────────── */}
      {needsPlacing.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/30">
          <div className="flex items-start gap-2">
            <MapPinOff className="mt-0.5 h-4 w-4 flex-none text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                {needsPlacing.length} site
                {needsPlacing.length > 1 ? "s" : ""} sans position —{" "}
                {totals.elevatorsUnlocated} ascenseur
                {totals.elevatorsUnlocated > 1 ? "s" : ""} invisible
                {totals.elevatorsUnlocated > 1 ? "s" : ""} sur la carte
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {needsPlacing.map((site) => (
                  <li key={site.id}>
                    <button
                      type="button"
                      onClick={() =>
                        startPlacing({
                          id: site.id,
                          name: site.name,
                          latitude: null,
                          longitude: null,
                        })
                      }
                      className="rounded-full border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 dark:border-amber-800 dark:bg-gray-900 dark:text-amber-200 dark:hover:bg-amber-950"
                    >
                      Placer « {site.name} »
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      )}

      {/* ── Placement mode ─────────────────────────────────── */}
      {placingFor && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm dark:border-blue-900 dark:bg-blue-950/40">
          <span className="font-medium text-blue-900 dark:text-blue-200">
            {draft
              ? `Position choisie : ${draft.latitude.toFixed(5)}, ${draft.longitude.toFixed(5)}`
              : "Cliquez sur la carte à l'emplacement exact du chantier."}
          </span>
          <span className="text-blue-700 dark:text-blue-300">
            {placingFor.name}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={cancelPlacing}
              className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <Undo2 className="h-3.5 w-3.5" />
              Annuler
            </button>
            <button
              type="button"
              onClick={() => void savePlacement()}
              disabled={!draft || saving}
              className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" />
              {saving ? "Enregistrement…" : "Enregistrer la position"}
            </button>
          </div>
        </div>
      )}

      {/* ── Map and detail ─────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <div
          className={cn(
            "relative min-h-[320px] flex-1 overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800 lg:min-h-0",
            placingFor && "ep-map-placing"
          )}
        >
          <FleetMap
            sites={visibleSites}
            faults={visibleFaults}
            technicians={technicians}
            selectedId={selectedId}
            focusPoint={focusPoint}
            onSelect={(id) => {
              setSelectedIncidentId(null);
              setSelectedId((current) => (current === id ? null : id));
            }}
            onFaultSelect={(incidentId) => {
              setSelectedIncidentId(incidentId);
              setDispatchTarget(null);
            }}
            onMapClick={handleMapClick}
            draftPosition={draft}
            showGeofence={selectedId !== null}
            // The map fills the screen here, so there is nothing below it for
            // the wheel to scroll to and swallowing it costs the reader nothing.
            scrollWheelZoom
          />

          {selectedFault && (
            <div className="absolute left-3 top-3 z-[1200] w-[min(390px,calc(100%-1.5rem))] rounded-xl border-2 border-red-500 bg-red-50/95 p-4 shadow-xl backdrop-blur-sm dark:border-red-700 dark:bg-red-950/90">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-extrabold uppercase tracking-wide text-red-700 dark:text-red-300">
                    🚨 Panne signalée
                  </p>
                  <p className="mt-0.5 truncate font-mono text-sm font-bold text-red-950 dark:text-red-100">
                    {selectedFault.incidentNumber} · {selectedFault.elevatorCode}
                  </p>
                  <p className="truncate text-sm font-semibold text-red-900 dark:text-red-200">
                    {selectedFault.buildingName}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedIncidentId(null)}
                  aria-label="Fermer la fiche de panne"
                  className="rounded-md p-1 text-red-700 hover:bg-red-100 dark:text-red-300 dark:hover:bg-red-900/40"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {selectedFault.notes && (
                <p className="mt-2 line-clamp-3 text-xs text-red-900/90 dark:text-red-200/90">
                  {selectedFault.notes}
                </p>
              )}
              {selectedFault.errorCode && (
                <p className="mt-1 text-xs font-medium text-red-800 dark:text-red-300">
                  Code : {selectedFault.errorCode.code} —{" "}
                  {selectedFault.errorCode.title}
                </p>
              )}

              <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-red-800/80 dark:text-red-300/80">
                <span>
                  {selectedFault.isDirectTransfer ? "Urgence" : "Signalée"}{" "}
                  {formatDistanceToNow(new Date(selectedFault.reportedAt), {
                    addSuffix: true,
                    locale: fr,
                  })}
                </span>
                <span>·</span>
                <span>
                  {selectedFault.source === "GPS"
                    ? "position du téléphone"
                    : "adresse du site"}
                </span>
                {selectedFault.technicianName && (
                  <>
                    <span>·</span>
                    <span>Technicien : {selectedFault.technicianName}</span>
                  </>
                )}
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {canDispatch && (
                  <button
                    type="button"
                    onClick={() =>
                      setDispatchTarget({
                        id: selectedFault.incidentId,
                        incidentNumber: selectedFault.incidentNumber,
                        elevatorCode: selectedFault.elevatorCode,
                      })
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-xs font-bold text-white hover:bg-red-700"
                  >
                    Assigner un technicien
                  </button>
                )}
                <a
                  href={googleMapsDirectionsUrl(
                    selectedFault.latitude,
                    selectedFault.longitude
                  )}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-700 px-3 py-2 text-xs font-bold text-white hover:bg-red-800"
                >
                  <Navigation className="h-3.5 w-3.5" aria-hidden="true" />
                  Itinéraire GPS
                </a>
                <Link
                  href={
                    canDispatch
                      ? "/administration/incidents"
                      : "/bons-de-travail"
                  }
                  className="inline-flex items-center gap-1 rounded-lg border border-red-300 bg-white/70 px-3 py-2 text-xs font-semibold text-red-800 hover:bg-white dark:border-red-800 dark:bg-red-950/40 dark:text-red-200"
                >
                  {canDispatch ? "Voir le tableau" : "Voir les interventions"}
                </Link>
              </div>
            </div>
          )}

          {visibleSites.length === 0 && (
            <div className="pointer-events-none absolute inset-x-0 top-3 z-[1100] flex justify-center">
              <p className="rounded-lg bg-white/95 px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm dark:bg-gray-900/95 dark:text-gray-200">
                {sites.length === 0
                  ? "Aucun immeuble n'a encore de position. Placez-en un pour commencer."
                  : `Aucun site dans l'état « ${
                      filter === "ALL" ? "Tout" : ATTENTION_STYLES[filter].label
                    } ».`}
              </p>
            </div>
          )}
        </div>

        {selectedSite && (
          <SiteDetailPanel
            site={selectedSite}
            focusElevatorId={focusElevatorId}
            onClose={() => setSelectedId(null)}
            onReposition={() =>
              startPlacing({
                id: selectedSite.id,
                name: selectedSite.name,
                latitude: selectedSite.latitude,
                longitude: selectedSite.longitude,
              })
            }
            className="max-h-[60vh] flex-none lg:max-h-none lg:w-[380px]"
          />
        )}
      </div>

      <DispatchModal
        incident={dispatchTarget}
        onClose={() => setDispatchTarget(null)}
        onDispatched={() => {
          setDispatchTarget(null);
          setSelectedIncidentId(null);
          void reload({ silent: true });
        }}
      />
    </div>
  );
}
