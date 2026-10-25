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

const ROUTES = {
  "/api/outages": (url) => outages(url.searchParams.has("force") ? 15000 : 60000),
  "/api/weather": () => getWeather(),
  "/api/history": (url) =>
    getHistory({
      from: time(url, "from"),
      to: time(url, "to"),
      bucketMs: time(url, "bucket"),
      networks: list(url, "networks", ALL_NETWORKS),
      types: list(url, "types", ["unplanned", "planned"]),
      metric: url.searchParams.get("metric") === "outages" ? "outages" : "customers",
    }),
  "/api/incidents": (url) =>
    getIncidents({
      from: time(url, "from"),
      to: time(url, "to"),
      networks: list(url, "networks", ALL_NETWORKS),
      types: list(url, "types", ["unplanned", "planned"]),
    }),
};

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
  const route = ROUTES[url.pathname];
  if (!route) return next?.();
  try {
    const body = await route(url);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  } catch (error) {
    console.error(`${url.pathname} failed:`, error);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error.message ?? String(error) }));
  }
}
