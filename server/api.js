import { HttpError, createEvent, deleteEvent, getEvent, listEvents, stopEvent, updateEvent } from "./events.js";
import { exportEventXlsx } from "./exportEvent.js";
import { getOutages, getWeather } from "./feeds.js";
import { getHistory, getIncidents, historyPath, recordSnapshot } from "./history.js";

// Fetch outages and store each fresh result in the history database.
async function outages(maxAgeMs) {
  const body = await getOutages({ maxAgeMs });
  try {
    recordSnapshot(body);
  } catch (error) {
    console.error("History write failed:", error);
  }
  return body;
}

const ALL_NETWORKS = ["ausnet", "powercor", "citipower", "jemena", "ue"];
const list = (url, key, all) => (url.searchParams.has(key) ? url.searchParams.get(key).split(",").filter((x) => all.includes(x)) : all);
const time = (url, key) => (url.searchParams.has(key) ? Number(url.searchParams.get(key)) : undefined);

// [method, path pattern, handler(url, body, params)]
const ROUTES = [
  ["GET", /^\/api\/outages$/, (url) => outages(url.searchParams.has("force") ? 15000 : 60000)],
  ["GET", /^\/api\/weather$/, () => getWeather()],
  [
    "GET",
    /^\/api\/history$/,
    (url) =>
      getHistory({
        from: time(url, "from"),
        to: time(url, "to"),
        bucketMs: time(url, "bucket"),
        networks: list(url, "networks", ALL_NETWORKS),
        types: list(url, "types", ["unplanned", "planned"]),
        metric: url.searchParams.get("metric") === "outages" ? "outages" : "customers",
      }),
  ],
  [
    "GET",
    /^\/api\/incidents$/,
    (url) =>
      getIncidents({
        from: time(url, "from"),
        to: time(url, "to"),
        networks: list(url, "networks", ALL_NETWORKS),
        types: list(url, "types", ["unplanned", "planned"]),
        limit: Math.min(5000, time(url, "limit") ?? 200),
      }),
  ],
  [
    "GET",
    /^\/api\/events$/,
    (url) =>
      listEvents({
        q: url.searchParams.get("q")?.trim() || undefined,
        category: url.searchParams.get("category") || undefined,
        status: url.searchParams.get("status") || undefined,
        from: time(url, "from"),
        to: time(url, "to"),
      }),
  ],
  ["POST", /^\/api\/events$/, (url, body) => createEvent(body)],
  ["GET", /^\/api\/events\/(\d+)$/, (url, body, [id]) => getEvent(+id)],
  ["PATCH", /^\/api\/events\/(\d+)$/, (url, body, [id]) => updateEvent(+id, body)],
  ["DELETE", /^\/api\/events\/(\d+)$/, (url, body, [id]) => deleteEvent(+id)],
  ["POST", /^\/api\/events\/(\d+)\/stop$/, (url, body, [id]) => stopEvent(+id, body)],
  // Binary download: handlers may return { file: { buffer, filename, type } }.
  ["GET", /^\/api\/events\/(\d+)\/export\.xlsx$/, async (url, body, [id]) => ({ file: { ...(await exportEventXlsx(+id)), type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } })],
];

async function readJson(req) {
  if (req.method === "GET" || req.method === "DELETE") return {};
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new HttpError(413, "Request body too large.");
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON body.");
  }
}

// Background collector: keeps history accumulating while the server runs, independent of
// whether anyone has the app open. COLLECT_INTERVAL_MINUTES=0 disables it.
let collector = null;
export function startCollector() {
  if (collector) return;
  const minutes = Number(process.env.COLLECT_INTERVAL_MINUTES ?? 5);
  if (!(minutes > 0)) return;
  const run = () => outages(minutes * 60000 - 5000).catch((error) => console.error("Collector fetch failed:", error.message));
  collector = setInterval(run, minutes * 60000);
  collector.unref?.();
  run();
  console.log(`Outage history: recording every ${minutes} min to ${historyPath}`);
}

// Connect-style middleware: (req, res, next)
export async function apiMiddleware(req, res, next) {
  const url = new URL(req.url, "http://localhost");
  if (!url.pathname.startsWith("/api/")) return next?.();
  const matches = ROUTES.map(([method, pattern, handler]) => ({ method, handler, m: url.pathname.match(pattern) })).filter((r) => r.m);
  if (!matches.length) return next?.();
  const route = matches.find((r) => r.method === req.method);
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (!route) return send(405, { error: `${req.method} not allowed` });
  try {
    const body = await readJson(req);
    const result = await route.handler(url, body, route.m.slice(1));
    if (result?.file) {
      const { buffer, filename, type } = result.file;
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": buffer.length,
        "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
        "Cache-Control": "no-store",
      });
      return res.end(buffer);
    }
    send(200, result);
  } catch (error) {
    if (error instanceof HttpError) return send(error.status, { error: error.message });
    console.error(`${req.method} ${url.pathname} failed:`, error);
    send(502, { error: error.message ?? String(error) });
  }
}
