// Builds approximate distributor service-area polygons for Victoria.
//
// Method:
// 1. The distributors' own "find your distributor" lookup (suburb -> distributor) is joined
//    to ABS ASGS 2021 Suburbs & Localities polygons. Suburbs served by more than one
//    distributor are assigned by a nearest-neighbour vote among the candidates.
// 2. Localities are dissolved per network; specks and thin slivers (parts or holes) left by
//    generalised locality edges are removed.
// 3. The five networks become one topology, so every shared border is a single arc. Arcs are
//    simplified (Visvalingam) and rounded (Chaikin), so neighbours always move together and
//    no gaps or overlaps open up. Junctions where borders meet stay fixed.
//
// The result is for display at state/regional scale; it deliberately trades accuracy in
// the hundreds of metres for smooth edges (the script prints the measured deviation).
//
// Run: npm run build:boundaries          (uses data/.cache/sal.json if present)
//      npm run build:boundaries -- --refetch
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as turf from "@turf/turf";
import { feature } from "topojson-client";
import { topology } from "topojson-server";
import { presimplify, simplify } from "topojson-simplify";

const LOCATOR_URL = "https://ds5ykmduea4ri.cloudfront.net/network-locator.json";
const SAL_URL = "https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/SAL/MapServer/0/query";
const OUT = new URL("../public/data/network-boundaries.geojson", import.meta.url);
const CACHE = new URL("../data/.cache/sal.json", import.meta.url);

// Tuning
const SOURCE_OFFSET_DEG = 0.0003; // ~30 m generalisation of the source localities
const MIN_PART_KM2 = 5; // drop islands/holes smaller than this
const THIN_COMPACTNESS = 0.08; // ...and thin slivers (4πA/P²) smaller than THIN_MAX_KM2
const THIN_MAX_KM2 = 60;
const SIMPLIFY_KM2 = 0.4; // Visvalingam: drop vertices whose triangle is below this area
const CHAIKIN_ITERATIONS = 3;
const FINAL_TOLERANCE_DEG = 0.0004; // ~40 m vertex thinning after smoothing

const NETWORKS = {
  "AUSNET SERVICES": "ausnet",
  POWERCOR: "powercor",
  CITIPOWER: "citipower",
  JEMENA: "jemena",
  "UNITED ENERGY": "ue",
};
const NAMES = { ausnet: "AusNet", powercor: "Powercor", citipower: "CitiPower", jemena: "Jemena", ue: "United Energy" };

const norm = (s) => s.toUpperCase().replace(/\s*\(.*\)\s*/g, "").replace(/[^A-Z ]/g, "").replace(/\s+/g, " ").trim();

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function fetchLocalities() {
  if (!process.argv.includes("--refetch")) {
    try {
      const cached = JSON.parse(await readFile(CACHE, "utf8"));
      console.log(`localities: ${cached.length} (cached)`);
      return cached;
    } catch {
      /* no cache yet */
    }
  }
  const features = [];
  for (let offset = 0; ; offset += 250) {
    const params = new URLSearchParams({
      where: "state_code_2021='2'",
      outFields: "sal_name_2021",
      outSR: "4326",
      maxAllowableOffset: String(SOURCE_OFFSET_DEG),
      geometryPrecision: "5",
      resultOffset: String(offset),
      resultRecordCount: "250",
      orderByFields: "objectid",
      f: "geojson",
    });
    const page = await fetchJson(`${SAL_URL}?${params}`);
    features.push(...page.features.filter((f) => f.geometry));
    process.stdout.write(`\rlocalities: ${features.length}`);
    if (page.features.length < 250) break;
  }
  process.stdout.write("\n");
  await mkdir(new URL(".", CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify(features));
  return features;
}

// ---- 1. Assign localities to networks ---------------------------------------------------

const locator = await fetchJson(LOCATOR_URL);
const candidates = new Map();
for (const row of locator) {
  const net = NETWORKS[row.distributor];
  if (!net) continue;
  const key = norm(row.suburb);
  if (!candidates.has(key)) candidates.set(key, new Set());
  candidates.get(key).add(net);
}

const localities = (await fetchLocalities())
  .map((f) => ({ feature: f, key: norm(f.properties.sal_name_2021), centre: turf.centroid(f).geometry.coordinates }))
  .filter((l) => candidates.has(l.key));

const assigned = localities.filter((l) => candidates.get(l.key).size === 1).map((l) => ({ ...l, net: [...candidates.get(l.key)][0] }));
const shared = localities.filter((l) => candidates.get(l.key).size > 1);

for (const l of shared) {
  const options = candidates.get(l.key);
  const nearest = assigned
    .filter((a) => options.has(a.net))
    .map((a) => ({ net: a.net, d: (a.centre[0] - l.centre[0]) ** 2 + (a.centre[1] - l.centre[1]) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 6);
  const votes = {};
  for (const n of nearest) votes[n.net] = (votes[n.net] ?? 0) + 1 / Math.sqrt(n.d + 1e-6);
  l.net = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? [...options][0];
}

// ---- 2. Dissolve and clean ---------------------------------------------------------------

const km2 = (ring) => turf.area(turf.polygon([ring])) / 1e6;
const compactness = (ring) => {
  const perimeterKm = turf.length(turf.lineString(ring), { units: "kilometers" });
  return (4 * Math.PI * km2(ring)) / perimeterKm ** 2;
};
const keepRing = (ring) => {
  const a = km2(ring);
  return a >= MIN_PART_KM2 && !(a < THIN_MAX_KM2 && compactness(ring) < THIN_COMPACTNESS);
};

const all = [...assigned, ...shared];
const dissolved = {};
for (const net of Object.values(NETWORKS)) {
  const parts = all.filter((l) => l.net === net).map((l) => l.feature);
  process.stdout.write(`${net}: dissolving ${parts.length} localities…`);
  const merged = turf.union(turf.featureCollection(parts));
  const polys = merged.geometry.type === "Polygon" ? [merged.geometry.coordinates] : merged.geometry.coordinates;
  const cleaned = polys.filter((poly) => keepRing(poly[0])).map((poly) => [poly[0], ...poly.slice(1).filter(keepRing)]);
  const dropped = polys.length - cleaned.length + polys.reduce((s, p) => s + p.length - 1, 0) - cleaned.reduce((s, p) => s + p.length - 1, 0);
  console.log(` ${cleaned.length} part(s), ${dropped} speck(s)/sliver(s) removed`);
  dissolved[net] = { type: "Feature", properties: { network: net, localities: parts.length, shared_localities: shared.filter((l) => l.net === net).length }, geometry: { type: "MultiPolygon", coordinates: cleaned } };
}

// ---- 3. Shared-border topology: simplify + smooth --------------------------------------

const KM2_PER_DEG2 = 111.32 * 111.32 * Math.cos((37 * Math.PI) / 180);
let topo = topology({ networks: turf.featureCollection(Object.values(dissolved)) }, 1e6);
topo = presimplify(topo);
topo = simplify(topo, SIMPLIFY_KM2 / KM2_PER_DEG2);

// presimplify returns absolute coordinates with a Visvalingam weight as a third value;
// decode only if the topology is still quantised, then keep [x, y].
if (topo.transform) {
  const { scale, translate } = topo.transform;
  topo.arcs = topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
    });
  });
  delete topo.transform;
}
topo.arcs = topo.arcs.map((arc) => arc.map(([x, y]) => [x, y]));

function chaikin(points, iterations) {
  let pts = points;
  for (let k = 0; k < iterations; k++) {
    if (pts.length < 3) break;
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
    }
    out.push(pts[pts.length - 1]); // arc endpoints (junctions) stay fixed
    pts = out;
  }
  return pts;
}

topo.arcs = topo.arcs.map((arc) => {
  const smooth = chaikin(arc, CHAIKIN_ITERATIONS);
  if (smooth.length < 4) return smooth;
  return turf.simplify(turf.lineString(smooth), { tolerance: FINAL_TOLERANCE_DEG, highQuality: true }).geometry.coordinates;
});

const smoothed = feature(topo, topo.objects.networks);
const features = smoothed.features.map((f) => {
  const net = f.properties.network;
  const geometry = turf.truncate(f.geometry, { precision: 5 });
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return { type: "Feature", properties: { ...f.properties, name: NAMES[net] }, geometry: { type: "MultiPolygon", coordinates: polys } };
});

// ---- Report deviation from the cleaned (unsmoothed) boundaries ---------------------------

for (const f of features) {
  const original = turf.polygonToLine(dissolved[f.properties.network]);
  const lines = original.type === "FeatureCollection" ? original.features : [original];
  const ring = f.geometry.coordinates.flatMap((p) => p.flat());
  const sample = ring.filter((_, i) => i % Math.max(1, Math.floor(ring.length / 300)) === 0);
  const dists = sample
    .map((pt) => Math.min(...lines.map((l) => turf.pointToLineDistance(turf.point(pt), l, { units: "meters" }))))
    .sort((a, b) => a - b);
  const vertices = f.geometry.coordinates.reduce((s, p) => s + p.reduce((q, r) => q + r.length, 0), 0);
  console.log(`${f.properties.network}: ${vertices} vertices · deviation median ${Math.round(dists[dists.length >> 1])} m, p95 ${Math.round(dists[Math.floor(dists.length * 0.95)])} m, max ${Math.round(dists.at(-1))} m`);
}

await mkdir(new URL(".", OUT), { recursive: true });
await writeFile(
  OUT,
  JSON.stringify({
    type: "FeatureCollection",
    metadata: {
      generated: new Date().toISOString(),
      method: "Distributor suburb lookup joined to ABS ASGS 2021 Suburbs & Localities, dissolved per network, slivers removed, then topology-preserving Visvalingam simplification and Chaikin smoothing of shared borders.",
      sources: [LOCATOR_URL, SAL_URL],
      caveat: "Approximate, display-scale boundaries (smoothed; typical deviation tens to a few hundred metres). Suburbs served by more than one distributor are assigned to one network by nearest-neighbour vote. Not an authoritative service boundary.",
    },
    features,
  }),
);
console.log(`wrote ${OUT.pathname}`);
