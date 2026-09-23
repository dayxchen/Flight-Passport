import { loadAirportCoords, lookupCoords } from "./airports.js";
import { groupIntoTrips } from "./trips.js";
import { escapeHtml } from "./util.js";

const GLOBE_LIB_URL = "https://unpkg.com/globe.gl@2.46.2/dist/globe.gl.min.js";
const ARC_COLOR = "#f6a04d";
const ARC_COLOR_DIM = "rgba(246, 160, 77, 0.22)";
const ARC_COLOR_SELECTED = "#ffffff";

// Tour camera altitudes are "globe radii above the surface" (globe.gl's
// unit), which convert to a camera distance of radius * (1 + altitude).
// CLOSE_ALTITUDE's distance must clear controls.minDistance (140, see
// initGlobe) or OrbitControls clamps it and fights the scripted transition.
const TOUR_CLOSE_ALTITUDE = 0.45;
const TOUR_WIDE_ALTITUDE = 1.7;
const TOUR_PEAK_ALTITUDE = 2.6;
// Matches the globe's initial resting pointOfView — the "parked" altitude
// a leg zooms back out to before the next spin phase, so the handoff from
// one route to the next always passes through the same normal overview
// instead of spinning off from wherever a close-up happened to end.
const TOUR_NORMAL_ALTITUDE = 2.2;
const TOUR_ROUTE_FOLLOW_MS = 6500;
// Spinning is the default, resting state of the globe; a tour is an
// occasional break from that, not an alternating half of a cycle. Each
// spin stretch runs 12-22s, and only TOUR_START_PROBABILITY of those
// stretches end in a tour rather than just spinning again — so on average
// a tour kicks off roughly once a minute.
const TOUR_SPIN_MIN_MS = 12000;
const TOUR_SPIN_RANDOM_MS = 10000;
const TOUR_START_PROBABILITY = 0.3;
const TOUR_RESUME_DELAY_MS = 4000;

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

let tourLegs = [];
let tourIndex = 0;
let tourGeneration = 0;
let userInteracting = false;
let resumeTimeoutId = null;

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
  }

  return { arcs: Array.from(routes.values()), skipped };
}

// Ordered, per-leg (directional) flight list for the camera tour — distinct
// from buildGlobeData's arcs, which collapse both directions of a route
// into one undirected entry and so can't drive "fly this exact leg, then
// that one." Trips (from trips.js) give the natural playback order: full
// itineraries back to back, oldest first, rather than jumping between
// unrelated flights that happen to share an airport.
function buildTourLegs(flights) {
  const trips = [...groupIntoTrips(flights)].sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""));
  const legs = [];
  for (const trip of trips) {
    for (const flight of trip.flights) {
      const originCode = flight.departureIata || flight.departureIcao || "";
      const destCode = flight.arrivalIata || flight.arrivalIcao || "";
      const originCoord = lookupCoords(flight.departureIata, flight.departureIcao);
      const destCoord = lookupCoords(flight.arrivalIata, flight.arrivalIcao);
      if (!originCoord || !destCoord || !originCode || !destCode) continue;
      legs.push({
        flight,
        origin: { lat: originCoord[0], lng: originCoord[1] },
        dest: { lat: destCoord[0], lng: destCoord[1] },
      });
    }
  }
  return legs;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

function latLngToUnitVec({ lat, lng }) {
  const latRad = toRad(lat);
  const lngRad = toRad(lng);
  return [Math.cos(latRad) * Math.cos(lngRad), Math.cos(latRad) * Math.sin(lngRad), Math.sin(latRad)];
}

// Great-circle interpolation (slerp over geographic unit vectors) so the
// tour's "follow the route" segment tracks the same curve as the rendered
// arc, rather than cutting a straight line across the lat/lng grid.
function slerpLatLng(a, b, t) {
  const va = latLngToUnitVec(a);
  const vb = latLngToUnitVec(b);
  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const theta = Math.acos(dot);
  if (theta < 1e-6) return { lat: a.lat, lng: a.lng };
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  const x = va[0] * wa + vb[0] * wb;
  const y = va[1] * wa + vb[1] * wb;
  const z = va[2] * wa + vb[2] * wb;
  return { lat: toDeg(Math.asin(Math.max(-1, Math.min(1, z)))), lng: toDeg(Math.atan2(y, x)) };
}

function tourDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function easeInOutSine(t) {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

// Drives the camera continuously via rAF rather than chaining several
// globe.gl pointOfView(…, transitionMs) tweens back to back — each of those
// eases in and out on its own, so a chain of them reads as a visible
// stair-step of decelerate/accelerate rather than one flight. Setting the
// pointOfView with a 0ms transition every frame and doing the easing here,
// once, over the whole move keeps it a single continuous motion. Resolves
// to false if the tour was interrupted (caller should stop, not proceed as
// if the move finished).
function flyContinuous({ getPov, durationMs, generation }) {
  return new Promise((resolve) => {
    const start = performance.now();
    function step(now) {
      if (!tourShouldRun(generation)) {
        resolve(false);
        return;
      }
      const t = Math.min(1, (now - start) / durationMs);
      globeInstance.pointOfView(getPov(easeInOutSine(t)), 0);
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        resolve(true);
      }
    }
    requestAnimationFrame(step);
  });
}

// True while it's safe for the tour to keep issuing camera moves: this
// generation hasn't been superseded (view left, data reloaded), the globe
// tab is on screen, the tab itself is visible, and nobody is mid-drag or
// looking at a detail card.
function tourShouldRun(generation) {
  return (
    generation === tourGeneration &&
    globeInstance &&
    isGlobeViewActive() &&
    !document.hidden &&
    !motionQuery.matches &&
    !userInteracting &&
    detail.hidden
  );
}

async function flyLeg(leg, generation) {
  if (!tourShouldRun(generation)) return;
  globeInstance.controls().autoRotate = false;

  // 1. Zoom into the takeoff airport.
  globeInstance.pointOfView({ lat: leg.origin.lat, lng: leg.origin.lng, altitude: TOUR_CLOSE_ALTITUDE }, 2600);
  await tourDelay(2900);
  if (!tourShouldRun(generation)) return;

  await tourDelay(1000);
  if (!tourShouldRun(generation)) return;

  // 2. Zoom out to a wide view — the launch point for following the route.
  globeInstance.pointOfView({ lat: leg.origin.lat, lng: leg.origin.lng, altitude: TOUR_WIDE_ALTITUDE }, 1800);
  await tourDelay(2000);
  if (!tourShouldRun(generation)) return;

  // 3. Follow the route in one continuous motion, arcing up over the
  // midpoint and back down as it approaches the destination.
  const completed = await flyContinuous({
    generation,
    durationMs: TOUR_ROUTE_FOLLOW_MS,
    getPov: (t) => {
      const { lat, lng } = slerpLatLng(leg.origin, leg.dest, t);
      const altitude = TOUR_WIDE_ALTITUDE + (TOUR_PEAK_ALTITUDE - TOUR_WIDE_ALTITUDE) * Math.sin(Math.PI * t);
      return { lat, lng, altitude };
    },
  });
  if (!completed) return;

  // 4. Zoom into the landing airport.
  globeInstance.pointOfView({ lat: leg.dest.lat, lng: leg.dest.lng, altitude: TOUR_CLOSE_ALTITUDE }, 2200);
  await tourDelay(2500);
  if (!tourShouldRun(generation)) return;

  await tourDelay(1200);
  if (!tourShouldRun(generation)) return;

  // 5. Zoom back out to the normal resting view before handing off to the
  // spin phase — going straight from an airport close-up into a spin would
  // look like the camera snapping out, not settling.
  globeInstance.pointOfView({ lat: leg.dest.lat, lng: leg.dest.lng, altitude: TOUR_NORMAL_ALTITUDE }, 2000);
  await tourDelay(2200);
}

async function runTour(generation) {
  while (generation === tourGeneration) {
    if (!tourShouldRun(generation)) {
      await tourDelay(500);
      continue;
    }

    if (tourLegs.length === 0) {
      await tourDelay(1000);
      continue;
    }

    globeInstance.controls().autoRotate = true;
    await tourDelay(TOUR_SPIN_MIN_MS + Math.random() * TOUR_SPIN_RANDOM_MS);
    if (!tourShouldRun(generation)) continue;
    if (Math.random() > TOUR_START_PROBABILITY) continue; // keep spinning — no tour this round

    const leg = tourLegs[tourIndex % tourLegs.length];
    tourIndex += 1;
    await flyLeg(leg, generation);
  }
}

function startTour() {
  tourGeneration += 1;
  const generation = tourGeneration;
  runTour(generation);
}

function stopTour() {
  tourGeneration += 1;
}

function arcColorFor(d) {
  if (!selectedRouteKey) return [ARC_COLOR, ARC_COLOR];
  return d.routeKey === selectedRouteKey ? [ARC_COLOR_SELECTED, ARC_COLOR_SELECTED] : [ARC_COLOR_DIM, ARC_COLOR_DIM];
}

// Wider than the visual line needs to be on its own — globe.gl's arc click
// target is the rendered tube geometry itself, so a thin line is genuinely
// hard to tap. The extra width here is a click-target affordance, not a
// style choice.
function arcStrokeFor(d) {
  const base = 2.1 + Math.min(d.flights.length, 5) * 0.15;
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

function clearSelection() {
  selectedRouteKey = null;
  refreshSelectionStyles();
  detail.hidden = true;
  detail.innerHTML = "";
}

function applyData() {
  const { arcs, skipped } = buildGlobeData(latestFlights);
  selectedRouteKey = null;
  clearSelection();

  tourLegs = buildTourLegs(latestFlights);
  tourIndex = 0;

  if (!globeInstance) return;
  globeInstance.arcsData(arcs);

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
  globeInstance.controls().autoRotate = !motionQuery.matches;
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
    .onArcClick((arc, event) => {
      event.stopPropagation();
      renderRouteDetail(arc);
    })
    .onGlobeClick(() => clearSelection());

  const material = globe.globeMaterial();
  material.color.set("#185fa5");
  material.emissive.set("#185fa5");
  material.emissiveIntensity = 0.35;
  material.shininess = 0;

  // The camera's 50° FOV and the globe's radius (100, ~112 with atmosphere)
  // mean the sphere only stays fully in frame at distance >= ~265
  // (radius / sin(fov/2)). minDistance is set well below that so users can
  // zoom in close enough to crop the globe against the canvas edges and
  // inspect individual airports/arcs up close.
  globe.controls().minDistance = 140;
  globe.controls().maxDistance = 600;
  globe.controls().autoRotate = !motionQuery.matches;
  globe.controls().autoRotateSpeed = 0.35;
  globe.pointOfView({ lat: 25, lng: 0, altitude: 2.2 });

  // OrbitControls fires 'start'/'end' around every pointer down/up on the
  // canvas, taps included — pausing the tour on 'start' and giving it a
  // few seconds of quiet after 'end' before resuming keeps a scripted
  // camera move from yanking the view out from under someone who's mid-tap
  // or still looking around after letting go.
  globe.controls().addEventListener("start", () => {
    userInteracting = true;
    if (resumeTimeoutId) clearTimeout(resumeTimeoutId);
  });
  globe.controls().addEventListener("end", () => {
    if (resumeTimeoutId) clearTimeout(resumeTimeoutId);
    resumeTimeoutId = setTimeout(() => {
      userInteracting = false;
    }, TOUR_RESUME_DELAY_MS);
  });

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
    startTour();
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
    startTour();
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
  stopTour();
  if (globeInstance) {
    globeInstance.pauseAnimation();
    freezeAnimationFrames();
  }
}
