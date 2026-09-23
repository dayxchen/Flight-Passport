// Generates data/airport-coords.json (a lat/lon lookup) and
// data/airport-country.json (an ISO country code lookup), both keyed by IATA
// and ICAO codes, joined from the public-domain OurAirports dataset against
// the airport codes already present in data/airports.json.
//
// Run: node scripts/build-airport-coords.mjs

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CSV_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const COORDS_OUT_PATH = new URL("../data/airport-coords.json", import.meta.url);
const COUNTRY_OUT_PATH = new URL("../data/airport-country.json", import.meta.url);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function main() {
  const airportsRaw = await readFile(new URL("../data/airports.json", import.meta.url), "utf8");
  const airports = JSON.parse(airportsRaw);

  const uniqueAirports = new Map();
  for (const record of Object.values(airports)) {
    uniqueAirports.set(`${record.i || ""}|${record.o || ""}`, record);
  }

  console.log(`Fetching ${CSV_URL} ...`);
  const response = await fetch(CSV_URL);
  if (!response.ok) throw new Error(`Failed to fetch OurAirports CSV: ${response.status}`);
  const csvText = await response.text();

  const rows = parseCsv(csvText);
  const header = rows[0];
  const col = Object.fromEntries(header.map((name, idx) => [name, idx]));

  const coordsByCode = new Map();
  const countryByCode = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < header.length) continue;
    const lat = Number.parseFloat(row[col.latitude_deg]);
    const lon = Number.parseFloat(row[col.longitude_deg]);
    const country = (row[col.iso_country] || "").trim().toUpperCase();
    const point = Number.isFinite(lat) && Number.isFinite(lon)
      ? [Math.round(lat * 1000) / 1000, Math.round(lon * 1000) / 1000]
      : null;
    for (const key of [row[col.iata_code], row[col.icao_code], row[col.ident], row[col.gps_code]]) {
      const code = (key || "").trim().toUpperCase();
      if (!code) continue;
      if (point && !coordsByCode.has(code)) coordsByCode.set(code, point);
      if (country && !countryByCode.has(code)) countryByCode.set(code, country);
    }
  }

  const coordsOut = {};
  const countryOut = {};
  let matched = 0;
  for (const record of uniqueAirports.values()) {
    const iata = (record.i || "").toUpperCase();
    const icao = (record.o || "").toUpperCase();
    const point = coordsByCode.get(iata) || coordsByCode.get(icao);
    const country = countryByCode.get(iata) || countryByCode.get(icao);
    if (!point && !country) continue;
    matched++;
    if (point) {
      if (iata) coordsOut[iata] = point;
      if (icao) coordsOut[icao] = point;
    }
    if (country) {
      if (iata) countryOut[iata] = country;
      if (icao) countryOut[icao] = country;
    }
  }

  const coordsKeyCount = Object.keys(coordsOut).length;
  console.log(`Matched ${matched} / ${uniqueAirports.size} unique airports (${coordsKeyCount} coord keys).`);
  if (coordsKeyCount < 15000) {
    throw new Error(`Expected ~15,598 coord keys, got ${coordsKeyCount} — dataset or parser likely changed.`);
  }

  await writeFile(COORDS_OUT_PATH, JSON.stringify(coordsOut));
  console.log(`Wrote ${COORDS_OUT_PATH.pathname}`);

  const countryKeyCount = Object.keys(countryOut).length;
  await writeFile(COUNTRY_OUT_PATH, JSON.stringify(countryOut));
  console.log(`Wrote ${COUNTRY_OUT_PATH.pathname} (${countryKeyCount} keys)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
