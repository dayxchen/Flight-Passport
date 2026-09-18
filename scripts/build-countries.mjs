// Generates data/countries-110m.geojson — a stripped, rounded copy of
// Natural Earth's 1:110m country polygons (as vendored by globe.gl) used to
// draw landmasses on the flight globe. Only properties.name is kept.
//
// Run: node scripts/build-countries.mjs

import { writeFile } from "node:fs/promises";

const SOURCE_URL =
  "https://unpkg.com/globe.gl@2.46.2/example/datasets/ne_110m_admin_0_countries.geojson";
const OUT_PATH = new URL("../data/countries-110m.geojson", import.meta.url);

function roundCoords(coords) {
  if (typeof coords[0] === "number") {
    return [Math.round(coords[0] * 100) / 100, Math.round(coords[1] * 100) / 100];
  }
  return coords.map(roundCoords);
}

async function main() {
  console.log(`Fetching ${SOURCE_URL} ...`);
  const response = await fetch(SOURCE_URL);
  if (!response.ok) throw new Error(`Failed to fetch countries geojson: ${response.status}`);
  const geojson = await response.json();

  geojson.features = geojson.features.map((feature) => ({
    type: feature.type,
    properties: { name: feature.properties.NAME || feature.properties.ADMIN || "" },
    geometry: {
      type: feature.geometry.type,
      coordinates: roundCoords(feature.geometry.coordinates),
    },
  }));

  console.log(`${geojson.features.length} features.`);
  const out = JSON.stringify(geojson);
  await writeFile(OUT_PATH, out);
  console.log(`Wrote ${OUT_PATH.pathname} (${Math.round(out.length / 1024)} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
