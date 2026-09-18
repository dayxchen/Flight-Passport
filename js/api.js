import {
  AVIATIONSTACK_API_KEY,
  AVIATIONSTACK_FLIGHTS_URL,
} from "./config.js";
import { loadAirports, lookupAirport, resolveAirport } from "./airports.js";

const DATE_FILTER_STORAGE_KEY = "flightPassport.aviationstackDateFilter";

function formatTime(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function mapAircraft(raw) {
  const aircraft = raw.aircraft || {};
  return {
    aircraftRegistration: aircraft.registration || "",
    aircraftType: aircraft.iata || aircraft.icao || "",
    aircraftIcao24: (aircraft.icao24 || "").toUpperCase(),
  };
}

function mapFlight(raw) {
  const departure = resolveAirport(raw.departure);
  const arrival = resolveAirport(raw.arrival);
  const airline = raw.airline || {};
  const flight = raw.flight || {};
  const aircraft = mapAircraft(raw);

  return {
    flightDate: raw.flight_date || "",
    airlineName: airline.name || "Unknown airline",
    flightNumber: flight.iata || flight.icao || flight.number || "",
    departureAirport: departure.name,
    departureIata: departure.iata,
    departureIcao: departure.icao,
    arrivalAirport: arrival.name,
    arrivalIata: arrival.iata,
    arrivalIcao: arrival.icao,
    scheduledDeparture: raw.departure?.scheduled || null,
    actualDeparture: raw.departure?.actual || null,
    scheduledArrival: raw.arrival?.scheduled || null,
    actualArrival: raw.arrival?.actual || null,
    status: raw.flight_status || "unknown",
    source: "aviationstack",
    ...aircraft,
  };
}

export function displayTime(iso) {
  return formatTime(iso) || "—";
}

export function normalizeFlightNumber(value) {
  return value.replace(/\s+/g, "").toUpperCase();
}

export function parseFlightNumber(value) {
  const flightIata = normalizeFlightNumber(value);
  const match = flightIata.match(/^([A-Z]{3}|[A-Z]{2}|[A-Z]\d|\d[A-Z])(\d{1,4}[A-Z]?)$/);
  if (!match) {
    return { flightIata, airline: "", number: "", airlineKind: "" };
  }
  const airline = match[1];
  const number = match[2].replace(/^0+/, "") || match[2];
  return {
    flightIata,
    airline,
    number,
    airlineKind: airline.length === 3 ? "icao" : "iata",
  };
}

function isDateFilterRestricted(error) {
  const code = error?.code || "";
  const message = `${error?.info || ""} ${error?.message || ""}`.toLowerCase();
  return (
    code === "function_access_restricted" ||
    message.includes("subscription") ||
    message.includes("historical")
  );
}

function readDateFilterSupported() {
  try {
    const stored = localStorage.getItem(DATE_FILTER_STORAGE_KEY);
    if (stored === "restricted") return false;
    if (stored === "ok") return true;
  } catch {
    // ignore
  }
  return true;
}

function writeDateFilterSupported(value) {
  try {
    localStorage.setItem(DATE_FILTER_STORAGE_KEY, value ? "ok" : "restricted");
  } catch {
    // ignore
  }
}

function flightIdentifiers(item) {
  const codes = new Set();
  const flight = item.flight || {};
  const airline = item.airline || {};
  const add = (value) => {
    if (value) codes.add(String(value).replace(/\s+/g, "").toUpperCase());
  };

  add(flight.iata);
  add(flight.icao);
  add(flight.codeshared?.flight_iata);
  add(flight.codeshared?.flight_icao);
  if (airline.iata && flight.number) add(`${airline.iata}${flight.number}`);
  if (airline.icao && flight.number) add(`${airline.icao}${flight.number}`);
  return codes;
}

function sameFlightNumber(item, parsed) {
  const ids = flightIdentifiers(item);
  if (ids.has(parsed.flightIata)) return true;
  const apiNumber = String(item.flight?.number || "").replace(/^0+/, "");
  const airlineIata = (item.airline?.iata || "").toUpperCase();
  const airlineIcao = (item.airline?.icao || "").toUpperCase();
  if (apiNumber && apiNumber === parsed.number) {
    if (parsed.airlineKind === "iata" && airlineIata === parsed.airline) return true;
    if (parsed.airlineKind === "icao" && airlineIcao === parsed.airline) return true;
  }
  return false;
}

function shiftDate(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00`);
  date.setDate(date.getDate() + days);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().slice(0, 10);
}

function pickMatchingFlight(results, parsed, flightDate) {
  const sameNumber = results.filter((item) => sameFlightNumber(item, parsed));
  const candidateDates = [flightDate, shiftDate(flightDate, -1), shiftDate(flightDate, 1)];

  for (const date of candidateDates) {
    const match = sameNumber.find((item) => item.flight_date === date);
    if (match) return match;
  }
  return null;
}

function availableDates(results, parsed) {
  return [...new Set(results.filter((item) => sameFlightNumber(item, parsed)).map((item) => item.flight_date))].sort();
}

let dateFilterSupported = readDateFilterSupported();

async function fetchFlights(params) {
  const url = new URL(AVIATIONSTACK_FLIGHTS_URL);
  url.searchParams.set("access_key", AVIATIONSTACK_API_KEY);
  url.searchParams.set("limit", "100");
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });

  let response;
  try {
    response = await fetch(url.toString());
  } catch {
    throw new Error("Could not reach AviationStack. Check your connection and try again.");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("AviationStack returned an unexpected response.");
  }

  return payload;
}

function liveQueryParams(parsed) {
  if (parsed.airline && parsed.number) {
    if (parsed.airlineKind === "icao") {
      return { airline_icao: parsed.airline, flight_number: parsed.number };
    }
    return { airline_iata: parsed.airline, flight_number: parsed.number };
  }
  return { flight_iata: parsed.flightIata };
}

async function enrichAircraft(flight) {
  if ((flight.aircraftRegistration && flight.aircraftType) || !flight.aircraftIcao24) {
    return flight;
  }

  try {
    const response = await fetch(`https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(flight.aircraftIcao24)}`);
    if (!response.ok) return flight;
    const payload = await response.json();
    const aircraft = payload.response?.aircraft || {};
    return {
      ...flight,
      aircraftRegistration: flight.aircraftRegistration || aircraft.registration || "",
      aircraftType: flight.aircraftType || aircraft.type || aircraft.icao_type || "",
    };
  } catch {
    return flight;
  }
}

export async function lookupFlight(flightNumber, flightDate) {
  await loadAirports();
  const parsed = parseFlightNumber(flightNumber);
  const today = new Date();
  const todayIso = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const isPast = flightDate < todayIso;

  let payload;

  if (isPast && dateFilterSupported) {
    payload = await fetchFlights({
      ...liveQueryParams(parsed),
      flight_date: flightDate,
    });
    if (payload.error && isDateFilterRestricted(payload.error)) {
      dateFilterSupported = false;
      writeDateFilterSupported(false);
      payload = await fetchFlights(liveQueryParams(parsed));
    } else if (!payload.error) {
      writeDateFilterSupported(true);
    }
  } else {
    payload = await fetchFlights(liveQueryParams(parsed));
  }

  if (payload.error) {
    throw new Error(payload.error.info || payload.error.message || "AviationStack request failed.");
  }

  const results = Array.isArray(payload.data) ? payload.data : [];
  const sameNumber = results.filter((item) => sameFlightNumber(item, parsed));
  const match = pickMatchingFlight(results, parsed, flightDate);
  if (!match) {
    return {
      notFound: true,
      flight: null,
      availableDates: availableDates(results, parsed),
      airlineName: sameNumber[0]?.airline?.name || "",
    };
  }

  return { notFound: false, flight: await enrichAircraft(mapFlight(match)), availableDates: [] };
}

export function combineDateAndTime(flightDate, timeValue, { afterIso } = {}) {
  if (!flightDate || !timeValue) return null;
  const date = new Date(`${flightDate}T${timeValue}`);
  if (Number.isNaN(date.getTime())) return null;
  if (afterIso) {
    const after = new Date(afterIso);
    if (!Number.isNaN(after.getTime()) && date.getTime() <= after.getTime()) {
      date.setDate(date.getDate() + 1);
    }
  }
  return date.toISOString();
}

export function buildManualFlight({
  flightNumber,
  flightDate,
  origin,
  destination,
  status = "landed",
  airlineName = "",
  scheduledDeparture = "",
  actualDeparture = "",
  scheduledArrival = "",
  actualArrival = "",
}) {
  const parsed = parseFlightNumber(flightNumber);
  const originInfo = lookupAirport(origin, origin);
  const destInfo = lookupAirport(destination, destination);

  if (!originInfo?.iata && !originInfo?.icao) {
    throw new Error(`Unknown origin airport code: ${origin.toUpperCase()}`);
  }
  if (!destInfo?.iata && !destInfo?.icao) {
    throw new Error(`Unknown destination airport code: ${destination.toUpperCase()}`);
  }

  const scheduledDepIso = combineDateAndTime(flightDate, scheduledDeparture);
  const actualDepIso = combineDateAndTime(flightDate, actualDeparture);
  const depAnchor = actualDepIso || scheduledDepIso;

  return {
    flightDate,
    airlineName: airlineName || parsed.airline || "Unknown airline",
    flightNumber: parsed.flightIata,
    departureAirport: originInfo.name,
    departureIata: originInfo.iata,
    departureIcao: originInfo.icao,
    arrivalAirport: destInfo.name,
    arrivalIata: destInfo.iata,
    arrivalIcao: destInfo.icao,
    scheduledDeparture: scheduledDepIso,
    actualDeparture: actualDepIso,
    scheduledArrival: combineDateAndTime(flightDate, scheduledArrival, { afterIso: scheduledDepIso }),
    actualArrival: combineDateAndTime(flightDate, actualArrival, { afterIso: depAnchor }),
    status,
    source: "manual",
    aircraftRegistration: "",
    aircraftType: "",
    aircraftIcao24: "",
  };
}
