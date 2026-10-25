// Server-side adapters for the Victorian distributor outage trackers and the forecast grid.
// Every network is normalised to one incident schema so the client never needs to know
// which tracker a record came from.
//
// Incident: { id, network, type: "unplanned"|"planned", lat, lon, place, customers,
//             status, cause, start, etr, updated, geometry? }

const UA = "Mozilla/5.0 (VicEventIntel; control-room situational awareness)";
const TIMEOUT_MS = 15000;

export const SOURCES = {
  ausnet: "https://outagetrackerservice.ausnetservices.com.au/api/v1/outages/combinedoutage",
  ausnetStats: "https://outagetrackerservice.ausnetservices.com.au/api/v1/outages/stats",
  cppc: "https://s3-ap-southeast-2.amazonaws.com/cppc-outage/outages.json",
  jemena: "https://poweroutages.jemena.com.au/data/all-outages.json",
  ue: "https://ds5ykmduea4ri.cloudfront.net/outages-v2.json",
};

// The static JSON feeds sit behind CDNs that otherwise serve copies hours old; the
// trackers' own pages append a timestamp in the same way.
async function getJson(url, { bust = false } = {}) {
  if (bust) url = `${url}${url.includes("?") ? "&" : "?"}version=${Date.now()}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Melbourne wall-clock time -> ISO string with the correct AEST/AEDT offset.
function melbourneIso(y, mo, d, h = 0, mi = 0) {
  if (![y, mo, d, h, mi].every(Number.isFinite)) return null;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsetMin = (utcMs) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        .formatToParts(new Date(utcMs))
        .map((p) => [p.type, p.value]),
    );
    return (Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) - utcMs) / 60000;
  };
  const offset = offsetMin(guess - offsetMin(guess) * 60000);
  return new Date(guess - offset * 60000).toISOString();
}

// "2026-10-25 02:00PM" | "2026-10-25 14:52:02.54 Australia/Melbourne" | "2026-10-25T14:30:00"
function parseLocal(value) {
  if (!value) return null;
  if (/(Z|[+-]\d{2}:\d{2})$/.test(value)) return new Date(value).toISOString();
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(AM|PM)?/i);
  if (!m) return null;
  let h = +m[4];
  if (m[6]) h = (h % 12) + (/pm/i.test(m[6]) ? 12 : 0);
  return melbourneIso(+m[1], +m[2], +m[3], h, +m[5]);
}

// Powercor/CitiPower "13:30 25-10-2026"
function parseCppc(value) {
  const m = String(value ?? "").match(/^(\d{1,2}):(\d{2})\s+(\d{2})-(\d{2})-(\d{4})/);
  return m ? melbourneIso(+m[5], +m[4], +m[3], +m[1], +m[2]) : null;
}

const title = (s) => String(s ?? "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

async function ausnet() {
  const [list, stats] = await Promise.all([getJson(SOURCES.ausnet), getJson(SOURCES.ausnetStats).catch(() => null)]);
  const incidents = [];
  for (const x of list.data ?? []) {
    if (/complete|cancel/i.test(x.incidentStatus) || /RESTORED|CANCELLED/.test(x.status)) continue;
    const unplanned = x.type === "Unplanned";
    // Planned work is only "off supply" once it is under way.
    if (!unplanned && !/in progress|delog/i.test(x.incidentStatus)) continue;
    const towns = [...(x.details ?? [])].sort((a, b) => b.customerCount - a.customerCount);
    incidents.push({
      id: x.id,
      network: "ausnet",
      type: unplanned ? "unplanned" : "planned",
      lat: x.latitude,
      lon: x.longitude,
      place: title(towns[0]?.townName) || "Unknown",
      places: towns.map((t) => title(t.townName)),
      customers: towns.reduce((s, t) => s + (t.customerCount || 0), 0),
      status: title(x.status || x.incidentStatus),
      cause: x.cause || "",
      start: parseLocal(x.unplannedStartTime || x.plannedStartTime || x.incidentCreated),
      etr: parseLocal(x.latestEstimatedTimeToRestoration || x.plannedEndTime),
      updated: parseLocal(x.incidentLastUpdated || x.statusLastUpdated),
    });
  }
  const sourceTime = incidents.map((i) => i.updated).filter(Boolean).sort().at(-1) ?? null;
  return {
    ausnet: {
      incidents,
      sourceTime,
      headline: stats?.data ? { unplannedOutages: +stats.data.unplannedOutages, unplannedCustomers: +stats.data.unplannedPropertiesAffected } : null,
    },
  };
}

async function cppc() {
  const feed = await getJson(SOURCES.cppc, { bust: true });
  const sourceTime = parseLocal(feed.ROWSET?.createDateTime);
  const out = { powercor: { incidents: [], sourceTime }, citipower: { incidents: [], sourceTime } };
  for (const r of feed.ROWSET?.ROW ?? []) {
    const network = /citipower/i.test(r.BUSINESS) ? "citipower" : "powercor";
    const [lon, lat] = r.centre ?? centroid(r.geometry) ?? [];
    if (!Number.isFinite(lat)) continue;
    out[network].incidents.push({
      id: r.ORDER_ID,
      network,
      type: /planned/i.test(r.CAUSE) ? "planned" : "unplanned",
      lat,
      lon,
      place: title(r.TOWN),
      places: [title(r.TOWN)],
      customers: +r.CUSTOMERS || 0,
      status: r.CREW_STATUS || "",
      cause: r.CAUSE || "",
      start: parseCppc(r.START_TIME),
      etr: parseCppc(r.ETR),
      updated: sourceTime,
      geometry: r.geometry,
    });
  }
  return out;
}

async function jemena() {
  const list = await getJson(SOURCES.jemena, { bust: true });
  const incidents = [];
  for (const x of list) {
    if (x.RestorationTime || /complete/i.test(x.Status) || !x.Location) continue;
    const suburbs = (x.ImpactedSuburbs ?? []).map((s) => title(s.SuburbName));
    incidents.push({
      id: x.EventId,
      network: "jemena",
      type: /planned/i.test(x.Type) ? "planned" : "unplanned",
      lat: x.Location.Latitude,
      lon: x.Location.Longitude,
      place: suburbs[0] || "Unknown",
      places: suburbs,
      customers: x.ImpactedCustomers || 0,
      status: x.Status || "",
      cause: x.Cause || "",
      start: parseLocal(x.StartTime),
      etr: parseLocal(x.LocationGeoJson?.properties?.etr || x.PlannedEndTime),
      updated: parseLocal(x.LastUpdatedTime),
      geometry: x.ImpactedAreaGeoJson?.geometry,
    });
  }
  const sourceTime = list.map((x) => parseLocal(x.LastUpdatedTime)).filter(Boolean).sort().at(-1) ?? null;
  return { jemena: { incidents, sourceTime } };
}

async function ue() {
  const feed = await getJson(SOURCES.ue, { bust: true });
  const incidents = (feed.outages ?? []).map((x) => ({
    id: String(x.outage_id),
    network: "ue",
    type: /planned/i.test(x.outage_type) ? "planned" : "unplanned",
    lat: x.centre?.[1],
    lon: x.centre?.[0],
    place: title(x.suburbs?.[0]) || "Unknown",
    places: (x.suburbs ?? []).map(title),
    customers: x.customers_off || 0,
    status: x.outage_type || "",
    cause: x.cause || "",
    start: null,
    etr: parseLocal(x.etr),
    updated: parseLocal(x.last_updated_time),
    geometry: x.geometry,
  })).filter((i) => Number.isFinite(i.lat));
  const latest = [parseLocal(feed.lastUpdated), ...incidents.map((i) => i.updated)].filter(Boolean).sort().at(-1);
  return { ue: { incidents, sourceTime: latest ?? null } };
}

function centroid(geometry) {
  const ring = geometry?.type === "Polygon" ? geometry.coordinates[0] : geometry?.type === "MultiPolygon" ? geometry.coordinates[0][0] : null;
  if (!ring?.length) return null;
  const sum = ring.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
  return [sum[0] / ring.length, sum[1] / ring.length];
}

const ADAPTERS = { ausnet: [ausnet, ["ausnet"]], cppc: [cppc, ["powercor", "citipower"]], jemena: [jemena, ["jemena"]], ue: [ue, ["ue"]] };

// Last good result per network is kept so a single failed tracker does not blank the map.
const lastGood = {};
let outageCache = null;

export async function getOutages({ maxAgeMs = 60000 } = {}) {
  if (outageCache && Date.now() - outageCache.at < maxAgeMs) return outageCache.body;
  const fetchedAt = new Date().toISOString();
  const results = await Promise.allSettled(Object.values(ADAPTERS).map(([fn]) => fn()));
  const networks = {};
  Object.values(ADAPTERS).forEach(([, nets], i) => {
    const r = results[i];
    for (const net of nets) {
      if (r.status === "fulfilled") {
        lastGood[net] = { ...r.value[net], fetchedAt };
        networks[net] = { ...lastGood[net], ok: true, stale: false };
      } else {
        const error = r.reason?.message ?? String(r.reason);
        networks[net] = lastGood[net] ? { ...lastGood[net], ok: false, stale: true, error } : { incidents: [], ok: false, stale: true, error, sourceTime: null };
      }
    }
  });
  const body = { fetchedAt, networks };
  outageCache = { at: Date.now(), body };
  return body;
}

// ---- Forecast grid (Open-Meteo, ACCESS-G/ECMWF blend via best_match) --------------------

// ~190 points; with a 30 min cache this stays inside Open-Meteo's free 10k calls/day.
const GRID = { south: -40.1, north: -33.6, west: 140.0, east: 150.6, step: 0.65 };
const HOURLY = ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "precipitation", "temperature_2m"];
let weatherCache = null;

export async function getWeather({ maxAgeMs = 30 * 60000 } = {}) {
  if (weatherCache && Date.now() - weatherCache.at < maxAgeMs) return weatherCache.body;
  const lats = [];
  const lons = [];
  for (let lat = GRID.north; lat >= GRID.south - 1e-9; lat -= GRID.step) lats.push(+lat.toFixed(3));
  for (let lon = GRID.west; lon <= GRID.east + 1e-9; lon += GRID.step) lons.push(+lon.toFixed(3));
  const points = lats.flatMap((lat) => lons.map((lon) => [lat, lon]));
  const params = new URLSearchParams({
    latitude: points.map((p) => p[0]).join(","),
    longitude: points.map((p) => p[1]).join(","),
    hourly: HOURLY.join(","),
    wind_speed_unit: "kmh",
    timezone: "Australia/Melbourne",
    past_hours: "3",
    forecast_hours: "48",
    timeformat: "unixtime",
  });
  const res = await fetch("https://api.open-meteo.com/v1/forecast", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: params,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : [data];
  const times = list[0].hourly.time.map((t) => new Date(t * 1000).toISOString());
  const fields = Object.fromEntries(HOURLY.map((k) => [k, times.map((_, ti) => list.map((p) => p.hourly[k][ti] ?? null))]));
  const body = {
    fetchedAt: new Date().toISOString(),
    source: "Open-Meteo forecast API (best_match model blend)",
    grid: { lats, lons },
    times,
    speed: fields.wind_speed_10m,
    direction: fields.wind_direction_10m,
    gust: fields.wind_gusts_10m,
    rain: fields.precipitation,
    temp: fields.temperature_2m,
  };
  weatherCache = { at: Date.now(), body };
  return body;
}
