"use client";

/**
 * The fleet map.
 *
 * WHY LEAFLET IS IMPORTED INSIDE AN EFFECT AND NOT AT THE TOP OF THE FILE
 * Leaflet reaches for `window` and `document` while its module body runs, so a
 * static import breaks the server render — the page throws before it ever
 * reaches the browser. `next/dynamic` with `ssr: false` is the other way out of
 * that, but it is only callable from a Client Component, which would force
 * every page using the map to become one for that reason alone. A dynamic
 * `import()` inside `useEffect` keeps the module out of the server bundle
 * entirely and costs one state flag.
 *
 * WHY THE MARKERS ARE HTML STRINGS
 * Leaflet's `divIcon` takes markup, not a React element, so there is no
 * component here to carry a style prop and no JSX to escape anything for us.
 * Building that markup from database values — building names, addresses,
 * reasons — is the one place in this application that assembles HTML by hand,
 * and it is therefore the one place that must escape it. See `escapeHtml`.
 *
 * ONE PIN PER SITE, NOT ONE PER ELEVATOR
 * A tower with six units would otherwise be six markers on one street corner,
 * stacked so that only the topmost can be clicked, and the map would say
 * nothing a count could not say better. The pin carries the *worst* level at
 * the site and the number of units behind it; the panel behind the pin lists
 * them individually with their own colours.
 *
 * NO THEME FILTER ON THE TILES
 * The obvious trick for dark mode is a CSS filter over the tile layer, and it
 * is a bad one here: it inverts the markers along with the streets, so every
 * colour stops meaning what `attention.ts` says it means. A light map inside a
 * dark interface is legible and unremarkable; a map whose red pins have turned
 * cyan is worse than a bright one.
 */

import { useEffect, useRef, useState } from "react";
import type { LayerGroup, Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";
import { ATTENTION_STYLES } from "@/lib/map/attention";
import type { FleetMapFault, FleetMapSite } from "@/lib/map/types";
import { enumLabel } from "@/lib/ui/enum-labels";
import type { Coordinates } from "@/lib/geo/geofence";
import { formatDistance } from "@/lib/geo/geofence";
import { cn } from "@/lib/utils";

/** The whole `L` object, as `@types/leaflet` describes it. */
type LeafletNamespace = typeof import("leaflet");

/**
 * Takes the Leaflet object out of whatever the bundler hands back.
 *
 * Leaflet ships a UMD bundle whose CommonJS export *is* the whole `L` object,
 * while `@types/leaflet` types the package as a module of named exports with
 * no default at all. Both descriptions are true of the same file, and which
 * shape a dynamic `import()` exposes depends on whether the bundler managed to
 * statically read the names out of the UMD wrapper.
 *
 * This matters more than it looks. Reading named exports off the namespace —
 * `(await import("leaflet")).map(...)` — type-checks perfectly and returns
 * `undefined` at runtime if the wrapper was not statically analysable, which
 * fails as an empty map with no error anywhere. Reading `default` is reliable
 * for a CommonJS module but is not what the declaration describes.
 *
 * So: take `default` when it is there, fall back to the namespace when it is
 * not. The cast exists only because the type declaration does not admit that
 * `default` is possible.
 */
function unwrapLeaflet(module: LeafletNamespace): LeafletNamespace {
  const candidate = (module as { default?: LeafletNamespace }).default;
  return candidate ?? module;
}

// ─── Constants ──────────────────────────────────────────────

/**
 * OpenStreetMap's standard tiles, as chosen.
 *
 * No `{s}` subdomain placeholder: OSM retired its subdomains and serving from
 * the bare host is what its tile usage policy now asks for. The attribution is
 * required by that policy and is not decorative — removing it is a licence
 * breach, not a style decision.
 */
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

/**
 * Where the map looks when there is nothing to show.
 *
 * Algiers, at city zoom: this is an Algerian maintenance company, so an empty
 * map opening on its own country is more useful than a grey world view.
 */
const FALLBACK_CENTER: [number, number] = [36.7538, 3.0588];
const FALLBACK_ZOOM = 11;

/** Zoom used when flying to a single site. Close enough to read the streets. */
const SITE_ZOOM = 16;

/** Leaflet's own marker wrapper. Replaces `leaflet-div-icon`, whose white
 *  background and border would otherwise frame every pin. */
const MARKER_CLASS = "ep-map-marker-wrapper";

// ─── Escaping ───────────────────────────────────────────────

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escapes text on its way into a marker or a tooltip.
 *
 * Not a formality. A building name and an address are free text typed into the
 * application, and a reason string can carry a technician's note. Every one of
 * them ends up inside markup that Leaflet injects with `innerHTML`, so an
 * unescaped `<` is enough to break the map and a `<script>` would execute in
 * the browser of whoever opened the map next. `&` is escaped first by ordering
 * the character class, not the replacement order — a single pass over the
 * string cannot double-escape.
 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

// ─── Marker and tooltip markup ──────────────────────────────

function markerHtml(site: FleetMapSite, selected: boolean): string {
  const style = ATTENTION_STYLES[site.level];
  const counted = site.needsAttention > 0;

  const classes = [
    "ep-map-marker",
    style.pulse ? "ep-map-marker--pulse" : "",
    counted ? "ep-map-marker--counted" : "",
    selected ? "ep-map-marker--selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    `<div class="${classes}" style="--ep-color:${style.color}">` +
    `<span class="ep-map-marker__halo"></span>` +
    // The count is the number of units that are *not* NORMAL. On a green pin it
    // is always empty, which is what makes the number worth reading.
    `<span class="ep-map-marker__dot">${counted ? site.needsAttention : ""}</span>` +
    `</div>`
  );
}

function tooltipHtml(site: FleetMapSite): string {
  const style = ATTENTION_STYLES[site.level];

  // The headline is the most urgent finding, which is exactly what coloured the
  // pin. A normal site has no findings, so it says what is there instead.
  const headline =
    site.level === "NORMAL"
      ? `${site.elevatorCount} ${site.elevatorCount > 1 ? "ascenseurs en service" : "ascenseur en service"}`
      : site.elevators.find((e) => e.level === site.level)?.reason ?? style.label;

  const units =
    site.elevatorCount > 1 ? `${site.elevatorCount} ascenseurs` : "1 ascenseur";

  return (
    `<div class="ep-map-tooltip__body" style="--ep-color:${style.color}">` +
    `<div class="ep-map-tooltip__name">${escapeHtml(site.name)}</div>` +
    `<div class="ep-map-tooltip__meta">${escapeHtml(site.city)} · ${units}</div>` +
    `<div class="ep-map-tooltip__reason">` +
    `<span class="ep-map-tooltip__swatch"></span>${escapeHtml(headline)}` +
    `</div></div>`
  );
}

// ─── Fault pins ─────────────────────────────────────────────

/**
 * The two fault colours.
 *
 * Deliberately *not* in `attention.ts`. Those colours answer "how healthy is
 * this site", and these answer a different question — "has this one been
 * handled yet". Red is a fault raised through the emergency button, which by
 * construction means nobody has read a description and nobody has spoken to the
 * reporter; amber came through the wizard, so there is a fault code and some
 * words attached. Reusing the attention palette would put two meanings on one
 * colour and leave the legend unable to say what either of them is.
 */
const FAULT_COLORS = {
  emergency: "#dc2626",
  escalation: "#f59e0b",
} as const;

function faultColor(fault: FleetMapFault): string {
  return fault.isDirectTransfer ? FAULT_COLORS.emergency : FAULT_COLORS.escalation;
}

function faultMarkerHtml(fault: FleetMapFault): string {
  return `<div class="ep-map-fault" style="--ep-fault:${faultColor(fault)}"></div>`;
}

/**
 * What the pin says when hovered.
 *
 * The third line is the one that matters. A pin drawn from the reporter's own
 * device and a pin drawn from the building's address look identical on the map,
 * and they are not the same claim at all — one is a measurement, the other is a
 * fallback. Saying which is which is the difference between a map a dispatcher
 * can act on and one that quietly overstates what it knows.
 */
function faultTooltipHtml(fault: FleetMapFault): string {
  const meta = [
    enumLabel(fault.status),
    fault.isDirectTransfer ? "Urgence" : null,
    fault.technicianName ? `Technicien : ${fault.technicianName}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  const origin = fault.source
    ? enumLabel(fault.source)
    : "Position d'origine non enregistrée";

  return (
    `<div class="ep-map-tooltip__body" style="--ep-color:${faultColor(fault)}">` +
    `<div class="ep-map-tooltip__name">${escapeHtml(fault.incidentNumber)} · ${escapeHtml(fault.elevatorCode)}</div>` +
    `<div class="ep-map-tooltip__meta">${escapeHtml(fault.buildingName)} · ${escapeHtml(meta)}</div>` +
    `<div class="ep-map-tooltip__reason">` +
    `<span class="ep-map-tooltip__swatch"></span>Position : ${escapeHtml(origin)}` +
    `</div>` +
    // Says out loud what the dashed ring on the map is, so the circle is not
    // read as a measurement of anything — it is a work area.
    `<div class="ep-map-tooltip__reason">` +
    `<span class="ep-map-tooltip__swatch ep-map-tooltip__swatch--zone"></span>Zone d'intervention : ${escapeHtml(
      formatDistance(fault.interventionRadiusM)
    )}` +
    `</div></div>`
  );
}

// ─── Component ──────────────────────────────────────────────

export interface FleetMapProps {
  sites: FleetMapSite[];
  /**
   * Open faults, drawn at the spot they were reported from.
   *
   * Independent of `sites` and of `selectedId`: these pins are not a site's
   * health, they are outstanding work. They stay on the map when the attention
   * filter hides the building they belong to — filtering by level is a way of
   * reading the fleet, and it must not be a way of losing sight of a lift
   * somebody is stuck in.
   *
   * A fault whose building is not among `sites` is still drawn, but is not
   * clickable: there is no detail panel to open for a site the map is not
   * showing.
   */
  faults?: FleetMapFault[];
  /** The site to highlight. Controlled by the caller. */
  selectedId?: string | null;
  onSelect?: (siteId: string | null) => void;
  /**
   * Draw every site's check-in radius.
   *
   * Off by default: fifty overlapping circles turn a fleet view into a Venn
   * diagram. The selected site's circle is drawn regardless, because that is
   * the moment the figure is worth reading.
   */
  showGeofence?: boolean;
  /** The viewer's own position, drawn as a blue dot. Technicians only. */
  selfPosition?: Coordinates | null;
  /**
   * Fires when the *base map* is clicked, never when a pin is.
   *
   * Leaflet dispatches a marker click and then a map click unless the marker
   * handler stops propagation, which is why this is wired to the map alone: a
   * caller placing a pin must not have "choose a spot" fire when they meant
   * "open this site". Markers call `stopPropagation` for exactly that reason.
   */
  onMapClick?: (position: Coordinates) => void;
  /** A position chosen but not yet saved, drawn as a crosshair. */
  draftPosition?: Coordinates | null;
  /**
   * Whether the wheel zooms. False in embedded panels, where the wheel belongs
   * to the page and a map that swallows it traps the reader mid-scroll.
   */
  scrollWheelZoom?: boolean;
  className?: string;
}

export function FleetMap({
  sites,
  faults = [],
  selectedId = null,
  onSelect,
  showGeofence = false,
  selfPosition = null,
  onMapClick,
  draftPosition = null,
  scrollWheelZoom = false,
  className,
}: FleetMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<LeafletNamespace | null>(null);
  const siteLayerRef = useRef<LayerGroup | null>(null);
  const selfLayerRef = useRef<LayerGroup | null>(null);
  const draftLayerRef = useRef<LayerGroup | null>(null);
  const faultLayerRef = useRef<LayerGroup | null>(null);

  /** Set once Leaflet has loaded and the map exists, so the drawing effects
   *  know they have something to draw on. */
  const [ready, setReady] = useState(false);

  /**
   * The callback is held in a ref so that a caller passing an inline arrow —
   * which every caller will — does not restart the map on every render. The map
   * is the most expensive thing on the page to build and the least tolerant of
   * being rebuilt.
   */
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;

  /** Read once at mount. A panel never changes this at runtime. */
  const wheelZoomRef = useRef(scrollWheelZoom);

  /** Fit the view to the fleet exactly once. Re-fitting on every poll would
   *  drag the map out from under whoever is reading it. */
  const hasFittedRef = useRef(false);

  /** The last site we flew to, so a re-render does not re-fly. */
  const flownToRef = useRef<string | null>(null);

  // ── Build the map ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let map: LeafletMap | null = null;

    (async () => {
      const L = unwrapLeaflet(await import("leaflet"));
      if (cancelled || !containerRef.current) return;

      leafletRef.current = L;

      map = L.map(containerRef.current, {
        center: FALLBACK_CENTER,
        zoom: FALLBACK_ZOOM,
        scrollWheelZoom: wheelZoomRef.current,
        // Zoom lives in the top-right, where it does not sit under the
        // application's own back button or the panel's close control.
        zoomControl: false,
        attributionControl: true,
      });

      L.control.zoom({ position: "topright" }).addTo(map);

      L.tileLayer(TILE_URL, {
        maxZoom: 19,
        attribution: TILE_ATTRIBUTION,
      }).addTo(map);

      siteLayerRef.current = L.layerGroup().addTo(map);
      selfLayerRef.current = L.layerGroup().addTo(map);
      draftLayerRef.current = L.layerGroup().addTo(map);
      faultLayerRef.current = L.layerGroup().addTo(map);

      map.on("click", (event) => {
        onMapClickRef.current?.({
          latitude: event.latlng.lat,
          longitude: event.latlng.lng,
        });
      });

      mapRef.current = map;
      setReady(true);
    })();

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
      leafletRef.current = null;
      siteLayerRef.current = null;
      selfLayerRef.current = null;
      draftLayerRef.current = null;
      faultLayerRef.current = null;
      hasFittedRef.current = false;
      flownToRef.current = null;
      setReady(false);
    };
  }, []);

  // ── Keep Leaflet's idea of its own size current ───────────
  //
  // Leaflet measures its container once, at construction. The application's
  // sidebar collapses, the dashboard's grid reflows and a phone rotates — all
  // of which leave the map drawing into the size it used to be, with tiles
  // missing along one edge.
  useEffect(() => {
    const container = containerRef.current;
    const map = mapRef.current;
    if (!ready || !container || !map) return;

    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(container);
    return () => observer.disconnect();
  }, [ready]);

  // ── Draw the sites ────────────────────────────────────────
  useEffect(() => {
    const L = leafletRef.current;
    const layer = siteLayerRef.current;
    const map = mapRef.current;
    if (!ready || !L || !layer || !map) return;

    layer.clearLayers();

    for (const site of sites) {
      const style = ATTENTION_STYLES[site.level];
      const selected = selectedId === site.id;

      const marker = L.marker([site.latitude, site.longitude], {
        icon: L.divIcon({
          html: markerHtml(site, selected),
          className: MARKER_CLASS,
          iconSize: [34, 34],
          iconAnchor: [17, 17],
        }),
        title: `${site.name} — ${style.label}`,
        riseOnHover: true,
      });

      marker.bindTooltip(tooltipHtml(site), {
        className: "ep-map-tooltip",
        direction: "top",
        offset: [0, -16],
        opacity: 1,
      });

      marker.on("click", (event) => {
        // Without this, opening a site while placing a pin would also move the
        // pin to wherever the marker happened to be.
        L.DomEvent.stopPropagation(event);
        onSelectRef.current?.(site.id);
      });
      marker.addTo(layer);

      if (showGeofence || selected) {
        L.circle([site.latitude, site.longitude], {
          radius: site.geofenceRadiusM,
          color: style.color,
          weight: selected ? 2 : 1,
          opacity: selected ? 0.9 : 0.45,
          fillColor: style.color,
          fillOpacity: selected ? 0.08 : 0.04,
          // The circle is a reading aid, not a target; clicks belong to the pin.
          interactive: false,
        }).addTo(layer);
      }
    }

    // Fit the whole fleet once, on the first draw that actually has sites.
    if (!hasFittedRef.current && sites.length > 0) {
      hasFittedRef.current = true;
      map.fitBounds(
        L.latLngBounds(sites.map((s) => [s.latitude, s.longitude] as [number, number])),
        // Padding keeps the outermost pins off the container's edge, where the
        // zoom control and the attribution line sit.
        { padding: [56, 56], maxZoom: 15 }
      );
      return;
    }

    if (selectedId && flownToRef.current !== selectedId) {
      const site = sites.find((s) => s.id === selectedId);
      if (site) {
        flownToRef.current = selectedId;
        map.flyTo([site.latitude, site.longitude], Math.max(map.getZoom(), SITE_ZOOM), {
          duration: 0.6,
        });
      }
    } else if (!selectedId) {
      flownToRef.current = null;
    }
  }, [ready, sites, selectedId, showGeofence]);

  // ── Draw the viewer's own position ────────────────────────
  useEffect(() => {
    const L = leafletRef.current;
    const layer = selfLayerRef.current;
    if (!ready || !L || !layer) return;

    layer.clearLayers();
    if (!selfPosition) return;

    L.marker([selfPosition.latitude, selfPosition.longitude], {
      icon: L.divIcon({
        html: '<div class="ep-map-marker__you"></div>',
        className: MARKER_CLASS,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
      // Nothing to click and nothing to say: it is a position, not a place.
      interactive: false,
      zIndexOffset: 1000,
    }).addTo(layer);
  }, [ready, selfPosition]);

  // ── Draw the position being chosen ────────────────────────
  useEffect(() => {
    const L = leafletRef.current;
    const layer = draftLayerRef.current;
    if (!ready || !L || !layer) return;

    layer.clearLayers();
    if (!draftPosition) return;

    L.marker([draftPosition.latitude, draftPosition.longitude], {
      icon: L.divIcon({
        html: '<div class="ep-map-marker__draft"></div>',
        className: MARKER_CLASS,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      }),
      // A crosshair the caller is about to confirm, not a place to click.
      interactive: false,
      zIndexOffset: 2000,
    }).addTo(layer);
  }, [ready, draftPosition]);

  // ── Draw the open faults ──────────────────────────────────
  useEffect(() => {
    const L = leafletRef.current;
    const layer = faultLayerRef.current;
    if (!ready || !L || !layer) return;

    layer.clearLayers();
    if (faults.length === 0) return;

    /**
     * Which faults belong to a site the map is currently drawing.
     *
     * Built once rather than searched per pin. A fault on a building the
     * attention filter has hidden is still drawn — losing sight of an open
     * fault because of a display choice would be the worst possible trade — but
     * it is not clickable, because there is no detail panel to open for a site
     * that is not on the screen.
     */
    const selectable = new Set(sites.map((site) => site.id));

    for (const fault of faults) {
      const clickable = selectable.has(fault.buildingId);

      /**
       * The intervention zone, drawn around the fault rather than around the
       * site.
       *
       * Dashed on purpose: the site layer already draws a solid circle around
       * each building at the same kind of radius, and two identical rings
       * meaning "you may check in here" and "this is the area we are working
       * in" would make the map lie about one of them. A broken ring reads as a
       * boundary somebody drew, not as a surveyed distance.
       *
       * Drawn whether or not the site geofence toggle is on: a dispatcher
       * looking at an open fault is asking where the work is, and hiding the
       * answer behind a display setting would be the wrong default.
       */
      L.circle([fault.latitude, fault.longitude], {
        radius: fault.interventionRadiusM,
        color: faultColor(fault),
        weight: 1.5,
        opacity: 0.6,
        dashArray: "6 5",
        fillColor: faultColor(fault),
        fillOpacity: 0.06,
        // A boundary, not a target: the pin is what gets clicked.
        interactive: false,
      }).addTo(layer);

      const marker = L.marker([fault.latitude, fault.longitude], {
        icon: L.divIcon({
          html: faultMarkerHtml(fault),
          className: MARKER_CLASS,
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        }),
        // Above the site pins, because an outstanding fault is the thing worth
        // noticing, but below the viewer's own dot at 1000 — "where I am" is
        // the one fact that has to stay on top of everything.
        zIndexOffset: 500,
        interactive: clickable,
      });

      marker.bindTooltip(faultTooltipHtml(fault), {
        direction: "top",
        offset: [0, -10],
        className: "ep-map-tooltip",
      });

      if (clickable) {
        marker.on("click", (event) => {
          // Leaflet dispatches a click on the map after the marker's unless it
          // is stopped. Without this, clicking a fault would both open its site
          // and, in placement mode, drop a pin on the same spot.
          L.DomEvent.stopPropagation(event);
          onSelectRef.current?.(fault.buildingId);
        });
      }

      marker.addTo(layer);
    }
  }, [ready, faults, sites]);

  return (
    <div
      ref={containerRef}
      className={cn("h-full w-full rounded-lg overflow-hidden", className)}
      // Leaflet fills its container, so the element needs a size from the
      // caller. Stated here because the failure mode is a blank rectangle with
      // no error at all.
      role="application"
      aria-label="Carte du parc d'ascenseurs"
    />
  );
}

export default FleetMap;
