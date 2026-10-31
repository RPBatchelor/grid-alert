// Trends view: outage history from the server's SQLite store as a stacked bar/area/line chart,
// plus an incident register for the selected range.
import { STACK_ORDER, fmtDuration, fmtTime, num, renderChartTable, renderOutageChart, seriesColors as shadeForTheme } from "./outageChart.js";

const seriesColors = () => shadeForTheme(ctx.colors());

const HOUR = 3600_000;
const RANGES = { "6h": 6 * HOUR, "12h": 12 * HOUR, "24h": 24 * HOUR, "3d": 72 * HOUR, "7d": 168 * HOUR, "30d": 720 * HOUR, all: null };
const NICE_BUCKETS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((m) => m * 60000);

const $ = (s) => document.querySelector(s);

let ctx; // { names, getLive, store }
const tr = { chart: null, data: null, incidents: [], incidentTotal: 0, loading: null };
let opts;

function save() {
  ctx.store.set("trends", JSON.stringify({ ...opts, types: [...opts.types], nets: [...opts.nets] }));
}

function segment(el, key, onPick) {
  el.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.value === String(opts[key]));
    b.setAttribute("aria-pressed", String(b.dataset.value === String(opts[key])));
    b.onclick = () => {
      opts[key] = b.dataset.value;
      onPick?.(b.dataset.value);
      save();
      segment(el, key, onPick);
      loadTrends();
    };
  });
}

// ---- Custom window ------------------------------------------------------------------------

// datetime-local <-> epoch ms (browser local time)
const toLocalInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const fromLocalInput = (v) => (v ? new Date(v).getTime() : null);
const MIN_WINDOW = 10 * 60000;

// Picking "Custom…" starts from the window currently shown, so it can be adjusted from there.
function pickRange(value) {
  if (value === "custom" && opts.from == null) {
    opts.to = tr.data?.to ?? Date.now();
    opts.from = tr.data?.from ?? opts.to - RANGES["24h"];
  }
  syncCustom();
}

function syncCustom(message) {
  const form = $("#tr-custom");
  form.hidden = opts.range !== "custom";
  if (form.hidden) return;
  if (opts.from != null) {
    $("#tr-from").value = toLocalInput(opts.from);
    $("#tr-to").value = toLocalInput(opts.to);
  }
  customMessage(message ?? (opts.from != null ? `Showing ${fmtTime(opts.from)} to ${fmtTime(opts.to)} (${fmtDuration(opts.to - opts.from)})` : ""));
}

function customMessage(text, error = false) {
  const el = $("#tr-custom-msg");
  el.textContent = text;
  el.classList.toggle("error", error);
}

function applyCustom(from, to) {
  if (from == null || to == null) return customMessage("Enter both a start and an end.", true);
  if (to - from < MIN_WINDOW) return customMessage("The end must be at least 10 minutes after the start.", true);
  Object.assign(opts, { range: "custom", from, to });
  save();
  segment($("#tr-range"), "range", pickRange);
  syncCustom();
  loadTrends();
}

function chips(el, key, entries, colors) {
  el.replaceChildren();
  for (const [value, label] of entries) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `chip${opts[key].has(value) ? " active" : ""}`;
    if (colors) b.style.setProperty("--c", colors[value]);
    b.textContent = label;
    b.setAttribute("aria-pressed", String(opts[key].has(value)));
    b.onclick = () => {
      if (opts[key].has(value) && opts[key].size === 1) return; // keep at least one selected
      opts[key].has(value) ? opts[key].delete(value) : opts[key].add(value);
      save();
      chips(el, key, entries, colors);
      loadTrends();
    };
    el.append(b);
  }
}

export function initTrends(context) {
  ctx = context;
  const saved = JSON.parse(ctx.store.get("trends", "{}"));
  opts = {
    range: saved.range ?? "24h",
    from: saved.from ?? null, // custom window (epoch ms)
    to: saved.to ?? null,
    metric: saved.metric ?? "customers",
    chart: saved.chart ?? "bar",
    types: new Set(saved.types ?? ["unplanned"]),
    nets: new Set(saved.nets ?? STACK_ORDER),
  };
  if (opts.range === "custom" && opts.from == null) opts.range = "24h";
  segment($("#tr-range"), "range", pickRange);
  syncCustom();
  $("#tr-custom").addEventListener("submit", (e) => {
    e.preventDefault();
    applyCustom(fromLocalInput($("#tr-from").value), fromLocalInput($("#tr-to").value));
  });
  $("#tr-custom").addEventListener("input", () => customMessage("Press Show window to update."));
  $("#tr-to-now").addEventListener("click", () => applyCustom(fromLocalInput($("#tr-from").value), Date.now()));
  $("#tr-zoom-use").addEventListener("click", () => {
    const d = tr.data;
    const r = tr.zoomRange;
    if (!d || !r) return;
    applyCustom(Math.max(d.from, d.buckets[r.from].start), Math.min(d.to, d.buckets[r.to].start + d.bucketMs));
  });
  segment($("#tr-metric"), "metric");
  segment($("#tr-chart"), "chart");
  chips($("#tr-types"), "types", [["unplanned", "Unplanned"], ["planned", "Planned"]]);
  chips($("#tr-nets"), "nets", STACK_ORDER.map((n) => [n, ctx.names[n]]), seriesColors());
  $("#tr-zoom-reset").addEventListener("click", () => {
    tr.chart?.resetZoom();
    $("#tr-zoom-reset").hidden = $("#tr-zoom-use").hidden = true;
  });
  $("#tr-table-toggle").addEventListener("click", (e) => {
    const table = $("#tr-table");
    table.hidden = !table.hidden;
    e.currentTarget.textContent = table.hidden ? "Show data table" : "Hide data table";
    e.currentTarget.setAttribute("aria-expanded", String(!table.hidden));
  });
}

export async function loadTrends() {
  if (!opts) return;
  const custom = opts.range === "custom" && opts.from != null;
  const to = custom ? opts.to : Date.now();
  const span = custom ? opts.to - opts.from : RANGES[opts.range];
  const params = new URLSearchParams({ to: String(to), networks: [...opts.nets].join(","), types: [...opts.types].join(","), metric: opts.metric });
  if (span) {
    const target = opts.chart === "bar" ? 96 : 200; // fewer, wider bars; finer lines
    params.set("from", String(to - span));
    params.set("bucket", String(NICE_BUCKETS.find((b) => b >= span / target) ?? NICE_BUCKETS.at(-1)));
  }
  $("#trends").classList.add("loading");
  const request = (tr.loading = Promise.all([
    fetch(`/api/history?${params}`).then((r) => r.json()),
    fetch(`/api/incidents?${params}`).then((r) => r.json()),
  ]));
  try {
    const [data, incidents] = await request;
    if (request !== tr.loading) return; // a newer request superseded this one
    if (data.error) throw new Error(data.error);
    tr.data = data;
    tr.incidents = incidents.rows ?? [];
    tr.incidentTotal = incidents.total ?? tr.incidents.length;
    render();
  } catch (error) {
    $("#tr-note").textContent = `Could not load history: ${error.message}`;
  } finally {
    if (request === tr.loading) $("#trends").classList.remove("loading");
  }
}

// Re-render with current colours/theme without refetching.
export function refreshTrends() {
  if (!opts) return;
  chips($("#tr-nets"), "nets", STACK_ORDER.map((n) => [n, ctx.names[n]]), seriesColors());
  if (tr.data && !$("#trends").hidden) render();
}

function render() {
  const d = tr.data;
  const { chart, labels, keys, metricLabel } = renderOutageChart($("#tr-canvas"), tr.chart, {
    data: d,
    chart: opts.chart,
    metric: opts.metric,
    types: opts.types,
    nets: opts.nets,
    names: ctx.names,
    colors: ctx.colors(),
    zoom: true,
    onZoom: (range, zoomed) => {
      tr.zoomRange = range;
      $("#tr-zoom-reset").hidden = $("#tr-zoom-use").hidden = !zoomed;
    },
  });
  tr.chart = chart;
  $("#tr-zoom-reset").hidden = $("#tr-zoom-use").hidden = true;
  $("#tr-title").textContent = opts.metric === "outages" ? "Number of outages over time" : "Customers off supply over time";

  renderTiles(metricLabel);
  renderChartTable($("#tr-table"), d, labels, keys, ctx.names, opts.types.size > 1);
  renderIncidents();

  const c = d.coverage;
  $("#tr-note").textContent = c.snapshots
    ? `${num(c.snapshots)} snapshots recorded since ${fmtTime(c.first)} (${num(c.inRange)} in this range). Each bar/point is the snapshot with the highest selected total within its ${fmtDuration(d.bucketMs)} interval. Gaps mean the server was not recording or that network's tracker was unavailable.`
    : "No history recorded yet. The server stores a snapshot every few minutes while it is running.";
}

function renderTiles(metricLabel) {
  const d = tr.data;
  const live = ctx.getLive();
  let now = null;
  if (live) {
    now = 0;
    for (const [net, feed] of Object.entries(live.networks)) {
      if (!opts.nets.has(net)) continue;
      for (const i of feed.incidents) if (opts.types.has(i.type)) now += opts.metric === "outages" ? 1 : i.customers;
    }
  }
  const values = d.totals.filter((v) => v != null);
  const change = values.length > 1 ? values.at(-1) - values[0] : null;
  // A custom window that ended in the past shows its closing value instead of the live one.
  const past = opts.range === "custom" && d.to < Date.now() - 10 * 60000;
  const tiles = [
    past ? ["End of window", values.length ? num(values.at(-1)) : "—", `${metricLabel}, last recorded interval`] : ["Now", now == null ? "—" : num(now), metricLabel],
    ["Peak in range", d.peak ? num(d.peak.value) : "—", d.peak ? fmtTime(d.peak.ts) : "No data in range"],
    ["Change over range", change == null ? "—" : `${change > 0 ? "+" : change < 0 ? "−" : ""}${num(Math.abs(change))}`, "first → last recorded interval"],
    ["Incidents in range", num(tr.incidentTotal), `${opts.types.size > 1 ? "planned + unplanned" : [...opts.types][0]}, selected networks`],
  ];
  const root = $("#tr-tiles");
  root.replaceChildren();
  for (const [label, value, note] of tiles) {
    const el = document.createElement("div");
    el.className = "tile";
    const l = document.createElement("div");
    l.className = "tile-label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "tile-value";
    v.textContent = value;
    const n = document.createElement("div");
    n.className = "tile-note";
    n.textContent = note;
    el.append(l, v, n);
    root.append(el);
  }
}

function cell(row, text, cls) {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  row.append(td);
  return td;
}

function renderIncidents() {
  const body = $("#tr-incidents tbody");
  body.replaceChildren();
  const last = tr.data.coverage.last;
  if (!tr.incidents.length) {
    const row = body.insertRow();
    const td = cell(row, "No incidents recorded for this range and filter.");
    td.colSpan = 8;
    td.className = "empty";
    return;
  }
  for (const i of tr.incidents) {
    const row = body.insertRow();
    const net = cell(row, ctx.names[i.network]);
    net.className = "net-cell";
    net.style.setProperty("--c", seriesColors()[i.network]);
    cell(row, i.id);
    cell(row, i.place ?? "—");
    cell(row, i.type);
    cell(row, num(i.peak_customers), "num strong");
    cell(row, fmtTime(i.first_seen));
    const ongoing = last && i.last_seen >= last - 60000;
    cell(row, ongoing ? "Ongoing" : fmtTime(i.last_seen), ongoing ? "ongoing" : "");
    cell(row, fmtDuration(i.last_seen - i.first_seen) + (ongoing ? "+" : ""));
  }
}
