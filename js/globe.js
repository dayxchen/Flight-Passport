import { loadAirportCoords, lookupCoords } from "./airports.js";
import { escapeHtml } from "./util.js";

const GLOBE_LIB_URL = "https://unpkg.com/globe.gl@2.46.2/dist/globe.gl.min.js";
const ARC_COLOR = "#f6a04d";
const ARC_COLOR_DIM = "rgba(246, 160, 77, 0.22)";
const ARC_COLOR_SELECTED = "#ffffff";

const wrap = document.getElementById("globe-wrap");
const stage = document.getElementById("globe-stage");
const detail = document.getElementById("globe-detail");
const emptyEl = document.getElementById("globe-empty");
const addCta = document.getElementById("globe-add-cta");
const statusEl = document.getElementById("globe-status");
const skippedEl = document.getElementById("globe-skipped");

let globeLibPromise = null;
let countriesPromise = null;
let globeInstance = null;
let initPromise = null;
let latestFlights = [];
let selectedRouteKey = null;
let resizeObserver = null;

const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

addCta.addEventListener("click", () => {
  document.querySelector('.tab[data-view="add"]')?.click();
});

// A tap on the transparent square around the sphere's circular silhouette
// never hits any three.js raycast target, so onGlobeClick never fires there.
// This plain DOM listener is the fallback that makes "tap anywhere in the
// background dismisses" actually true. Arc/point clicks call
// event.stopPropagation(), so this never fights the detail card open.
stage.addEventListener("click", () => clearSelection());

function loadGlobeLib() {
  if (globeLibPromise) return globeLibPromise;
  globeLibPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GLOBE_LIB_URL;
    script.onload = () => resolve(window.Globe);
    script.onerror = () => reject(new Error("Globe library failed to load"));
    document.head.appendChild(script);
  });
  return globeLibPromise;
}

function loadCountries() {
  if (countriesPromise) return countriesPromise;
  countriesPromise = fetch("./data/countries-110m.geojson")
    .then((response) => {
      if (!response.ok) throw new Error("Country outlines failed to load");
      return response.json();
    })
    .catch((err) => {
      countriesPromise = null;
      throw err;
    });
  return countriesPromise;
}

function routeKey(a, b) {
  return [a, b].sort().join("|");
}

function buildGlobeData(flights) {
  const routes = new Map();
  const points = new Map();
  const skipped = [];

  for (const flight of flights) {
    const originCode = flight.departureIata || flight.departureIcao || "";
    const destCode = flight.arrivalIata || flight.arrivalIcao || "";
    const originCoord = lookupCoords(flight.departureIata, flight.departureIcao);
    const destCoord = lookupCoords(flight.arrivalIata, flight.arrivalIcao);

    if (!originCoord || !destCoord || !originCode || !destCode) {
      skipped.push(flight);
      continue;
    }

    const key = routeKey(originCode, destCode);
    if (!routes.has(key)) {
      routes.set(key, {
        routeKey: key,
        originCode,
        destCode,
        startLat: originCoord[0],
        startLng: originCoord[1],
        endLat: destCoord[0],
        endLng: destCoord[1],
        flights: [],
      });
    }
    routes.get(key).flights.push(flight);
    points.set(originCode, { code: originCode, lat: originCoord[0], lng: originCoord[1] });
    points.set(destCode, { code: destCode, lat: destCoord[0], lng: destCoord[1] });
  }

  return { arcs: Array.from(routes.values()), points: Array.from(points.values()), skipped };
}

function arcColorFor(d) {
  if (!selectedRouteKey) return [ARC_COLOR, ARC_COLOR];
  return d.routeKey === selectedRouteKey ? [ARC_COLOR_SELECTED, ARC_COLOR_SELECTED] : [ARC_COLOR_DIM, ARC_COLOR_DIM];
}

function arcStrokeFor(d) {
  const base = 1 + Math.min(d.flights.length, 5) * 0.15;
  return d.routeKey === selectedRouteKey ? base + 0.7 : base;
}

function refreshSelectionStyles() {
  if (!globeInstance) return;
  globeInstance.arcColor(arcColorFor);
  globeInstance.arcStroke(arcStrokeFor);
}

function flightSummary(flight) {
  const origin = flight.departureIata || flight.departureIcao || "—";
  const destination = flight.arrivalIata || flight.arrivalIcao || "—";
  return `${escapeHtml(flight.flightDate)} · ${escapeHtml(flight.airlineName)} ${escapeHtml(flight.flightNumber)} · ${escapeHtml(origin)} → ${escapeHtml(destination)}`;
}

function renderRouteDetail(route) {
  selectedRouteKey = route.routeKey;
  refreshSelectionStyles();

  const heading = `${route.originCode} → ${route.destCode}`;
  const count = route.flights.length === 1 ? "1 flight" : `${route.flights.length} flights`;
  detail.innerHTML = `
    <button type="button" class="globe-detail-close" aria-label="Close">×</button>
    <h2>${escapeHtml(heading)} · ${escapeHtml(count)}</h2>
    <ul>${route.flights.map((f) => `<li>${flightSummary(f)}</li>`).join("")}</ul>
  `;
  detail.hidden = false;
  detail.querySelector(".globe-detail-close").addEventListener("click", (event) => {
    event.stopPropagation();
    clearSelection();
  });
}

function renderAirportDetail(point, arcs) {
  const connected = arcs.filter((arc) => arc.originCode === point.code || arc.destCode === point.code);
  if (connected.length === 0) return;

  selectedRouteKey = null;
  refreshSelectionStyles();

  const flights = connected.flatMap((arc) => arc.flights);
  const count = flights.length === 1 ? "1 flight" : `${flights.length} flights`;
  detail.innerHTML = `
    <button type="button" class="globe-detail-close" aria-label="Close">×</button>
    <h2>${escapeHtml(point.code)} · ${escapeHtml(count)}</h2>
    <ul>${flights.map((f) => `<li>${flightSummary(f)}</li>`).join("")}</ul>
  `;
  detail.hidden = false;
  detail.querySelector(".globe-detail-close").addEventListener("click", (event) => {
    event.stopPropagation();
    clearSelection();
  });
}

function clearSelection() {
  selectedRouteKey = null;
  refreshSelectionStyles();
  detail.hidden = true;
  detail.innerHTML = "";
}

let currentArcs = [];

function applyData() {
  const { arcs, points, skipped } = buildGlobeData(latestFlights);
  currentArcs = arcs;
  selectedRouteKey = null;
  clearSelection();

  if (!globeInstance) return;
  globeInstance.arcsData(arcs).pointsData(points);

  if (skipped.length > 0) {
    skippedEl.hidden = false;
    skippedEl.textContent =
      skipped.length === 1
        ? "1 flight couldn't be placed on the globe (unknown airport)."
        : `${skipped.length} flights couldn't be placed on the globe (unknown airports).`;
  } else {
    skippedEl.hidden = true;
    skippedEl.textContent = "";
  }
}

function applyMotionPrefs() {
  if (!globeInstance) return;
  const reduce = motionQuery.matches;
  globeInstance.controls().autoRotate = !reduce;
  globeInstance.arcDashAnimateTime(reduce ? 0 : 2600);
}

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

function isGlobeViewActive() {
  const section = document.getElementById("view-globe");
  return Boolean(section && !section.hidden);
}

// CSS aspect-ratio on a flex item whose content includes a WebGL canvas does
// not reliably resolve to a square across browsers once globe.gl mounts —
// the box ends up stretching to its max-height instead. Size it explicitly
// in JS instead, sized from the VIEWPORT rather than the app's narrow
// `main` column (width: min(28rem, 100%)) so the globe can grow to fill
// wide screens instead of being capped at ~448px.
//
// `main` is itself horizontally centered on the page, so its own
// center coincides with the viewport's center — meaning `left: 50%` +
// a negative margin of half the side, applied to a child of `main`, is
// enough to center the box on the viewport without needing vw units.
function resizeSquare() {
  const maxSide = Math.min(window.innerWidth * 0.92, window.innerHeight * 0.72, 720);
  const side = Math.max(220, maxSide);
  wrap.style.width = `${side}px`;
  wrap.style.height = `${side}px`;
  wrap.style.left = "50%";
  wrap.style.marginLeft = `${-side / 2}px`;
}

window.addEventListener("resize", () => {
  if (!isGlobeViewActive()) return;
  resizeSquare();
});

document.addEventListener("visibilitychange", () => {
  if (!globeInstance) return;
  if (document.hidden) {
    globeInstance.pauseAnimation();
    freezeAnimationFrames();
  } else if (isGlobeViewActive()) {
    unfreezeAnimationFrames();
    globeInstance.resumeAnimation();
  }
});

async function initGlobe() {
  setStatus("Loading globe…");
  resizeSquare();

  const [GlobeLib, , countries] = await Promise.all([loadGlobeLib(), loadAirportCoords(), loadCountries()]);

  let width = stage.clientWidth;
  let height = stage.clientHeight;
  if (!width || !height) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    width = stage.clientWidth;
    height = stage.clientHeight;
  }

  const globe = GlobeLib()(stage)
    .width(width)
    .height(height)
    .backgroundColor("rgba(0,0,0,0)")
    .globeImageUrl(null)
    .showAtmosphere(true)
    .atmosphereColor("#7fb2e5")
    .atmosphereAltitude(0.12)
    .polygonsData(countries.features)
    .polygonCapColor(() => "#e7f1fb")
    .polygonSideColor(() => "rgba(231, 241, 251, 0.4)")
    .polygonStrokeColor(() => "#bcd6ef")
    .polygonAltitude(0.007)
    .polygonsTransitionDuration(0)
    .arcColor(arcColorFor)
    .arcStroke(arcStrokeFor)
    .arcAltitudeAutoScale(0.4)
    .arcDashLength(0.75)
    .arcDashGap(0.4)
    .arcDashAnimateTime(motionQuery.matches ? 0 : 2600)
    .pointColor(() => "#ffffff")
    .pointRadius(0.25)
    .pointAltitude(0.012)
    .pointResolution(6)
    .onArcClick((arc, event) => {
      event.stopPropagation();
      renderRouteDetail(arc);
    })
    .onPointClick((point, event) => {
      event.stopPropagation();
      renderAirportDetail(point, currentArcs);
    })
    .onGlobeClick(() => clearSelection());

  const material = globe.globeMaterial();
  material.color.set("#185fa5");
  material.emissive.set("#185fa5");
  material.emissiveIntensity = 0.35;
  material.shininess = 0;

  // The camera's 50° FOV and the globe's radius (100, ~112 with atmosphere)
  // mean the sphere only stays fully in frame at distance >= ~272
  // (radius / sin(fov/2)). A smaller minDistance lets users zoom in past
  // that point and crop the globe against the canvas edges.
  globe.controls().minDistance = 290;
  globe.controls().maxDistance = 600;
  globe.controls().autoRotate = !motionQuery.matches;
  globe.controls().autoRotateSpeed = 0.35;
  globe.pointOfView({ lat: 25, lng: 0, altitude: 2.2 });

  globeInstance = globe;

  resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) return;
    const w = entry.contentRect.width;
    const h = entry.contentRect.height;
    if (!w || !h) return;
    globeInstance.width(w).height(h);
  });
  resizeObserver.observe(stage);

  motionQuery.addEventListener("change", applyMotionPrefs);

  applyData();
}

export function updateGlobe(flights) {
  latestFlights = flights || [];
  if (globeInstance) applyData();
}

export async function activateGlobe() {
  if (latestFlights.length === 0) {
    wrap.hidden = true;
    addCta.hidden = false;
    emptyEl.hidden = false;
    skippedEl.hidden = true;
    setStatus("");
    return;
  }

  emptyEl.hidden = true;
  addCta.hidden = true;

  if (globeInstance) {
    wrap.hidden = false;
    resizeSquare();
    setStatus("");
    unfreezeAnimationFrames();
    globeInstance.resumeAnimation();
    return;
  }

  // Unhide before measuring/creating the canvas — a hidden container has
  // zero size and three.js won't recover from being sized at 0x0.
  wrap.hidden = false;

  if (!initPromise) {
    initPromise = initGlobe().catch((err) => {
      initPromise = null;
      throw err;
    });
  }

  try {
    await initPromise;
    setStatus("");
  } catch (err) {
    wrap.hidden = true;
    setStatus("Couldn't load the globe. Check your connection and try again.", "error");
  }
}

// globe.gl's pauseAnimation() reliably stops the actual WebGL render loop
// (verified: renderer.info.render.calls stops increasing), but at least one
// internal per-layer animation ticker (driving the arc dash offset) keeps
// scheduling requestAnimationFrame independently of pauseAnimation's cascade
// — a globe.gl quirk, not something reachable via its public API. Since
// nothing else on this page uses requestAnimationFrame, the reliable fix is
// to starve every rAF call while the globe tab isn't visible.
let realRAF = null;

function freezeAnimationFrames() {
  if (realRAF) return;
  realRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = () => 0;
}

function unfreezeAnimationFrames() {
  if (!realRAF) return;
  window.requestAnimationFrame = realRAF;
  realRAF = null;
}

export function deactivateGlobe() {
  if (globeInstance) {
    globeInstance.pauseAnimation();
    freezeAnimationFrames();
  }
}
