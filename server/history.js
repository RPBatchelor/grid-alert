// Outage history in SQLite (Node's built-in node:sqlite, no native dependency).
//
// Every fresh outage fetch is stored as a snapshot: per-network/per-type totals plus an
// incident register (first/last seen, peak customers). A background collector keeps
// snapshots coming while the server runs, even when nobody has the app open.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DB_PATH = resolve(process.env.HISTORY_DB ?? fileURLToPath(new URL("../data/history.sqlite", import.meta.url)));
const MIN_GAP_MS = 50_000; // forced refreshes closer together than this are not stored

let db;
export function open() {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL            -- epoch ms of the fetch
    );
    CREATE INDEX IF NOT EXISTS snapshots_ts ON snapshots (ts);
    CREATE TABLE IF NOT EXISTS totals (
      snapshot_id INTEGER NOT NULL REFERENCES snapshots (id),
      network TEXT NOT NULL,
      type TEXT NOT NULL,            -- unplanned | planned
      outages INTEGER NOT NULL,
      customers INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, network, type)
    );
    CREATE TABLE IF NOT EXISTS incidents (
      network TEXT NOT NULL,
      id TEXT NOT NULL,
      type TEXT NOT NULL,
      place TEXT,
      cause TEXT,
      status TEXT,
      lat REAL,
      lon REAL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      peak_customers INTEGER NOT NULL,
      last_customers INTEGER NOT NULL,
      PRIMARY KEY (network, id)
    );
    CREATE INDEX IF NOT EXISTS incidents_seen ON incidents (last_seen, first_seen);
    -- Per-snapshot state of every incident, so each incident's customers can be traced over time.
    CREATE TABLE IF NOT EXISTS incident_observations (
      snapshot_id INTEGER NOT NULL REFERENCES snapshots (id),
      network TEXT NOT NULL,
      id TEXT NOT NULL,
      customers INTEGER NOT NULL,
      status TEXT,
      PRIMARY KEY (snapshot_id, network, id)
    );
  `);
  return db;
}

// ---- Operations: health, backup, shutdown -------------------------------------------------

export function lastSnapshotTs() {
  return open().prepare("SELECT MAX(ts) AS ts FROM snapshots").get().ts ?? null;
}

// Consistent copy of the live database (safe while the server is writing), keeping `keep`
// daily files in <data>/backups.
const BACKUP_DIR = resolve(dirname(DB_PATH), "backups");
export function backupDatabase({ keep = 14 } = {}) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne" }).format(new Date());
  const target = resolve(BACKUP_DIR, `history-${day}.sqlite`);
  if (existsSync(target)) return null; // already backed up today
  open().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const old = readdirSync(BACKUP_DIR).filter((f) => /^history-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().slice(0, -keep);
  for (const f of old) rmSync(resolve(BACKUP_DIR, f));
  return target;
}

// ---- Database health for the admin page ---------------------------------------------------

const fileSize = (f) => {
  try {
    return statSync(f).size;
  } catch {
    return 0;
  }
};

// Size, row counts, backups, and gaps in the recorded timeline: collector gaps (no snapshot
// for longer than 2.5 intervals) over all history, plus per-network feed gaps (snapshots
// where a tracker failed) and daily coverage over the last 30 days.
export function databaseStats({ intervalMinutes = 5 } = {}) {
  const d = open();
  const intervalMs = (intervalMinutes > 0 ? intervalMinutes : 5) * 60000;
  const now = Date.now();
  const pragma = (name) => Object.values(d.prepare(`PRAGMA ${name}`).get())[0];
  const tables = d
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map(({ name }) => ({ name, rows: d.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n }));
  const bounds = d.prepare("SELECT MIN(ts) AS first, MAX(ts) AS last, COUNT(*) AS n FROM snapshots").get();

  const threshold = intervalMs * 2.5;
  const gaps = d
    .prepare("SELECT prev AS start, ts AS end FROM (SELECT ts, LAG(ts) OVER (ORDER BY ts) AS prev FROM snapshots) WHERE ts - prev > ? ORDER BY ts DESC")
    .all(threshold);
  // The time since the last snapshot is a gap too, while it is overdue.
  if (bounds.last && now - bounds.last > threshold) gaps.unshift({ start: bounds.last, end: null });
  const missingMs = gaps.reduce((s, g) => s + ((g.end ?? now) - g.start - intervalMs), 0);
  const span = bounds.first ? now - bounds.first : 0;

  // Last 30 days, as rolling 24-hour windows ending now.
  const since = now - 30 * 86400e3;
  const recent = d
    .prepare("SELECT s.ts, group_concat(t.network) AS nets FROM snapshots s LEFT JOIN totals t ON t.snapshot_id = s.id AND t.type = 'unplanned' WHERE s.ts >= ? GROUP BY s.id ORDER BY s.ts")
    .all(since);
  const expectedPerDay = 86400e3 / intervalMs;
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const end = now - i * 86400e3;
    const start = end - 86400e3;
    const before = bounds.first == null || bounds.first > end;
    days.push({ start, end, snapshots: 0, expected: before ? 0 : Math.round(((end - Math.max(start, bounds.first)) / 86400e3) * expectedPerDay) });
  }
  const networks = d.prepare("SELECT DISTINCT network FROM totals").all().map((r) => r.network);
  const feeds = Object.fromEntries(networks.map((n) => [n, { network: n, missing: 0, gaps: 0, longest: null, lastMissing: null, run: null }]));
  for (const { ts, nets } of recent) {
    const day = days[Math.min(29, Math.floor((ts - since) / 86400e3))];
    if (day) day.snapshots++;
    const present = new Set((nets ?? "").split(","));
    for (const f of Object.values(feeds)) {
      if (present.has(f.network)) {
        if (f.run) {
          f.run.end = ts;
          if (!f.longest || f.run.end - f.run.start > f.longest.end - f.longest.start) f.longest = f.run;
          f.run = null;
        }
        continue;
      }
      f.missing++;
      f.lastMissing = ts;
      if (!f.run) {
        f.gaps++;
        f.run = { start: ts, end: null };
      }
    }
  }
  for (const f of Object.values(feeds)) {
    // Still failing at the latest snapshot.
    if (f.run && (!f.longest || now - f.run.start > f.longest.end - f.longest.start)) f.longest = f.run;
    f.failing = !!f.run;
    delete f.run;
  }

  const backups = existsSync(BACKUP_DIR)
    ? readdirSync(BACKUP_DIR)
        .filter((f) => f.endsWith(".sqlite"))
        .sort()
        .reverse()
        .map((file) => ({ file, size: fileSize(resolve(BACKUP_DIR, file)), at: statSync(resolve(BACKUP_DIR, file)).mtimeMs }))
    : [];

  return {
    path: DB_PATH,
    sqliteVersion: d.prepare("SELECT sqlite_version() AS v").get().v,
    size: { db: fileSize(DB_PATH), wal: fileSize(`${DB_PATH}-wal`), free: pragma("freelist_count") * pragma("page_size") },
    tables,
    snapshots: { first: bounds.first, last: bounds.last, count: bounds.n, intervalMinutes, collecting: intervalMinutes > 0 },
    coverage: { span, missingMs, percent: span ? Math.max(0, Math.min(100, 100 * (1 - missingMs / span))) : null },
    gaps: { count: gaps.length, thresholdMs: threshold, longest: gaps.reduce((a, g) => (!a || (g.end ?? now) - g.start > (a.end ?? now) - a.start ? g : a), null), recent: gaps.slice(0, 100) },
    days,
    feeds: Object.values(feeds).map((f) => ({ ...f, snapshots: recent.length })),
    backups,
  };
}

// SQLite's quick consistency check (reads the whole file; a few seconds on a large history).
export function integrityCheck() {
  const started = Date.now();
  const messages = open().prepare("PRAGMA quick_check").all().map((r) => Object.values(r)[0]);
  return { ok: messages.length === 1 && messages[0] === "ok", messages: messages.slice(0, 20), ms: Date.now() - started };
}

export function close() {
  if (!db) return;
  db.close(); // checkpoints the WAL into the main file
  db = null;
}

let lastRecorded = 0;

export function recordSnapshot(body) {
  const ts = Date.parse(body.fetchedAt);
  if (!Number.isFinite(ts) || Math.abs(ts - lastRecorded) < MIN_GAP_MS) return false;
  const d = open();
  const insertTotal = d.prepare("INSERT INTO totals (snapshot_id, network, type, outages, customers) VALUES (?, ?, ?, ?, ?)");
  const upsertIncident = d.prepare(`
    INSERT INTO incidents (network, id, type, place, cause, status, lat, lon, first_seen, last_seen, peak_customers, last_customers)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (network, id) DO UPDATE SET
      type = excluded.type, place = excluded.place, cause = excluded.cause, status = excluded.status,
      last_seen = excluded.last_seen, last_customers = excluded.last_customers,
      peak_customers = MAX(incidents.peak_customers, excluded.peak_customers)`);
  const insertObservation = d.prepare("INSERT OR REPLACE INTO incident_observations (snapshot_id, network, id, customers, status) VALUES (?, ?, ?, ?, ?)");
  d.exec("BEGIN");
  try {
    const { lastInsertRowid: snap } = d.prepare("INSERT INTO snapshots (ts) VALUES (?)").run(ts);
    for (const [network, feed] of Object.entries(body.networks)) {
      // A failed tracker is a gap, not zero customers off supply.
      if (!feed.ok) continue;
      for (const type of ["unplanned", "planned"]) {
        const list = feed.incidents.filter((i) => i.type === type);
        insertTotal.run(snap, network, type, list.length, list.reduce((s, i) => s + i.customers, 0));
      }
      for (const i of feed.incidents) {
        upsertIncident.run(network, i.id, i.type, i.place ?? null, i.cause ?? null, i.status ?? null, i.lat ?? null, i.lon ?? null, ts, ts, i.customers, i.customers);
        insertObservation.run(snap, network, i.id, i.customers, i.status ?? null);
      }
    }
    d.exec("COMMIT");
    lastRecorded = ts;
    return true;
  } catch (error) {
    d.exec("ROLLBACK");
    throw error;
  }
}

// Bucketed series for the trends view. Each bucket is represented by one real snapshot:
// the one where the selected series' total was highest, so peaks are kept and the stack
// always adds up to a moment that actually happened.
export function getHistory({ from, to, bucketMs, networks, types, metric = "customers" }) {
  const d = open();
  const bounds = d.prepare("SELECT MIN(ts) AS first, MAX(ts) AS last, COUNT(*) AS n FROM snapshots").get();
  to = to ?? Date.now();
  from = from ?? bounds.first ?? to - 86_400_000;
  bucketMs = Math.max(60_000, bucketMs ?? Math.ceil((to - from) / 150));
  const col = metric === "outages" ? "outages" : "customers";
  const rows = d
    .prepare(`SELECT s.ts, t.network, t.type, t.${col} AS value FROM snapshots s JOIN totals t ON t.snapshot_id = s.id WHERE s.ts BETWEEN ? AND ? ORDER BY s.ts`)
    .all(from, to);

  const wantNet = new Set(networks);
  const wantType = new Set(types);
  const snaps = new Map(); // ts -> { values: {net|type: v}, total }
  for (const r of rows) {
    let s = snaps.get(r.ts);
    if (!s) snaps.set(r.ts, (s = { values: {}, total: 0 }));
    s.values[`${r.network}|${r.type}`] = r.value;
    if (wantNet.has(r.network) && wantType.has(r.type)) s.total += r.value;
  }

  const start = Math.floor(from / bucketMs) * bucketMs;
  const buckets = [];
  for (let t = start; t <= to; t += bucketMs) buckets.push({ start: t, end: t + bucketMs, rep: null, repTs: null, snapshots: 0 });
  for (const [ts, s] of snaps) {
    const b = buckets[Math.floor((ts - start) / bucketMs)];
    if (!b) continue;
    b.snapshots++;
    if (!b.rep || s.total > b.rep.total) [b.rep, b.repTs] = [s, ts];
  }

  const series = {};
  for (const n of networks) for (const t of types) series[`${n}|${t}`] = buckets.map((b) => b.rep?.values[`${n}|${t}`] ?? null);
  const totals = buckets.map((b) => (b.rep ? b.rep.total : null));
  let peak = null;
  buckets.forEach((b, i) => {
    if (totals[i] != null && (!peak || totals[i] > peak.value)) peak = { value: totals[i], ts: b.repTs };
  });

  return {
    from,
    to,
    bucketMs,
    metric,
    buckets: buckets.map((b) => ({ start: b.start, at: b.repTs, snapshots: b.snapshots })),
    series,
    totals,
    peak,
    coverage: { first: bounds.first, last: bounds.last, snapshots: bounds.n, inRange: snaps.size },
  };
}

export function getIncidents({ from, to, networks, types, limit = 200 }) {
  const d = open();
  to = to ?? Date.now();
  from = from ?? 0;
  const nets = networks.map(() => "?").join(",") || "''";
  const tys = types.map(() => "?").join(",") || "''";
  const where = `first_seen <= ? AND last_seen >= ? AND network IN (${nets}) AND type IN (${tys})`;
  const args = [to, from, ...networks, ...types];
  return {
    total: d.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE ${where}`).get(...args).n,
    rows: d.prepare(`SELECT * FROM incidents WHERE ${where} ORDER BY peak_customers DESC, first_seen DESC LIMIT ?`).all(...args, limit),
  };
}

export const historyPath = DB_PATH;
