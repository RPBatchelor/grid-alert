// Shared outage chart (Trends and Events): stacked bar, stacked area or line over the
// bucketed history from /api/history, with optional drag-to-zoom.
import { BarController, BarElement, CategoryScale, Chart, Filler, Legend, LineController, LineElement, LinearScale, PointElement, Tooltip } from "chart.js";
import zoomPlugin from "chartjs-plugin-zoom";
import { shade } from "./color.js";

Chart.register(BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend, Filler, zoomPlugin);

// Series colours are the user's network colours (Settings → Map layers). They are bright for
// the map, so on the light theme the chart uses the same hues 0.2 darker in OKLCH lightness
// (validated: all pairs distinct for normal and colour-blind vision on white).
// Stack order (bottom -> top): AusNet is the base layer and the sister networks CitiPower and
// Powercor sit together; within those rules this order gives the best adjacent-segment
// separation in both themes. Segments are separated by a surface-coloured gap, and every
// value is in the table.
export const STACK_ORDER = ["ausnet", "citipower", "powercor", "jemena", "ue"];
const LIGHT_SHADE = -0.2;
const HOUR = 3600_000;
const TZ = "Australia/Melbourne";
export const num = (n) => Math.round(n).toLocaleString("en-AU");

export function seriesColors(colors) {
  if (document.documentElement.dataset.theme !== "light") return colors;
  return Object.fromEntries(Object.entries(colors).map(([k, c]) => [k, shade(c, LIGHT_SHADE)]));
}

// Theme ink is read from the CSS tokens so the chart follows light/dark mode.
export function ink() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return { primary: v("--text"), secondary: v("--text-2"), muted: v("--muted"), grid: v("--line-2"), surface: v("--surface"), tooltip: v("--tooltip-bg"), border: v("--line-strong"), accent: v("--accent") };
}

export function fmtTime(ms, withDay = true) {
  return new Intl.DateTimeFormat("en-AU", { timeZone: TZ, ...(withDay ? { weekday: "short", day: "numeric", month: "short" } : {}), hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

export function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.round(h / 24)} days ${h % 24} h`;
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

export function seriesKeys(nets, types) {
  const keys = [];
  for (const net of STACK_ORDER) {
    if (!nets.has(net)) continue;
    for (const type of ["unplanned", "planned"]) if (types.has(type)) keys.push([net, type]);
  }
  return keys;
}

export function bucketLabels(data) {
  const sameDay = data.to - data.from <= 24 * HOUR;
  return data.buckets.map((b) => fmtTime(b.start, !sameDay));
}

// Builds (or rebuilds) a chart on `canvas`. opts: { data, chart: bar|area|line, metric,
// types:Set, nets:Set, names, colors, zoom:boolean, onZoom(range), plugins?: inline plugins }
export function renderOutageChart(canvas, previous, opts) {
  const d = opts.data;
  const bothTypes = opts.types.size > 1;
  const labels = bucketLabels(d);
  const metricLabel = opts.metric === "outages" ? "outages" : "customers off supply";
  const keys = seriesKeys(opts.nets, opts.types);
  const isBar = opts.chart === "bar";
  const isLine = opts.chart === "line"; // unstacked: each network on its own values
  const INK = ink();
  const SURFACE = INK.surface;
  const COLORS = seriesColors(opts.colors);

  const datasets = keys.map(([net, type], i) => {
    const color = COLORS[net];
    const label = `${opts.names[net]}${bothTypes ? ` · ${type}` : ""}`;
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

  const visibleRange = (chart) => ({ from: Math.max(0, Math.round(chart.scales.x.min)), to: Math.min(labels.length - 1, Math.round(chart.scales.x.max)) });
  const zoom = opts.zoom
    ? {
        // Drag across the chart to zoom into a time window; Shift-drag pans; Ctrl+wheel zooms.
        zoom: {
          drag: { enabled: true, backgroundColor: `${INK.accent}26`, borderColor: INK.accent, borderWidth: 1 },
          wheel: { enabled: true, modifierKey: "ctrl" },
          pinch: { enabled: true },
          mode: "x",
          onZoomComplete: ({ chart }) => opts.onZoom?.(visibleRange(chart), chart.isZoomedOrPanned()),
        },
        pan: { enabled: true, mode: "x", modifierKey: "shift", onPanComplete: ({ chart }) => opts.onZoom?.(visibleRange(chart), chart.isZoomedOrPanned()) },
        limits: { x: { minRange: 2 } },
      }
    : false;

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
        zoom,
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

  if (opts.plugins) config.plugins = opts.plugins;
  previous?.destroy();
  return { chart: new Chart(canvas, config), labels, keys, metricLabel };
}

// Data table for the chart (accessibility / exact values).
export function renderChartTable(table, data, labels, keys, names, bothTypes) {
  const cell = (row, text, cls) => {
    const td = document.createElement("td");
    td.textContent = text;
    if (cls) td.className = cls;
    row.append(td);
  };
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  ["Interval", ...keys.map(([n, t]) => `${names[n]}${bothTypes ? ` · ${t}` : ""}`), "Total"].forEach((h, i) => {
    const th = document.createElement("th");
    th.textContent = h;
    if (i > 0) th.className = "num";
    head.append(th);
  });
  const body = table.createTBody();
  data.buckets.forEach((b, i) => {
    if (data.totals[i] == null) return;
    const row = body.insertRow();
    cell(row, labels[i]);
    for (const [n, t] of keys) cell(row, data.series[`${n}|${t}`]?.[i] == null ? "—" : num(data.series[`${n}|${t}`][i]), "num");
    cell(row, num(data.totals[i]), "num strong");
  });
}
