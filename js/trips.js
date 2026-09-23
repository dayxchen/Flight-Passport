// A "trip" is a run of flights where each new flight departs from an
// airport already touched earlier in the run (a connection, or a leg
// further into a multi-city itinerary) and follows the previous flight
// within TRIP_GAP_MAX_DAYS. That covers simple round trips, multi-leg
// connections, and multi-city itineraries, while keeping unrelated visits
// to the same airport months apart as separate trips.
//
// A trip also closes the moment a flight lands back at the airport the
// trip started from — otherwise a round trip immediately followed by an
// unrelated one that happens to depart from the same home airport within
// the gap window would get merged into a single trip.
const DAY_MS = 24 * 60 * 60 * 1000;
const TRIP_GAP_MAX_DAYS = 21;

function originCode(flight) {
  return flight.departureIata || flight.departureIcao || "";
}

function destCode(flight) {
  return flight.arrivalIata || flight.arrivalIcao || "";
}

function departureTime(flight) {
  const iso = flight.scheduledDeparture || flight.actualDeparture || (flight.flightDate ? `${flight.flightDate}T00:00:00` : null);
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
}

function arrivalTime(flight) {
  const iso = flight.scheduledArrival || flight.actualArrival;
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : departureTime(flight);
}

function buildTrip(legs) {
  const sorted = [...legs].sort((a, b) => departureTime(a) - departureTime(b));
  const dates = sorted.map((f) => f.flightDate).filter(Boolean).sort();

  const routeCodes = [];
  sorted.forEach((flight, i) => {
    if (i === 0) routeCodes.push(originCode(flight) || "—");
    routeCodes.push(destCode(flight) || "—");
  });

  return {
    id: sorted.map((f) => f.id).join("-"),
    flights: sorted,
    startDate: dates[0] || null,
    endDate: dates[dates.length - 1] || null,
    routeCodes,
  };
}

export function groupIntoTrips(flights) {
  const sorted = [...flights].sort((a, b) => departureTime(a) - departureTime(b));

  const trips = [];
  let current = null; // { legs, home, airports, lastArrival, closed }

  for (const flight of sorted) {
    const origin = originCode(flight);
    const dest = destCode(flight);
    const gapDays = current ? (departureTime(flight) - current.lastArrival) / DAY_MS : Infinity;
    const continuesTrip = current && !current.closed && origin && current.airports.has(origin) && gapDays <= TRIP_GAP_MAX_DAYS;

    if (!continuesTrip) {
      if (current) trips.push(buildTrip(current.legs));
      current = { legs: [], home: origin, airports: new Set(), closed: false };
    }

    current.legs.push(flight);
    if (origin) current.airports.add(origin);
    if (dest) current.airports.add(dest);
    current.lastArrival = arrivalTime(flight);
    if (current.home && dest === current.home) current.closed = true;
  }
  if (current) trips.push(buildTrip(current.legs));

  return trips;
}
