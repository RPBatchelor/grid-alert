// Builds the CFA fire district (Total Fire Ban district) polygons for the map.
//
// Source: Vicmap Admin – CFA Total Fire Ban District Polygon (DataVic open WFS, CC BY).
// These are the 9 districts used for Fire Danger Ratings and Total Fire Bans. The source is
// ~6 MB at cadastral detail, so the districts are converted to one topology (shared borders
// stay identical) and simplified for display. Output: public/data/fire-districts.geojson
//
// Run: npm run build:fire-districts
import { mkdir, writeFile } from "node:fs/promises";
import * as turf from "@turf/turf";
import { feature } from "topojson-client";
import { topology } from "topojson-server";
import { presimplify, simplify } from "topojson-simplify";

const WFS =
  "https://opendata.maps.vic.gov.au/geoserver/wfs?service=WFS&version=2.0.0&request=GetFeature" +
  "&typeNames=open-data-platform:cfa_tfb_district&outputFormat=application/json&srsName=EPSG:4326";
const OUT = new URL("../public/data/fire-districts.geojson", import.meta.url);
const SIMPLIFY_KM2 = 0.25; // Visvalingam area threshold
const MIN_PART_KM2 = 3; // drop small islands

// Names as used in the CFA RSS feed.
const title = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bAnd\b/, "and");

const res = await fetch(WFS);
if (!res.ok) throw new Error(`WFS -> HTTP ${res.status}`);
const src = await res.json();
console.log(`fetched ${src.features.length} districts`);

const KM2_PER_DEG2 = 111.32 * 111.32 * Math.cos((37 * Math.PI) / 180);
let topo = topology({ d: src }, 1e6);
topo = presimplify(topo);
topo = simplify(topo, SIMPLIFY_KM2 / KM2_PER_DEG2);

const features = feature(topo, topo.objects.d).features.map((f) => {
  const polys = (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates).filter((p) => p[0].length >= 4 && turf.area(turf.polygon([p[0]])) / 1e6 >= MIN_PART_KM2);
  const geometry = turf.truncate({ type: "MultiPolygon", coordinates: polys }, { precision: 4 });
  const name = title(f.properties.tfb_district);
  return { type: "Feature", properties: { district: name, ufi: f.properties.ufi }, geometry };
});

for (const f of features) {
  let n = 0;
  turf.coordEach(f, () => n++);
  console.log(`  ${f.properties.district}: ${n} points`);
}

await mkdir(new URL(".", OUT), { recursive: true });
await writeFile(
  OUT,
  JSON.stringify({
    type: "FeatureCollection",
    metadata: {
      generated: new Date().toISOString(),
      source: "Vicmap Admin – CFA Total Fire Ban District Polygon (DataVic, CC BY). Simplified for display.",
      url: WFS,
    },
    features,
  }),
);
console.log(`wrote ${OUT.pathname}`);
