// Automated intelligence: turns the normalised outage feed + forecast grid into callouts.
// All rules are deterministic and documented here so control-room staff can see why a
// callout appeared. Thresholds are indicative and should be tuned with operations.

export const THRESHOLDS = {
  gustElevated: 55, // km/h — vegetation contact / conductor clash risk begins
  gustHigh: 70,
  gustSevere: 90,
  rainHeavy: 10, // mm/h
  outageWindGust: 50, // gust at an outage location to call it "possibly weather-related"
  staleFeedMinutes: 60,
};

// Default network colours, chosen by measuring them against every map condition: dark and
// light base maps, satellite, the weather field at 62% over dark/light maps and Windy's near-
// opaque overlay. No single colour contrasts with all of those on its own, so map lines get a
// dark halo; these colours are bright enough to stay >= ~2.8:1 inside that halo everywhere.
// All pairs stay distinct for normal vision (OKLab dE >= 17) and colour-blind vision
// (protan/deutan/tritan dE >= 8), and none is close to the red used for outage rings.
// AusNet keeps its brand yellow (#ffcb08), which scored best of the brand palette. Jemena
// (lavender) and UE (mint) are assigned so the two greens never share a border.
export const DEFAULT_COLORS = { ausnet: "#ffcb08", powercor: "#87be53", citipower: "#5ccfeb", jemena: "#ba93fb", ue: "#84ffb7" };

export const NETWORKS = {
  // label: network summary box; callout: default spot for the "strongest wind" box (draggable).
  // `color` is replaced at runtime by setNetworkColors().
  ausnet: { name: "AusNet", color: DEFAULT_COLORS.ausnet, label: [-37.15, 147.55], callout: [-39.05, 148.3] },
  powercor: { name: "Powercor", color: DEFAULT_COLORS.powercor, label: [-36.05, 142.75], callout: [-39.05, 141.75] },
  citipower: { name: "CitiPower", color: DEFAULT_COLORS.citipower, label: [-37.8, 144.97], callout: [-39.05, 144.1], metro: true },
  jemena: { name: "Jemena", color: DEFAULT_COLORS.jemena, label: [-37.68, 144.86], callout: [-39.75, 142.9], metro: true },
  ue: { name: "United Energy", color: DEFAULT_COLORS.ue, label: [-38.0, 145.17], callout: [-39.75, 146.1], metro: true },
};

export function setNetworkColors(colors) {
  for (const [net, c] of Object.entries(colors)) if (NETWORKS[net]) NETWORKS[net].color = c;
}

const TOWNS = [
  ["Melbourne", -37.81, 144.96], ["Geelong", -38.15, 144.36], ["Ballarat", -37.56, 143.85], ["Bendigo", -36.76, 144.28],
  ["Shepparton", -36.38, 145.4], ["Wodonga", -36.12, 146.89], ["Wangaratta", -36.36, 146.32], ["Benalla", -36.55, 145.98],
  ["Seymour", -37.03, 145.14], ["Traralgon", -38.2, 146.54], ["Morwell", -38.24, 146.4], ["Moe", -38.18, 146.26],
  ["Sale", -38.1, 147.07], ["Bairnsdale", -37.83, 147.63], ["Lakes Entrance", -37.88, 147.99], ["Orbost", -37.71, 148.46],
  ["Mallacoota", -37.56, 149.75], ["Omeo", -37.1, 147.6], ["Bright", -36.73, 146.96], ["Mount Beauty", -36.74, 147.17],
  ["Mansfield", -37.05, 146.08], ["Alexandra", -37.19, 145.71], ["Healesville", -37.65, 145.52], ["Lilydale", -37.76, 145.35],
  ["Warburton", -37.75, 145.69], ["Pakenham", -38.07, 145.49], ["Warragul", -38.16, 145.93], ["Leongatha", -38.48, 145.95],
  ["Wonthaggi", -38.61, 145.59], ["Foster", -38.65, 146.2], ["Yarram", -38.56, 146.68], ["Cowes", -38.45, 145.24],
  ["Frankston", -38.14, 145.12], ["Mornington", -38.22, 145.04], ["Rosebud", -38.36, 144.9], ["Dandenong", -37.99, 145.21],
  ["Ringwood", -37.81, 145.23], ["Craigieburn", -37.6, 144.94], ["Sunbury", -37.58, 144.73], ["Werribee", -37.9, 144.66],
  ["Melton", -37.68, 144.58], ["Gisborne", -37.49, 144.59], ["Kyneton", -37.25, 144.45], ["Castlemaine", -37.06, 144.22],
  ["Maryborough", -37.05, 143.74], ["Daylesford", -37.35, 144.14], ["Ararat", -37.28, 142.93], ["Stawell", -37.06, 142.78],
  ["Horsham", -36.71, 142.2], ["Nhill", -36.33, 141.65], ["Warracknabeal", -36.25, 142.39], ["Hamilton", -37.74, 142.02],
  ["Portland", -38.34, 141.6], ["Warrnambool", -38.38, 142.48], ["Port Fairy", -38.38, 142.24], ["Colac", -38.34, 143.58],
  ["Camperdown", -38.23, 143.15], ["Apollo Bay", -38.76, 143.67], ["Lorne", -38.54, 143.97], ["Torquay", -38.33, 144.33],
  ["Mildura", -34.19, 142.16], ["Swan Hill", -35.34, 143.55], ["Kerang", -35.73, 143.92], ["Echuca", -36.14, 144.75],
  ["Kyabram", -36.31, 145.05], ["Cobram", -35.92, 145.65], ["Yarrawonga", -36.02, 146.0], ["Corryong", -36.2, 147.9],
  ["Euroa", -36.75, 145.57], ["Kilmore", -37.3, 144.95], ["Wallan", -37.42, 144.98], ["Kinglake", -37.53, 145.35],
  ["Marysville", -37.51, 145.75], ["Heyfield", -37.98, 146.79], ["Maffra", -37.97, 146.98], ["Ouyen", -35.07, 142.32],
  ["St Arnaud", -36.62, 143.26], ["Donald", -36.37, 142.98], ["Edenhope", -37.04, 141.3], ["Casterton", -37.58, 141.4],
  ["Beaufort", -37.43, 143.38], ["Bacchus Marsh", -37.67, 144.44], ["Inverloch", -38.63, 145.73], ["Korumburra", -38.43, 145.82],
  ["Tidal River", -39.03, 146.32], ["Buchan", -37.5, 148.17], ["Dargo", -37.46, 147.25], ["Myrtleford", -36.56, 146.72],
  ["Beechworth", -36.36, 146.69], ["Tallangatta", -36.22, 147.18], ["Rutherglen", -36.05, 146.46], ["Nagambie", -36.79, 145.15],
];

export function nearestTown(lat, lon) {
  let best = null;
  let bestD = Infinity;
  for (const [name, tlat, tlon] of TOWNS) {
    const d = (tlat - lat) ** 2 + ((tlon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
    if (d < bestD) [best, bestD] = [name, d];
  }
  return { name: best, km: Math.sqrt(bestD) * 111 };
}

export function placeLabel(lat, lon) {
  const t = nearestTown(lat, lon);
  return t.km < 8 ? `near ${t.name}` : `${Math.round(t.km)} km from ${t.name}`;
}

// ---- Geometry ---------------------------------------------------------------------------

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function inMultiPolygon(lon, lat, geometry) {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polys.some((poly) => inRing(lon, lat, poly[0]) && !poly.slice(1).some((hole) => inRing(lon, lat, hole)));
}

function bbox(geometry) {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of polys) for (const [x, y] of poly[0]) {
    b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
  }
  return b;
}

// Sample lattice inside each network polygon; small metro networks get a finer lattice so
// they always have samples even though the forecast grid is coarser than them.
export function buildSamplePoints(boundaries) {
  const out = {};
  for (const f of boundaries.features) {
    const [w, s, e, n] = bbox(f.geometry);
    const step = Math.max(0.03, Math.min(0.15, Math.sqrt((e - w) * (n - s)) / 25));
    const pts = [];
    for (let lat = s + step / 2; lat < n; lat += step) {
      for (let lon = w + step / 2; lon < e; lon += step) if (inMultiPolygon(lon, lat, f.geometry)) pts.push([lat, lon]);
    }
    out[f.properties.network] = pts;
  }
  return out;
}

// ---- Forecast field sampling --------------------------------------------------------------

export function sampler(weather) {
  const { lats, lons } = weather.grid;
  const north = lats[0];
  const west = lons[0];
  const stepLat = lats[0] - lats[1];
  const stepLon = lons[1] - lons[0];
  const nx = lons.length;
  return (field, t, lat, lon) => {
    const fy = (north - lat) / stepLat;
    const fx = (lon - west) / stepLon;
    if (fy < 0 || fx < 0 || fy > lats.length - 1 || fx > nx - 1) return null;
    const y0 = Math.min(Math.floor(fy), lats.length - 2);
    const x0 = Math.min(Math.floor(fx), nx - 2);
    const dy = fy - y0;
    const dx = fx - x0;
    const v = weather[field][t];
    const a = v[y0 * nx + x0], b = v[y0 * nx + x0 + 1], c = v[(y0 + 1) * nx + x0], d = v[(y0 + 1) * nx + x0 + 1];
    if ([a, b, c, d].some((x) => x == null)) return null;
    return a * (1 - dx) * (1 - dy) + b * dx * (1 - dy) + c * (1 - dx) * dy + d * dx * dy;
  };
}

export function nowIndex(weather, at = Date.now()) {
  let best = 0;
  weather.times.forEach((t, i) => {
    if (Math.abs(Date.parse(t) - at) < Math.abs(Date.parse(weather.times[best]) - at)) best = i;
  });
  return best;
}

export function strongestWind(weather, samplePoints, t) {
  const sample = sampler(weather);
  const out = {};
  for (const [net, pts] of Object.entries(samplePoints)) {
    let best = null;
    for (const [lat, lon] of pts) {
      const gust = sample("gust", t, lat, lon);
      if (gust != null && (!best || gust > best.gust)) best = { lat, lon, gust, speed: sample("speed", t, lat, lon) };
    }
    if (best) out[net] = { ...best, place: placeLabel(best.lat, best.lon) };
  }
  return out;
}

// Peak forecast conditions per network across the window [from, from + hours).
export function forecastPeaks(weather, samplePoints, from, hours = 24) {
  const sample = sampler(weather);
  const out = {};
  const last = Math.min(weather.times.length - 1, from + hours - 1);
  for (const [net, pts] of Object.entries(samplePoints)) {
    const thin = pts.length > 400 ? pts.filter((_, i) => i % Math.ceil(pts.length / 400) === 0) : pts;
    let gust = null;
    let rain = null;
    for (let t = from; t <= last; t++) {
      for (const [lat, lon] of thin) {
        const g = sample("gust", t, lat, lon);
        const r = sample("rain", t, lat, lon);
        if (g != null && (!gust || g > gust.value)) gust = { value: g, t, lat, lon };
        if (r != null && (!rain || r > rain.value)) rain = { value: r, t, lat, lon };
      }
    }
    out[net] = { gust, rain };
  }
  return out;
}

// ---- Outage clustering ------------------------------------------------------------------

// Greedy screen-space clustering; `project` maps [lat, lon] to pixel {x, y}.
export function clusterIncidents(incidents, project, radiusPx = 48) {
  const clusters = [];
  const sorted = [...incidents].sort((a, b) => b.customers - a.customers);
  for (const inc of sorted) {
    const p = project([inc.lat, inc.lon]);
    const hit = clusters.find((c) => (c.px.x - p.x) ** 2 + (c.px.y - p.y) ** 2 < radiusPx ** 2 && c.network === inc.network);
    if (hit) {
      hit.items.push(inc);
      hit.customers += inc.customers;
    } else {
      clusters.push({ network: inc.network, px: p, items: [inc], customers: inc.customers });
    }
  }
  for (const c of clusters) {
    const w = c.items.reduce((s, i) => s + Math.max(1, i.customers), 0);
    c.lat = c.items.reduce((s, i) => s + i.lat * Math.max(1, i.customers), 0) / w;
    c.lon = c.items.reduce((s, i) => s + i.lon * Math.max(1, i.customers), 0) / w;
  }
  return clusters;
}

// ---- Insights ---------------------------------------------------------------------------

const fmtHour = (iso) => new Intl.DateTimeFormat("en-AU", { weekday: "short", hour: "numeric", timeZone: "Australia/Melbourne" }).format(new Date(iso));

function gustLevel(g) {
  if (g >= THRESHOLDS.gustSevere) return "severe";
  if (g >= THRESHOLDS.gustHigh) return "high";
  if (g >= THRESHOLDS.gustElevated) return "elevated";
  return null;
}

export function buildInsights({ outages, previous, weather, samplePoints }) {
  const insights = [];
  const push = (severity, network, title, detail, at) => insights.push({ severity, network, title, detail, at });

  for (const [net, feed] of Object.entries(outages.networks)) {
    const name = NETWORKS[net]?.name ?? net;
    if (!feed.ok) push("warn", net, `${name} tracker unavailable`, `Showing last good data${feed.fetchedAt ? ` from ${new Date(feed.fetchedAt).toLocaleTimeString("en-AU")}` : ""} (${feed.error}).`);
    else if (feed.sourceTime && Date.now() - Date.parse(feed.sourceTime) > THRESHOLDS.staleFeedMinutes * 60000 && feed.incidents.length) {
      push("info", net, `${name} feed timestamp is ${Math.round((Date.now() - Date.parse(feed.sourceTime)) / 60000)} min old`, "The tracker may not have published recently. Cross-check with the network.");
    }
  }

  // Change since previous refresh.
  if (previous) {
    for (const [net, feed] of Object.entries(outages.networks)) {
      const before = previous.networks[net]?.incidents.filter((i) => i.type === "unplanned") ?? [];
      const now = feed.incidents.filter((i) => i.type === "unplanned");
      const beforeIds = new Set(before.map((i) => i.id));
      const fresh = now.filter((i) => !beforeIds.has(i.id));
      const delta = now.reduce((s, i) => s + i.customers, 0) - before.reduce((s, i) => s + i.customers, 0);
      if (fresh.length) {
        const top = fresh.sort((a, b) => b.customers - a.customers)[0];
        push(delta > 500 ? "high" : "elevated", net, `${NETWORKS[net].name}: ${fresh.length} new unplanned outage${fresh.length > 1 ? "s" : ""}`, `Largest: ${top.place} (${top.customers.toLocaleString()} customers). Net change ${delta >= 0 ? "+" : ""}${delta.toLocaleString()} customers off supply.`, [top.lat, top.lon]);
      } else if (Math.abs(delta) >= 100) {
        push("info", net, `${NETWORKS[net].name}: ${delta > 0 ? "+" : ""}${delta.toLocaleString()} customers off supply since last refresh`, "No new incidents; existing incidents changed size.");
      }
    }
  }

  // Large single incidents.
  for (const feed of Object.values(outages.networks)) {
    for (const inc of feed.incidents) {
      if (inc.type === "unplanned" && inc.customers >= 1000) {
        push("high", inc.network, `${inc.place}: ${inc.customers.toLocaleString()} customers off supply`, `${NETWORKS[inc.network].name} ${inc.id} · ${inc.status}${inc.etr ? ` · ETR ${new Date(inc.etr).toLocaleString("en-AU", { timeZone: "Australia/Melbourne", weekday: "short", hour: "numeric", minute: "2-digit" })}` : " · ETR not available"}.`, [inc.lat, inc.lon]);
      }
    }
  }

  if (weather) {
    const sample = sampler(weather);
    const t0 = nowIndex(weather);

    // Outages in strong wind right now.
    const windy = Object.values(outages.networks).flatMap((f) => f.incidents)
      .filter((i) => i.type === "unplanned")
      .map((i) => ({ ...i, gust: sample("gust", t0, i.lat, i.lon) }))
      .filter((i) => i.gust >= THRESHOLDS.outageWindGust);
    for (const net of new Set(windy.map((i) => i.network))) {
      const list = windy.filter((i) => i.network === net);
      const cust = list.reduce((s, i) => s + i.customers, 0);
      const worst = list.sort((a, b) => b.gust - a.gust)[0];
      push("elevated", net, `${NETWORKS[net].name}: ${list.length} outage${list.length > 1 ? "s" : ""} in ≥${THRESHOLDS.outageWindGust} km/h gusts`, `${cust.toLocaleString()} customers. Likely weather-related — strongest at ${worst.place} (${Math.round(worst.gust)} km/h modelled gust).`, [worst.lat, worst.lon]);
    }

    // Forecast peaks in the next 24 h.
    const peaks = forecastPeaks(weather, samplePoints, t0, 24);
    for (const [net, p] of Object.entries(peaks)) {
      const level = p.gust && gustLevel(p.gust.value);
      if (level) {
        push(level, net, `${NETWORKS[net].name}: gusts to ${Math.round(p.gust.value)} km/h forecast`, `Peak ${fmtHour(weather.times[p.gust.t])}, ${placeLabel(p.gust.lat, p.gust.lon)}. Consider crew pre-positioning and vegetation-risk feeders.`, [p.gust.lat, p.gust.lon]);
      }
      if (p.rain && p.rain.value >= THRESHOLDS.rainHeavy) {
        push("elevated", net, `${NETWORKS[net].name}: heavy rain ${p.rain.value.toFixed(0)} mm/h forecast`, `Peak ${fmtHour(weather.times[p.rain.t])}, ${placeLabel(p.rain.lat, p.rain.lon)}. Flood access and underground asset risk.`, [p.rain.lat, p.rain.lon]);
      }
    }
  }

  const rank = { severe: 0, high: 1, warn: 2, elevated: 3, info: 4 };
  return insights.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
