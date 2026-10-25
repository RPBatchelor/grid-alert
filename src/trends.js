// Trends view: outage history from the server's SQLite store as a stacked bar/area chart,
// plus an incident register for the selected range.
import { shade } from "./color.js";
import { BarController, BarElement, CategoryScale, Chart, Filler, Legend, LineController, LineElement, LinearScale, PointElement, Tooltip } from "chart.js";

Chart.register(BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend, Filler);

// Series colours are the user's network colours (Settings → Map layers). They are bright for
// the map, so on the light theme the chart uses the same hues 0.2 darker in OKLCH lightness
// (validated: all pairs distinct for normal and colour-blind vision on white).
// Stack order (bottom -> top): AusNet is the base layer and the sister networks CitiPower and
// Powercor sit together; within those rules this order gives the best adjacent-segment
// separation in both themes. Segments are separated by a surface-coloured gap, and every
// value is in the table.
const STACK_ORDER = ["ausnet", "citipower", "powercor", "jemena", "ue"];
const LIGHT_SHADE = -0.2;

function seriesColors() {
  const colors = ctx.colors();
  if (document.documentElement.dataset.theme !== "light") return colors;
  return Object.fromEntries(Object.entries(colors).map(([k, c]) => [k, shade(c, LIGHT_SHADE)]));
}

// Theme ink is read from the CSS tokens so the chart follows light/dark mode.
function ink() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return { primary: v("--text"), secondary: v("--text-2"), muted: v("--muted"), grid: v("--line-2"), surface: v("--surface"), tooltip: v("--tooltip-bg"), border: v("--line-strong") };
}

const HOUR = 3600_000;
const RANGES = { "6h": 6 * HOUR, "24h": 24 * HOUR, "3d": 72 * HOUR, "7d": 168 * HOUR, "30d": 720 * HOUR, all: null };
const NICE_BUCKETS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((m) => m * 60000);
const TZ = "Australia/Melbourne";

const $ = (s) => document.querySelector(s);
const num = (n) => Math.round(n).toLocaleString("en-AU");

let ctx; // { names, getLive, store }
const tr = { chart: null, data: null, incidents: [], incidentTotal: 0, loading: null };
let opts;

function fmtTime(ms, withDay = true) {
  return new Intl.DateTimeFormat("en-AU", { timeZone: TZ, ...(withDay ? { weekday: "short", day: "numeric", month: "short" } : {}), hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.round(h / 24)} days`;
}

function hatch(color) {
  const c = document.createElement("canvas");
  c.width = c.height = 8;
  const g = c.getContext("2d");
  g.fillStyle = `${color}40`;
  g.fillRect(0, 0, 8, 8);
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, 8); g.lineTo(8, 0);
  g.moveTo(-2, 2); g.lineTo(2, -2);
  g.moveTo(6, 10); g.lineTo(10, 6);
  g.stroke();
  return g.createPattern(c, "repeat");
}

function save() {
  ctx.store.set("trends", JSON.stringify({ ...opts, types: [...opts.types], nets: [...opts.nets] }));
}

function segment(el, key, values) {
  el.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.value === String(opts[key]));
    b.setAttribute("aria-pressed", String(b.dataset.value === String(opts[key])));
    b.onclick = () => {
      opts[key] = b.dataset.value;
      save();
      segment(el, key, values);
      loadTrends();
    };
  });
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
    metric: saved.metric ?? "customers",
    chart: saved.chart ?? "bar",
    types: new Set(saved.types ?? ["unplanned"]),
    nets: new Set(saved.nets ?? STACK_ORDER),
  };
  segment($("#tr-range"), "range");
  segment($("#tr-metric"), "metric");
  segment($("#tr-chart"), "chart");
  chips($("#tr-types"), "types", [["unplanned", "Unplanned"], ["planned", "Planned"]]);
  chips($("#tr-nets"), "nets", STACK_ORDER.map((n) => [n, ctx.names[n]]), seriesColors());
  $("#tr-table-toggle").addEventListener("click", (e) => {
    const table = $("#tr-table");
    table.hidden = !table.hidden;
    e.currentTarget.textContent = table.hidden ? "Show data table" : "Hide data table";
    e.currentTarget.setAttribute("aria-expanded", String(!table.hidden));
  });
}

export async function loadTrends() {
  if (!opts) return;
  const span = RANGES[opts.range];
  const to = Date.now();
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

function seriesKeys() {
  const keys = [];
  for (const net of STACK_ORDER) {
    if (!opts.nets.has(net)) continue;
    for (const type of ["unplanned", "planned"]) if (opts.types.has(type)) keys.push([net, type]);
  }
  return keys;
}

function render() {
  const d = tr.data;
  const bothTypes = opts.types.size > 1;
  const sameDay = d.to - d.from <= 24 * HOUR;
  const labels = d.buckets.map((b) => fmtTime(b.start, !sameDay));
  const metricLabel = opts.metric === "outages" ? "outages" : "customers off supply";
  const keys = seriesKeys();
  const isBar = opts.chart === "bar";
  const isLine = opts.chart === "line"; // unstacked: each network on its own values
  const INK = ink();
  const SURFACE = INK.surface;
  const COLORS = seriesColors();

  const datasets = keys.map(([net, type], i) => {
    const color = COLORS[net];
    const label = `${ctx.names[net]}${bothTypes ? ` · ${type}` : ""}`;
    const data = d.series[`${net}|${type}`] ?? [];
    if (isLine) {
      // Planned outages are dashed so type stays readable without fills.
      return { type: "line", label, data, backgroundColor: color, borderColor: color, borderWidth: 2, borderDash: type === "planned" ? [6, 4] : [], pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: color, pointHoverBorderColor: SURFACE, pointHoverBorderWidth: 2, tension: 0.25, fill: false, spanGaps: false };
    }
    const fill = type === "planned" ? hatch(color) : isBar ? color : `${color}d0`;
    return isBar
      ? { type: "bar", label, data, backgroundColor: fill, borderColor: SURFACE, borderWidth: { top: 2, right: 0, bottom: 0, left: 0 }, borderSkipped: false, stack: "s", categoryPercentage: 0.92, barPercentage: 1 }
      : { type: "line", label, data, backgroundColor: fill, borderColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBorderColor: SURFACE, pointHoverBorderWidth: 2, tension: 0.25, fill: i === 0 ? "origin" : "-1", stack: "s", spanGaps: false };
  });

  const config = {
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { stacked: !isLine, grid: { display: false }, border: { color: INK.grid }, ticks: { color: INK.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 10, font: { size: 11 } } },
        y: { stacked: !isLine, beginAtZero: true, grid: { color: INK.grid }, border: { display: false }, ticks: { color: INK.muted, precision: 0, callback: (v) => num(v), font: { size: 11 } }, title: { display: true, text: metricLabel, color: INK.muted, font: { size: 11 } } },
      },
      plugins: {
        // Legend keys mirror the mark: swatches for fills, short strokes for lines (a zero-height
        // box is drawn as a stroke that carries the dataset's dash, so planned reads as dashed).
        legend: { position: "top", align: "start", labels: isLine ? { color: INK.secondary, boxWidth: 22, boxHeight: 0, font: { size: 12 } } : { color: INK.secondary, boxWidth: 12, boxHeight: 12, useBorderRadius: true, borderRadius: 2, font: { size: 12 } } },
        tooltip: {
          backgroundColor: INK.tooltip,
          borderColor: INK.border,
          borderWidth: 1,
          titleColor: INK.secondary,
          bodyColor: INK.primary,
          footerColor: INK.primary,
          padding: 10,
          // Stacked: top of stack first. Line: largest value first.
          itemSort: (a, b) => (isLine ? (b.raw ?? -1) - (a.raw ?? -1) : b.datasetIndex - a.datasetIndex),
          callbacks: {
            title: (items) => {
              const b = d.buckets[items[0].dataIndex];
              return b.at ? `${fmtTime(b.at)} (peak snapshot in interval)` : `${fmtTime(b.start)} · no data recorded`;
            },
            label: (item) => (item.raw == null ? `—  ${item.dataset.label}` : `${num(item.raw)}  ${item.dataset.label}`),
            footer: (items) => {
              const total = items.reduce((s, i) => s + (i.raw ?? 0), 0);
              return `${num(total)} total ${metricLabel}`;
            },
          },
        },
      },
    },
  };

  $("#tr-title").textContent = opts.metric === "outages" ? "Number of outages over time" : "Customers off supply over time";
  if (tr.chart) tr.chart.destroy();
  tr.chart = new Chart($("#tr-canvas"), config);

  renderTiles(metricLabel);
  renderTable(labels, keys);
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
  const tiles = [
    ["Now", now == null ? "—" : num(now), metricLabel],
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

function renderTable(labels, keys) {
  const d = tr.data;
  const table = $("#tr-table");
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  ["Interval", ...keys.map(([n, t]) => `${ctx.names[n]}${opts.types.size > 1 ? ` · ${t}` : ""}`), "Total"].forEach((h, i) => {
    const th = document.createElement("th");
    th.textContent = h;
    if (i > 0) th.className = "num";
    head.append(th);
  });
  const body = table.createTBody();
  d.buckets.forEach((b, i) => {
    if (d.totals[i] == null) return;
    const row = body.insertRow();
    cell(row, labels[i]);
    for (const [n, t] of keys) cell(row, d.series[`${n}|${t}`]?.[i] == null ? "—" : num(d.series[`${n}|${t}`][i]), "num");
    cell(row, num(d.totals[i]), "num strong");
  });
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
