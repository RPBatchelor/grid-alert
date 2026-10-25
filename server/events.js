// Events: named time windows over the recorded outage history (e.g. "Thunderstorm – statewide
// 25 October"). Starting an event stores its start time; stopping stores the end. All event
// statistics are computed from the snapshots/incidents recorded in that window.
import { open } from "./history.js";

export const CATEGORIES = ["bushfire", "heatwave", "flood", "storm", "thunderstorm", "lightning", "other"];
const GAP_CAP_MS = 15 * 60000; // when integrating customer-minutes, don't bridge recording gaps

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let ready = false;
function db() {
  const d = open();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_started ON events (started_at);
    `);
    ready = true;
  }
  return d;
}

// ---- Validation --------------------------------------------------------------------------

function clean(input, { partial = false } = {}) {
  const out = {};
  if (!partial || "name" in input) {
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 120) throw new HttpError(400, "Event name is required (up to 120 characters).");
    out.name = name;
  }
  if (!partial || "category" in input) {
    const category = String(input.category ?? "").toLowerCase();
    if (!CATEGORIES.includes(category)) throw new HttpError(400, `Category must be one of: ${CATEGORIES.join(", ")}.`);
    out.category = category;
  }
  if ("notes" in input) out.notes = String(input.notes ?? "").slice(0, 4000);
  for (const key of ["startedAt", "endedAt"]) {
    if (key in input && input[key] != null) {
      const ts = Number(input[key]);
      if (!Number.isFinite(ts)) throw new HttpError(400, `${key} must be a timestamp.`);
      if (ts > Date.now() + 60000) throw new HttpError(400, "Times cannot be in the future.");
      out[key] = ts;
    }
  }
  return out;
}

// ---- Statistics --------------------------------------------------------------------------

function statsFor(start, end) {
  const d = db();
  const rows = d
    .prepare("SELECT s.ts, t.network, t.customers, t.outages FROM snapshots s JOIN totals t ON t.snapshot_id = s.id WHERE s.ts BETWEEN ? AND ? AND t.type = 'unplanned' ORDER BY s.ts")
    .all(start, end);

  const byTs = new Map();
  for (const r of rows) {
    if (!byTs.has(r.ts)) byTs.set(r.ts, {});
    byTs.get(r.ts)[r.network] = r.customers;
  }
  const times = [...byTs.keys()];
  const networks = {};
  let peak = null;
  let customerMinutes = 0;
  times.forEach((ts, i) => {
    const values = byTs.get(ts);
    const total = Object.values(values).reduce((s, v) => s + v, 0);
    if (!peak || total > peak.value) peak = { value: total, ts };
    const dt = i < times.length - 1 ? Math.min(times[i + 1] - ts, GAP_CAP_MS) : 0;
    for (const [net, v] of Object.entries(values)) {
      const n = (networks[net] ??= { peak: 0, peakTs: null, customerMinutes: 0, incidents: 0 });
      if (v > n.peak) [n.peak, n.peakTs] = [v, ts];
      n.customerMinutes += (v * dt) / 60000;
    }
    customerMinutes += (total * dt) / 60000;
  });

  const incidentRows = d
    .prepare("SELECT network, first_seen FROM incidents WHERE type = 'unplanned' AND first_seen <= ? AND last_seen >= ?")
    .all(end, start);
  for (const r of incidentRows) (networks[r.network] ??= { peak: 0, peakTs: null, customerMinutes: 0, incidents: 0 }).incidents++;

  return {
    snapshots: times.length,
    firstSnapshot: times[0] ?? null,
    lastSnapshot: times.at(-1) ?? null,
    peak,
    customerMinutes: Math.round(customerMinutes),
    incidents: incidentRows.length,
    newIncidents: incidentRows.filter((r) => r.first_seen >= start).length,
    networksAffected: Object.values(networks).filter((n) => n.peak > 0).length,
    networks: Object.fromEntries(Object.entries(networks).map(([k, n]) => [k, { ...n, customerMinutes: Math.round(n.customerMinutes) }])),
  };
}

function present(row, withStats = true) {
  const event = {
    id: row.id,
    name: row.name,
    category: row.category,
    notes: row.notes,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    active: row.ended_at == null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (withStats) event.stats = statsFor(row.started_at, row.ended_at ?? Date.now());
  return event;
}

// ---- Operations --------------------------------------------------------------------------

export function listEvents({ q, category, status, from, to } = {}) {
  const where = [];
  const args = [];
  if (q) {
    where.push("(name LIKE ? OR notes LIKE ?)");
    args.push(`%${q}%`, `%${q}%`);
  }
  if (category && CATEGORIES.includes(category)) {
    where.push("category = ?");
    args.push(category);
  }
  if (status === "active") where.push("ended_at IS NULL");
  if (status === "completed") where.push("ended_at IS NOT NULL");
  // Date filters match events that overlap the range.
  if (Number.isFinite(from)) {
    where.push("(ended_at IS NULL OR ended_at >= ?)");
    args.push(from);
  }
  if (Number.isFinite(to)) {
    where.push("started_at <= ?");
    args.push(to);
  }
  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY (ended_at IS NULL) DESC, started_at DESC LIMIT 500`;
  return db().prepare(sql).all(...args).map((r) => present(r));
}

function row(id) {
  const r = db().prepare("SELECT * FROM events WHERE id = ?").get(id);
  if (!r) throw new HttpError(404, "Event not found.");
  return r;
}

export function getEvent(id) {
  return present(row(id));
}

export function createEvent(input) {
  const v = clean(input);
  const active = db().prepare("SELECT id, name FROM events WHERE ended_at IS NULL").get();
  if (active) throw new HttpError(409, `"${active.name}" is still in progress. Stop it before starting another event.`);
  const now = Date.now();
  const { lastInsertRowid } = db()
    .prepare("INSERT INTO events (name, category, notes, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(v.name, v.category, v.notes ?? "", v.startedAt ?? now, now, now);
  return getEvent(Number(lastInsertRowid));
}

export function stopEvent(id, input = {}) {
  const r = row(id);
  if (r.ended_at != null) throw new HttpError(409, "This event has already been stopped.");
  const v = clean(input, { partial: true });
  const endedAt = v.endedAt ?? Date.now();
  if (endedAt < r.started_at) throw new HttpError(400, "The end time must be after the start time.");
  const notes = v.notes != null && v.notes.trim() ? (r.notes ? `${r.notes}\n\n${v.notes.trim()}` : v.notes.trim()) : r.notes;
  db().prepare("UPDATE events SET ended_at = ?, notes = ?, updated_at = ? WHERE id = ?").run(endedAt, notes, Date.now(), id);
  return getEvent(id);
}

export function updateEvent(id, input) {
  const r = row(id);
  const v = clean(input, { partial: true });
  const startedAt = v.startedAt ?? r.started_at;
  const endedAt = "endedAt" in v ? v.endedAt : r.ended_at;
  if (endedAt != null && endedAt < startedAt) throw new HttpError(400, "The end time must be after the start time.");
  db()
    .prepare("UPDATE events SET name = ?, category = ?, notes = ?, started_at = ?, ended_at = ?, updated_at = ? WHERE id = ?")
    .run(v.name ?? r.name, v.category ?? r.category, v.notes ?? r.notes, startedAt, endedAt, Date.now(), id);
  return getEvent(id);
}

export function deleteEvent(id) {
  row(id);
  db().prepare("DELETE FROM events WHERE id = ?").run(id);
  return { deleted: id };
}
