let airports = null;
let loadPromise = null;

function expand(record) {
  if (!record) return null;
  return {
    name: record.n,
    city: record.c || "",
    iata: record.i || "",
    icao: record.o || "",
  };
}

export function loadAirports() {
  if (airports) return Promise.resolve(airports);
  if (!loadPromise) {
    loadPromise = fetch("./data/airports.json")
      .then((response) => {
        if (!response.ok) throw new Error("Airport list failed to load");
        return response.json();
      })
      .then((data) => {
        airports = data;
        return airports;
      })
      .catch(() => {
        airports = {};
        return airports;
      });
  }
  return loadPromise;
}

export function lookupAirport(iata, icao) {
  if (!airports) return null;
  const iataKey = (iata || "").toUpperCase();
  const icaoKey = (icao || "").toUpperCase();
  return expand(airports[iataKey] || airports[icaoKey] || null);
}

let coords = null;
let coordsLoadPromise = null;

export function loadAirportCoords() {
  if (coords) return Promise.resolve(coords);
  if (!coordsLoadPromise) {
    coordsLoadPromise = fetch("./data/airport-coords.json")
      .then((response) => {
        if (!response.ok) throw new Error("Airport coordinates failed to load");
        return response.json();
      })
      .then((data) => {
        coords = data;
        return coords;
      })
      .catch(() => {
        coords = {};
        return coords;
      });
  }
  return coordsLoadPromise;
}

export function lookupCoords(iata, icao) {
  if (!coords) return null;
  const iataKey = (iata || "").toUpperCase();
  const icaoKey = (icao || "").toUpperCase();
  return coords[iataKey] || coords[icaoKey] || null;
}

let countries = null;
let countriesLoadPromise = null;

export function loadAirportCountries() {
  if (countries) return Promise.resolve(countries);
  if (!countriesLoadPromise) {
    countriesLoadPromise = fetch("./data/airport-country.json")
      .then((response) => {
        if (!response.ok) throw new Error("Airport country data failed to load");
        return response.json();
      })
      .then((data) => {
        countries = data;
        return countries;
      })
      .catch(() => {
        countries = {};
        return countries;
      });
  }
  return countriesLoadPromise;
}

export function lookupCountry(iata, icao) {
  if (!countries) return null;
  const iataKey = (iata || "").toUpperCase();
  const icaoKey = (icao || "").toUpperCase();
  return countries[iataKey] || countries[icaoKey] || null;
}

export function resolveAirport(endpoint) {
  const raw = endpoint || {};
  const fromApiIata = (raw.iata || "").toUpperCase();
  const fromApiIcao = (raw.icao || "").toUpperCase();
  const known = lookupAirport(fromApiIata, fromApiIcao);

  const iata = fromApiIata || known?.iata || "";
  const icao = fromApiIcao || known?.icao || "";
  const name = raw.airport || known?.name || (iata && known?.city) || "";

  return {
    name: name || (iata ? `${iata} Airport` : icao ? `${icao} Airport` : "Unknown airport"),
    iata,
    icao,
  };
}
