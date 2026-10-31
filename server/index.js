// Production server: serves the built client from dist/ and the /api feed proxy.
// Run: npm run build && npm start
import { setDefaultResultOrder } from "node:dns";
import { createServer } from "node:http";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { apiMiddleware, startCollector, stopCollector } from "./api.js";
import { pageGate } from "./auth.js";
import { close as closeHistory } from "./history.js";

// Outbound connections to hosts with both IPv4 and IPv6 addresses (RainViewer). Node gives each
// address only 250 ms before trying the next; from Melbourne, RainViewer (Germany) takes ~350 ms
// to connect, so every attempt was abandoned and fetch failed with ETIMEDOUT. Allow 2.5 s per
// attempt, and try IPv4 first since Docker's default network has no IPv6 route.
setDefaultAutoSelectFamilyAttemptTimeout(2500);
setDefaultResultOrder("ipv4first");

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".geojson": "application/geo+json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

async function serveStatic(req, res) {
  const gate = pageGate(req, res);
  if (gate === "done") return;
  const path = gate === "login" ? "login.html" : normalize(decodeURIComponent(new URL(req.url, "http://localhost").pathname)).replace(/^([/\\])+/, "");
  let file = join(DIST, path);
  if (!file.startsWith(DIST)) return res.writeHead(403).end();
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
  } catch {
    file = join(DIST, "index.html");
  }
  try {
    const body = await readFile(file);
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    // Pages are never cached, so a signed-out browser can't show the app from cache.
    res.writeHead(200, { "Content-Type": type, ...(type.startsWith("text/html") ? { "Cache-Control": "no-store" } : {}) });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

const server = createServer((req, res) => apiMiddleware(req, res, () => serveStatic(req, res))).listen(PORT, () => {
  console.log(`Grid Alert Victoria on http://localhost:${PORT}`);
  startCollector();
});

// Clean shutdown (docker stop, systemctl stop, Ctrl+C): stop collecting, finish requests and
// close the database so its write-ahead log is folded back into the main file.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  stopCollector();
  server.close(() => {
    closeHistory();
    process.exit(0);
  });
  setTimeout(() => {
    closeHistory();
    process.exit(0);
  }, 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
