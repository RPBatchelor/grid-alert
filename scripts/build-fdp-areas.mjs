// Builds council-area polygons for CFA Fire Danger Period (fire restriction) declarations.
//
// CFA declares the Fire Danger Period per municipality (some councils are split into parts
// such as "ARARAT - NORTH"; those part boundaries are only published as PDF maps, so parts are
// shown on their whole council area). Source polygons: Vicmap Lite LGA (DataVic open WFS,
// CC BY), Victorian councils, alpine resorts and unincorporated islands. Converted to one
// topology (shared borders identical) and simplified. Output: public/data/fdp-areas.geojson
//
// Run: npm run build:fdp-areas
import { mkdir, writeFile } from "node:fs/promises";
import * as turf from "@turf/turf";
import { feature } from "topojson-client";
import { topology } from "topojson-server";
import { presimplify, simplify } from "topojson-simplify";

const WFS =
  "https://opendata.maps.vic.gov.au/geoserver/wfs?service=WFS&version=2.0.0&request=GetFeature" +
  "&typeNames=open-data-platform:vmlite_lga&outputFormat=application/json&srsName=EPSG:4326&propertyName=lga_name,state,geom";
const OUT = new URL("../public/data/fdp-areas.geojson", import.meta.url);
const SIMPLIFY_KM2 = 0.8;
const MIN_PART_KM2 = 0.5;

const res = await fetch(WFS);
if (!res.ok) throw new Error(`WFS -> HTTP ${res.status}`);
const src = await res.json();

// Merge multi-feature councils into one MultiPolygon per name (Victoria only).
const byName = new Map();
for (const f of src.features) {
  if (f.properties.state !== "VIC" || !f.geometry) continue;
  const name = f.properties.lga_name;
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  byName.set(name, [...(byName.get(name) ?? []), ...polys]);
}
const merged = turf.featureCollection([...byName].map(([name, coords]) => turf.multiPolygon(coords, { lga: name })));
console.log(`fetched ${merged.features.length} Victorian areas`);

const KM2_PER_DEG2 = 111.32 * 111.32 * Math.cos((37 * Math.PI) / 180);
let topo = topology({ a: merged }, 1e6);
topo = presimplify(topo);
topo = simplify(topo, SIMPLIFY_KM2 / KM2_PER_DEG2);

const features = feature(topo, topo.objects.a)
  .features.map((f) => {
    const polys = (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates).filter((p) => p[0].length >= 4 && turf.area(turf.polygon([p[0]])) / 1e6 >= MIN_PART_KM2);
    if (!polys.length) return null;
    const geometry = turf.truncate({ type: "MultiPolygon", coordinates: polys }, { precision: 4 });
    // A label point guaranteed inside the area (largest part).
    const largest = polys.reduce((a, b) => (turf.area(turf.polygon([b[0]])) > turf.area(turf.polygon([a[0]])) ? b : a));
    const [lon, lat] = turf.pointOnFeature(turf.polygon(largest)).geometry.coordinates;
    return { type: "Feature", properties: { lga: f.properties.lga, label: [+lat.toFixed(4), +lon.toFixed(4)] }, geometry };
  })
  .filter(Boolean);

await mkdir(new URL(".", OUT), { recursive: true });
await writeFile(
  OUT,
  JSON.stringify({
    type: "FeatureCollection",
    metadata: { generated: new Date().toISOString(), source: "Vicmap Lite LGA (DataVic, CC BY). Simplified for display.", url: WFS },
    features,
  }),
);
console.log(`wrote ${features.length} areas to ${OUT.pathname}`);
