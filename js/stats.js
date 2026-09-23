import { loadAirportCoords, loadAirportCountries, loadAirports, lookupAirport, lookupCoords, lookupCountry } from "./airports.js";
import { escapeHtml } from "./util.js";

const EARTH_RADIUS_MI = 3958.8;

const wrap = document.getElementById("stats-wrap");
const emptyEl = document.getElementById("stats-empty");
const grid = document.getElementById("stats-grid");
const highlights = document.getElementById("stats-highlights");

let latestFlights = [];
let dataReady = false;

function haversineMiles(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * sinDLon * sinDLon;
  return EARTH_RADIUS_MI * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function flightDurationHours(flight) {
  const dep = flight.actualDeparture || flight.scheduledDeparture;
  const arr = flight.actualArrival || flight.scheduledArrival;
  if (!dep || !arr) return null;
  const ms = new Date(arr).getTime() - new Date(dep).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms / 3600000;
}

function formatMiles(miles) {
  return Math.round(miles).toLocaleString();
}

function formatHours(totalHours) {
  const h = Math.floor(totalHours);
  const m = Math.round((totalHours - h) * 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function airportLabel(code) {
  const known = lookupAirport(code, code);
  return known?.city || known?.name || code;
}

function computeStats(flights) {
  const airportCodes = new Set();
  const countryCodes = new Set();
  const airlineCounts = new Map();
  const airportVisitCounts = new Map();
  const routeCounts = new Map();

  let totalMiles = 0;
  let totalHours = 0;
  let hoursKnown = false;
  let longest = null;
  let firstFlight = null;
  let flightsThisYear = 0;
  const thisYear = new Date().getFullYear();

  const touchAirport = (code) => {
    if (!code) return;
    airportCodes.add(code);
    airportVisitCounts.set(code, (airportVisitCounts.get(code) || 0) + 1);
  };

  for (const flight of flights) {
    const originCode = flight.departureIata || flight.departureIcao || "";
    const destCode = flight.arrivalIata || flight.arrivalIcao || "";
    touchAirport(originCode);
    touchAirport(destCode);

    const originCountry = lookupCountry(flight.departureIata, flight.departureIcao);
    const destCountry = lookupCountry(flight.arrivalIata, flight.arrivalIcao);
    if (originCountry) countryCodes.add(originCountry);
    if (destCountry) countryCodes.add(destCountry);

    if (flight.airlineName) {
      airlineCounts.set(flight.airlineName, (airlineCounts.get(flight.airlineName) || 0) + 1);
    }

    if (originCode && destCode) {
      const key = [originCode, destCode].sort().join("|");
      const existing = routeCounts.get(key);
      if (existing) existing.count += 1;
      else routeCounts.set(key, { count: 1, originCode, destCode });
    }

    const originCoord = lookupCoords(flight.departureIata, flight.departureIcao);
    const destCoord = lookupCoords(flight.arrivalIata, flight.arrivalIcao);
    if (originCoord && destCoord) {
      const distance = haversineMiles(originCoord, destCoord);
      totalMiles += distance;
      if (!longest || distance > longest.distance) {
        longest = { distance, originCode, destCode };
      }
    }

    const hours = flightDurationHours(flight);
    if (hours !== null) {
      totalHours += hours;
      hoursKnown = true;
    }

    if (flight.flightDate) {
      if (!firstFlight || flight.flightDate < firstFlight.flightDate) firstFlight = flight;
      if (new Date(flight.flightDate).getFullYear() === thisYear) flightsThisYear += 1;
    }
  }

  let mostFlownAirline = null;
  for (const [name, count] of airlineCounts) {
    if (!mostFlownAirline || count > mostFlownAirline.count) mostFlownAirline = { name, count };
  }

  let mostVisitedAirport = null;
  for (const [code, count] of airportVisitCounts) {
    if (!mostVisitedAirport || count > mostVisitedAirport.count) mostVisitedAirport = { code, count };
  }

  let mostFrequentRoute = null;
  for (const route of routeCounts.values()) {
    if (!mostFrequentRoute || route.count > mostFrequentRoute.count) mostFrequentRoute = route;
  }

  return {
    totalFlights: flights.length,
    totalMiles,
    totalHours,
    hoursKnown,
    airportsVisited: airportCodes.size,
    countriesVisited: countryCodes.size,
    flightsThisYear,
    longest,
    firstFlight,
    mostFlownAirline,
    mostVisitedAirport,
    mostFrequentRoute,
  };
}

function tile(value, label) {
  return `<div class="stat-tile"><div class="stat-value">${value}</div><div class="stat-label">${escapeHtml(label)}</div></div>`;
}

function highlightRow(label, value, sub) {
  return `
    <div class="stat-row">
      <dt>${escapeHtml(label)}</dt>
      <dd>${value}${sub ? `<span class="stat-sub">${sub}</span>` : ""}</dd>
    </div>`;
}

function render() {
  if (!dataReady) return;

  if (latestFlights.length === 0) {
    wrap.hidden = true;
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  wrap.hidden = false;

  const year = new Date().getFullYear();
  const s = computeStats(latestFlights);

  grid.innerHTML = [
    tile(s.totalFlights.toLocaleString(), s.totalFlights === 1 ? "Flight logged" : "Flights logged"),
    tile(formatMiles(s.totalMiles), "Miles flown"),
    tile(s.hoursKnown ? formatHours(s.totalHours) : "—", "Time in the air"),
    tile(s.countriesVisited.toLocaleString(), s.countriesVisited === 1 ? "Country visited" : "Countries visited"),
    tile(s.airportsVisited.toLocaleString(), s.airportsVisited === 1 ? "Airport visited" : "Airports visited"),
    tile(s.flightsThisYear.toLocaleString(), `Flights in ${year}`),
  ].join("");

  const rows = [];
  if (s.longest) {
    rows.push(
      highlightRow("Longest flight", escapeHtml(`${s.longest.originCode} → ${s.longest.destCode}`), `${formatMiles(s.longest.distance)} mi`)
    );
  }
  if (s.mostFlownAirline) {
    rows.push(
      highlightRow(
        "Most flown airline",
        escapeHtml(s.mostFlownAirline.name),
        `${s.mostFlownAirline.count} ${s.mostFlownAirline.count === 1 ? "flight" : "flights"}`
      )
    );
  }
  if (s.mostVisitedAirport) {
    rows.push(
      highlightRow(
        "Most visited airport",
        escapeHtml(`${s.mostVisitedAirport.code} · ${airportLabel(s.mostVisitedAirport.code)}`),
        `${s.mostVisitedAirport.count} visits`
      )
    );
  }
  if (s.mostFrequentRoute && s.mostFrequentRoute.count > 1) {
    rows.push(
      highlightRow(
        "Most frequent route",
        escapeHtml(`${s.mostFrequentRoute.originCode} → ${s.mostFrequentRoute.destCode}`),
        `${s.mostFrequentRoute.count} flights`
      )
    );
  }
  if (s.firstFlight) {
    const origin = s.firstFlight.departureIata || s.firstFlight.departureIcao || "—";
    const dest = s.firstFlight.arrivalIata || s.firstFlight.arrivalIcao || "—";
    rows.push(highlightRow("First flight logged", escapeHtml(`${origin} → ${dest}`), escapeHtml(s.firstFlight.flightDate)));
  }

  highlights.innerHTML = rows.join("");
}

export function updateStats(flights) {
  latestFlights = flights || [];
  render();
}

export async function initStats() {
  await Promise.all([loadAirportCoords(), loadAirportCountries(), loadAirports()]);
  dataReady = true;
  render();
}
