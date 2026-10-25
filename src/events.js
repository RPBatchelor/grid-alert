// Events: start/stop named events (time windows over the recorded outage history), browse and
// filter past events, and analyse one in detail (statistics, zoomable chart, incidents).
import { STACK_ORDER, fmtDuration, fmtTime, num, renderChartTable, renderOutageChart, seriesColors as shadeForTheme } from "./outageChart.js";

export const CATEGORIES = { bushfire: "Bushfire", heatwave: "Heatwave", flood: "Flood", storm: "Storm", thunderstorm: "Thunderstorm", lightning: "Lightning", other: "Other" };
const NICE_BUCKETS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((m) => m * 60000);
const POINTS_TARGET = 360; // fine enough to zoom into; the chart thins ticks itself

const $ = (s) => document.querySelector(s);
let ctx; // { names, colors(), store, toast, onActiveChange }

const ev = {
  active: null,
  route: { id: null },
  filters: { q: "", category: "", status: "", from: "", to: "" },
  detail: null,
  data: null,
  incidents: [],
  chart: null,
  rendered: null,
  chartOpts: { chart: "area", metric: "customers", types: new Set(["unplanned"]), nets: new Set(STACK_ORDER) },
  sort: { key: "peak_customers", dir: -1 },
  adjust: null, // { start, end, savedStart, savedEnd, active, data } while adjusting times
  incidentQuery: "",
  ticker: null,
};

const colors = () => shadeForTheme(ctx.colors());

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// datetime-local <-> epoch ms (browser local time)
const toLocalInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const fromLocalInput = (v) => (v ? new Date(v).getTime() : null);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function categoryBadge(category) {
  const b = el("span", `cat-badge cat-${category}`, CATEGORIES[category] ?? category);
  return b;
}

function durationOf(e) {
  return (e.endedAt ?? Date.now()) - e.startedAt;
}

// ---- Top bar: start / recording indicator --------------------------------------------------

function renderControl() {
  const root = $("#event-control");
  root.replaceChildren();
  clearInterval(ev.ticker);
  if (!ev.active) {
    const b = el("button", "btn event-start");
    b.type = "button";
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 21V4h10l-1 4h6l-2 7h-8l1-4H5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /></svg><span>Start event</span>';
    b.addEventListener("click", openStart);
    root.append(b);
    return;
  }
  const pill = el("div", "event-pill");
  pill.title = `${ev.active.name} — click to open`;
  const dot = el("span", "rec-dot");
  const text = el("button", "event-pill-text");
  text.type = "button";
  const name = el("span", "event-pill-name", ev.active.name);
  const time = el("span", "event-pill-time");
  text.append(name, time);
  text.addEventListener("click", () => (location.hash = `#events/${ev.active.id}`));
  const stop = el("button", "btn small event-stop", "Stop");
  stop.type = "button";
  stop.addEventListener("click", () => openStop(ev.active));
  pill.append(dot, text, stop);
  root.append(pill);
  const tick = () => (time.textContent = fmtElapsed(Date.now() - ev.active.startedAt));
  tick();
  ev.ticker = setInterval(tick, 1000);
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export async function refreshActive() {
  try {
    const list = await api("GET", "/api/events?status=active");
    const next = list[0] ?? null;
    const changed = (next?.id ?? null) !== (ev.active?.id ?? null);
    ev.active = next;
    renderControl();
    if (changed) ctx.onActiveChange?.(ev.active);
  } catch {
    /* server unavailable: keep current state */
  }
}

// ---- Dialogs ------------------------------------------------------------------------------

function fillCategories(select, value) {
  select.innerHTML = Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  select.value = value ?? "storm";
}

function openStart() {
  const d = $("#ev-start-dialog");
  const form = d.querySelector("form");
  form.reset();
  fillCategories(form.category, "storm");
  form.startedAt.value = toLocalInput(Date.now());
  form.startedAt.max = toLocalInput(Date.now());
  $("#ev-start-error").textContent = "";
  d.showModal();
  form.name.focus();
}

function openStop(event) {
  const d = $("#ev-stop-dialog");
  const form = d.querySelector("form");
  form.reset();
  form.dataset.id = event.id;
  $("#ev-stop-name").textContent = event.name;
  form.endedAt.value = toLocalInput(Date.now());
  form.endedAt.min = toLocalInput(event.startedAt);
  form.endedAt.max = toLocalInput(Date.now());
  $("#ev-stop-error").textContent = "";
  d.showModal();
}

function openEdit(event) {
  const d = $("#ev-edit-dialog");
  const form = d.querySelector("form");
  form.dataset.id = event.id;
  form.name.value = event.name;
  fillCategories(form.category, event.category);
  form.notes.value = event.notes;
  form.startedAt.value = toLocalInput(event.startedAt);
  form.endedAt.value = event.endedAt ? toLocalInput(event.endedAt) : "";
  form.endedAt.disabled = !event.endedAt;
  $("#ev-edit-end-row").hidden = !event.endedAt;
  $("#ev-edit-error").textContent = "";
  d.showModal();
}

function wireDialog(id, submit) {
  const d = $(id);
  const form = d.querySelector("form");
  d.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => d.close()));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = form.querySelector('[type="submit"]');
    const error = form.querySelector(".form-error");
    error.textContent = "";
    const invalid = form.querySelector(":invalid");
    if (invalid) {
      error.textContent = invalid.name === "name" ? "Give the event a name." : invalid.validationMessage;
      invalid.focus();
      return;
    }
    button.disabled = true;
    try {
      await submit(form);
      d.close();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
}

// ---- Routing ------------------------------------------------------------------------------

export function showEvents(id) {
  ev.route.id = id ?? null;
  $("#ev-list-view").hidden = ev.route.id != null;
  $("#ev-detail-view").hidden = ev.route.id == null;
  return ev.route.id != null ? loadDetail(ev.route.id) : loadList();
}

export function refreshEvents() {
  if ($("#events").hidden) return;
  if (ev.route.id != null) {
    if (ev.detail?.active) loadDetail(ev.route.id, { keepZoom: true });
  } else loadList();
}

// ---- List ---------------------------------------------------------------------------------

async function loadList() {
  const f = ev.filters;
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  if (f.category) params.set("category", f.category);
  if (f.status) params.set("status", f.status);
  if (f.from) params.set("from", String(new Date(`${f.from}T00:00`).getTime()));
  if (f.to) params.set("to", String(new Date(`${f.to}T23:59:59`).getTime()));
  $("#events").classList.add("loading");
  try {
    renderList(await api("GET", `/api/events?${params}`));
  } catch (error) {
    $("#ev-list-note").textContent = `Could not load events: ${error.message}`;
  } finally {
    $("#events").classList.remove("loading");
  }
}

function renderList(list) {
  const body = $("#ev-table tbody");
  body.replaceChildren();
  const filtered = Object.values(ev.filters).some(Boolean);
  $("#ev-list-note").textContent = list.length ? `${list.length} event${list.length === 1 ? "" : "s"}${filtered ? " match the filters" : ""}.` : "";
  if (!list.length) {
    const row = body.insertRow();
    const td = row.insertCell();
    td.colSpan = 8;
    td.className = "empty";
    td.textContent = filtered ? "No events match these filters." : "No events yet. Use Start event (top bar) when a major event begins; stop it when it is over to review it here.";
    return;
  }
  for (const e of list) {
    const row = body.insertRow();
    row.className = `ev-row${e.active ? " is-active" : ""}`;
    row.tabIndex = 0;
    row.setAttribute("role", "link");
    row.setAttribute("aria-label", `Open ${e.name}`);
    const open = () => (location.hash = `#events/${e.id}`);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (k) => k.key === "Enter" && open());
    const name = row.insertCell();
    name.append(el("div", "ev-name", e.name));
    if (e.notes) name.append(el("div", "ev-notes-snippet", e.notes.split("\n")[0].slice(0, 120)));
    row.insertCell().append(categoryBadge(e.category));
    row.insertCell().textContent = fmtTime(e.startedAt);
    const ended = row.insertCell();
    if (e.active) ended.append(el("span", "ev-live", "● In progress"));
    else ended.textContent = fmtTime(e.endedAt);
    row.insertCell().textContent = fmtDuration(durationOf(e)) + (e.active ? "+" : "");
    const peak = row.insertCell();
    peak.className = "num strong";
    peak.textContent = e.stats.peak ? num(e.stats.peak.value) : "—";
    const inc = row.insertCell();
    inc.className = "num";
    inc.textContent = num(e.stats.incidents);
    const cml = row.insertCell();
    cml.className = "num";
    cml.textContent = e.stats.snapshots ? num(e.stats.customerMinutes) : "—";
  }
}

// ---- Detail -------------------------------------------------------------------------------

async function loadDetail(id, { keepZoom = false } = {}) {
  if (ev.adjust && (ev.detail?.id !== id || !keepZoom)) {
    ev.adjust = null;
    document.body.classList.remove("ev-adjusting");
    $("#ev-adjust-bar").hidden = true;
    $("#ev-adjust").hidden = false;
  }
  if (ev.adjust) return; // don't refresh underneath an in-progress adjustment
  $("#events").classList.add("loading");
  try {
    const event = await api("GET", `/api/events/${id}`);
    const from = event.startedAt;
    const to = event.endedAt ?? Date.now();
    const span = Math.max(to - from, 60000);
    const bucket = NICE_BUCKETS.find((b) => b >= span / POINTS_TARGET) ?? NICE_BUCKETS.at(-1);
    const o = ev.chartOpts;
    const params = new URLSearchParams({ from: String(from), to: String(to), bucket: String(bucket), networks: [...o.nets].join(","), types: [...o.types].join(","), metric: o.metric });
    const [data, incidents] = await Promise.all([api("GET", `/api/history?${params}`), api("GET", `/api/incidents?from=${from}&to=${to}&limit=5000`)]);
    if (ev.route.id !== id) return; // navigated away
    ev.detail = event;
    ev.data = data;
    ev.incidents = incidents.rows ?? [];
    renderDetail({ keepZoom });
  } catch (error) {
    $("#ev-name").textContent = "Event unavailable";
    $("#ev-meta").textContent = error.message;
  } finally {
    $("#events").classList.remove("loading");
  }
}

function tile(label, value, note) {
  const t = el("div", "tile");
  t.append(el("div", "tile-label", label), el("div", "tile-value", value), el("div", "tile-note", note));
  return t;
}

function renderDetail({ keepZoom }) {
  const e = ev.detail;
  const s = e.stats;
  $("#ev-name").textContent = e.name;
  const meta = $("#ev-meta");
  meta.replaceChildren(categoryBadge(e.category), el("span", e.active ? "ev-live" : "ev-done", e.active ? "● In progress" : "Completed"), el("span", "", `${fmtTime(e.startedAt)} → ${e.active ? "now" : fmtTime(e.endedAt)}`));
  $("#ev-notes").textContent = e.notes;
  $("#ev-notes").hidden = !e.notes;
  $("#ev-stop").hidden = !e.active;
  $("#ev-resume").hidden = e.active;
  $("#ev-export").href = `/api/events/${e.id}/export.xlsx`;
  $("#ev-export").title = e.active ? "Download outage data recorded so far (event still in progress)" : "Download the event's outage data as an Excel workbook";

  const tiles = $("#ev-tiles");
  tiles.replaceChildren(
    tile("Duration", fmtDuration(durationOf(e)) + (e.active ? "+" : ""), e.active ? "still in progress" : `ended ${fmtTime(e.endedAt)}`),
    tile("Peak customers off supply", s.peak ? num(s.peak.value) : "—", s.peak ? fmtTime(s.peak.ts) : "no recorded data in this window"),
    tile("Unplanned incidents", num(s.incidents), `${num(s.newIncidents)} began during the event`),
    tile("Customer-minutes off supply", s.snapshots ? num(s.customerMinutes) : "—", "approx., from 5-min snapshots"),
    tile("Networks affected", `${s.networksAffected} of 5`, `${num(s.snapshots)} snapshots recorded`),
  );

  renderNetworks();
  renderChart({ keepZoom });
  renderIncidentTable();
}

function renderNetworks() {
  const s = ev.detail.stats;
  const body = $("#ev-networks tbody");
  body.replaceChildren();
  const total = Object.values(s.networks).reduce((a, n) => a + n.customerMinutes, 0) || 1;
  const rows = STACK_ORDER.map((k) => [k, s.networks[k] ?? { peak: 0, peakTs: null, customerMinutes: 0, incidents: 0 }]).sort((a, b) => b[1].customerMinutes - a[1].customerMinutes);
  for (const [net, n] of rows) {
    const row = body.insertRow();
    const name = row.insertCell();
    name.className = "net-cell";
    name.style.setProperty("--c", colors()[net]);
    name.textContent = ctx.names[net];
    const cells = [num(n.peak), n.peakTs ? fmtTime(n.peakTs) : "—", num(n.incidents), num(n.customerMinutes)];
    cells.forEach((v, i) => {
      const td = row.insertCell();
      td.textContent = v;
      td.className = i === 1 ? "" : "num";
    });
    const share = row.insertCell();
    share.className = "share-cell";
    const pct = Math.round((n.customerMinutes / total) * 100);
    const bar = el("div", "share-bar");
    bar.style.setProperty("--w", `${pct}%`);
    bar.style.setProperty("--c", colors()[net]);
    share.append(bar, el("span", "share-pct", `${pct}%`));
  }
}

function renderChart({ keepZoom }) {
  if (ev.adjust) return renderAdjustChart();
  const o = ev.chartOpts;
  const zoomed = keepZoom && ev.chart?.isZoomedOrPanned() ? { min: ev.chart.scales.x.min, max: ev.chart.scales.x.max } : null;
  ev.rendered = renderOutageChart($("#ev-canvas"), ev.chart, {
    data: ev.data,
    chart: o.chart,
    metric: o.metric,
    types: o.types,
    nets: o.nets,
    names: ctx.names,
    colors: ctx.colors(),
    zoom: true,
    onZoom: (range, isZoomed) => renderSelection(isZoomed ? range : null),
  });
  ev.chart = ev.rendered.chart;
  if (zoomed) ev.chart.zoomScale("x", zoomed, "none");
  renderSelection(zoomed ? { from: Math.round(zoomed.min), to: Math.round(zoomed.max) } : null);
  $("#ev-chart-title").textContent = o.metric === "outages" ? "Number of outages during the event" : "Customers off supply during the event";
  renderChartTable($("#ev-table-data"), ev.data, ev.rendered.labels, ev.rendered.keys, ctx.names, o.types.size > 1);
}


// ---- Adjust start/end on the chart --------------------------------------------------------
// Widens the chart with context before and after the event and shows two draggable markers.
// Markers snap to the recorded snapshot intervals; Save writes the new times to the event.

const HANDLE_HIT_PX = 10;

async function startAdjust({ keep = false, ongoing = false } = {}) {
  const e = ev.detail;
  if (!e) return;
  const kept = keep && ev.adjust ? { start: ev.adjust.start, end: ev.adjust.end } : null;
  if (keep && ev.adjust && arguments[0]?.ongoing === undefined) ongoing = ev.adjust.ongoing;
  const end = e.endedAt ?? Date.now();
  const span = Math.max(end - e.startedAt, 3600e3);
  const pad = Math.min(Math.max(span * 0.5, 3 * 3600e3), 24 * 3600e3);
  const from = e.startedAt - pad;
  const to = e.active || ongoing ? Date.now() : Math.min(Date.now(), end + pad);
  const bucket = NICE_BUCKETS.find((b) => b >= (to - from) / POINTS_TARGET) ?? NICE_BUCKETS.at(-1);
  const o = ev.chartOpts;
  const params = new URLSearchParams({ from: String(from), to: String(to), bucket: String(bucket), networks: [...o.nets].join(","), types: [...o.types].join(","), metric: o.metric });
  $("#events").classList.add("loading");
  try {
    const data = await api("GET", `/api/history?${params}`);
    ev.adjust = { start: kept?.start ?? e.startedAt, end: ongoing ? Date.now() : kept?.end ?? end, savedStart: e.startedAt, savedEnd: end, active: e.active, ongoing, data };
    document.body.classList.add("ev-adjusting");
    $("#ev-adjust-bar").hidden = false;
    $("#ev-adjust").hidden = true;
    $("#ev-zoom-reset").hidden = true;
    $("#ev-adjust-end-field").hidden = e.active || ongoing;
    $("#ev-adjust-ongoing-field").hidden = e.active;
    $("#ev-adjust-ongoing").checked = ongoing;
    $("#ev-adjust-help").innerHTML = e.active
      ? 'Drag the <b class="adj-start">start</b> marker on the chart (or edit the time above). The event is still in progress, so its end stays at now until you stop it. Shaded areas are outside the event; the marker snaps to the recorded intervals.'
      : 'Drag the <b class="adj-start">start</b> and <b class="adj-end">end</b> markers on the chart (or edit the times above). Shaded areas are outside the event; markers snap to the recorded intervals.';
    renderAdjustChart();
    syncAdjustBar();
  } catch (error) {
    ctx.toast(`Could not load surrounding history: ${error.message}`);
  } finally {
    $("#events").classList.remove("loading");
  }
}

// The end is "now" (not draggable) for live events and ones being resumed.
const openEnded = (a) => a.active || a.ongoing;

function stopAdjust() {
  ev.adjust = null;
  document.body.classList.remove("ev-adjusting");
  $("#ev-adjust-bar").hidden = true;
  $("#ev-adjust").hidden = false;
  $("#ev-canvas").style.cursor = "";
  renderChart({ keepZoom: false });
}

async function saveAdjust() {
  const a = ev.adjust;
  if (!a) return;
  const body = { startedAt: a.start };
  if (!openEnded(a)) body.endedAt = a.end;
  const button = $("#ev-adjust-save");
  button.disabled = true;
  try {
    if (a.ongoing) {
      // Resume first (fails cleanly if another event is in progress), then apply the start.
      await api("POST", `/api/events/${ev.detail.id}/resume`);
      if (a.start !== a.savedStart) await api("PATCH", `/api/events/${ev.detail.id}`, body);
      ctx.toast("Event resumed — it is in progress again and will keep tracking until you stop it.", 4500);
    } else {
      await api("PATCH", `/api/events/${ev.detail.id}`, body);
      ctx.toast("Event times updated.", 3000);
    }
    ev.adjust = null;
    document.body.classList.remove("ev-adjusting");
    $("#ev-adjust-bar").hidden = true;
    $("#ev-adjust").hidden = false;
    await refreshActive();
    await loadDetail(ev.detail.id);
  } catch (error) {
    $("#ev-adjust-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

// Time <-> x pixel on the category axis (buckets are evenly spaced).
function timeToX(chart, data, t) {
  const x = chart.scales.x;
  const first = data.buckets[0].start;
  const idx = (t - first) / data.bucketMs - 0.5; // bucket i covers [start_i, start_i + bucketMs)
  const i0 = Math.floor(idx);
  const p0 = x.getPixelForValue(Math.max(0, Math.min(data.buckets.length - 1, i0)));
  const p1 = x.getPixelForValue(Math.max(0, Math.min(data.buckets.length - 1, i0 + 1)));
  const step = data.buckets.length > 1 ? x.getPixelForValue(1) - x.getPixelForValue(0) : 0;
  if (i0 < 0) return x.getPixelForValue(0) + (idx * step);
  if (i0 >= data.buckets.length - 1) return x.getPixelForValue(data.buckets.length - 1) + (idx - (data.buckets.length - 1)) * step;
  return p0 + (p1 - p0) * (idx - i0);
}

function xToTime(chart, data, px) {
  const x = chart.scales.x;
  const step = data.buckets.length > 1 ? x.getPixelForValue(1) - x.getPixelForValue(0) : 1;
  const idx = (px - x.getPixelForValue(0)) / step + 0.5;
  // Snap to the nearest interval boundary.
  const snapped = Math.round(idx);
  return data.buckets[0].start + snapped * data.bucketMs;
}

function clampAdjust(which, t) {
  const a = ev.adjust;
  const d = a.data;
  const min = d.buckets[0].start;
  const max = Math.min(Date.now(), d.buckets.at(-1).start + d.bucketMs);
  if (which === "start") return Math.max(min, Math.min(t, a.end - d.bucketMs));
  return Math.min(max, Math.max(t, a.start + d.bucketMs));
}

const windowPlugin = {
  id: "eventWindow",
  afterDatasetsDraw(chart) {
    const a = ev.adjust;
    if (!a) return;
    const { ctx: g, chartArea: area } = chart;
    const xs = timeToX(chart, a.data, a.start);
    const xe = timeToX(chart, a.data, a.end);
    const css = getComputedStyle(document.documentElement);
    const shadeColor = css.getPropertyValue("--bg").trim() || "#000";
    g.save();
    // Shade outside the event window.
    g.globalAlpha = 0.62;
    g.fillStyle = shadeColor;
    if (xs > area.left) g.fillRect(area.left, area.top, Math.min(xs, area.right) - area.left, area.bottom - area.top);
    if (xe < area.right) g.fillRect(Math.max(xe, area.left), area.top, area.right - Math.max(xe, area.left), area.bottom - area.top);
    g.globalAlpha = 1;
    // Markers.
    const marker = (x, label, color, fixed) => {
      if (x < area.left - 1 || x > area.right + 1) return;
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.setLineDash(fixed ? [5, 4] : []);
      g.beginPath();
      g.moveTo(x, area.top);
      g.lineTo(x, area.bottom);
      g.stroke();
      g.setLineDash([]);
      if (!fixed) {
        // Grip handle mid-height.
        const y = (area.top + area.bottom) / 2;
        g.fillStyle = color;
        g.beginPath();
        g.roundRect(x - 6, y - 16, 12, 32, 4);
        g.fill();
        g.strokeStyle = "#fff";
        g.lineWidth = 1.2;
        for (const dx of [-2, 2]) {
          g.beginPath();
          g.moveTo(x + dx, y - 8);
          g.lineTo(x + dx, y + 8);
          g.stroke();
        }
      }
      g.font = "700 11px Inter, system-ui, sans-serif";
      const w = g.measureText(label).width + 12;
      const lx = Math.min(Math.max(x - w / 2, area.left), area.right - w);
      g.fillStyle = color;
      g.beginPath();
      g.roundRect(lx, area.top - 2, w, 18, 4);
      g.fill();
      g.fillStyle = "#fff";
      g.fillText(label, lx + 6, area.top + 11);
    };
    marker(xs, `Start ${fmtTime(a.start, false)}`, "#0f8f6c", false);
    marker(xe, openEnded(a) ? "Now (in progress)" : `End ${fmtTime(a.end, false)}`, "#e5484d", openEnded(a));
    g.restore();
  },
};

function renderAdjustChart() {
  const a = ev.adjust;
  const o = ev.chartOpts;
  ev.rendered = renderOutageChart($("#ev-canvas"), ev.chart, {
    data: a.data,
    chart: o.chart,
    metric: o.metric,
    types: o.types,
    nets: o.nets,
    names: ctx.names,
    colors: ctx.colors(),
    zoom: false,
    plugins: [windowPlugin],
  });
  ev.chart = ev.rendered.chart;
  ev.chart.options.layout = { padding: { top: 22 } };
  ev.chart.update("none");
  $("#ev-chart-title").textContent = "Adjust the event's start and end";
}

function syncAdjustBar() {
  const a = ev.adjust;
  const d = a.data;
  $("#ev-adjust-start").value = toLocalInput(a.start);
  $("#ev-adjust-end").value = toLocalInput(a.end);
  const delta = (t, saved) => {
    const m = Math.round((t - saved) / 60000);
    return m === 0 ? "unchanged" : `${m > 0 ? "+" : "−"}${fmtDuration(Math.abs(m) * 60000)}`;
  };
  // Peak inside the proposed window (from the bucketed series).
  let peak = null;
  d.buckets.forEach((b, i) => {
    if (b.start + d.bucketMs <= a.start || b.start >= a.end || d.totals[i] == null) return;
    if (!peak || d.totals[i] > peak.v) peak = { v: d.totals[i], t: b.at ?? b.start };
  });
  const unit = ev.chartOpts.metric === "outages" ? "outages" : "customers";
  $("#ev-adjust-summary").replaceChildren(
    el("span", "", `Start ${fmtTime(a.start)} (${delta(a.start, a.savedStart)})`),
    el("span", "", a.active ? "End: still in progress" : a.ongoing ? "End: none — will resume and keep tracking" : `End ${fmtTime(a.end)} (${delta(a.end, a.savedEnd)})`),
    el("span", "", `Duration ${fmtDuration(a.end - a.start)}`),
    el("strong", "", peak ? `Peak in window ${num(peak.v)} ${unit} at ${fmtTime(peak.t)}` : "No data in window"),
  );
  const changed = a.start !== a.savedStart || a.ongoing || (!openEnded(a) && a.end !== a.savedEnd);
  $("#ev-adjust-save").textContent = a.ongoing ? "Save & resume" : "Save times";
  $("#ev-adjust-save").disabled = !changed;
  $("#ev-adjust-error").textContent = "";
}

function wireAdjust() {
  const canvas = $("#ev-canvas");
  let dragging = null;
  const pick = (evt) => {
    const a = ev.adjust;
    if (!a || !ev.chart) return null;
    const rect = canvas.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const ds = Math.abs(x - timeToX(ev.chart, a.data, a.start));
    const de = openEnded(a) ? Infinity : Math.abs(x - timeToX(ev.chart, a.data, a.end));
    if (Math.min(ds, de) > HANDLE_HIT_PX) return null;
    return ds <= de ? "start" : "end";
  };
  canvas.addEventListener("pointerdown", (evt) => {
    const which = pick(evt);
    if (!which) return;
    dragging = which;
    canvas.setPointerCapture(evt.pointerId);
    evt.preventDefault();
  });
  canvas.addEventListener("pointermove", (evt) => {
    const a = ev.adjust;
    if (!a) return;
    if (!dragging) {
      canvas.style.cursor = pick(evt) ? "ew-resize" : "";
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const t = clampAdjust(dragging, xToTime(ev.chart, a.data, evt.clientX - rect.left));
    if (t !== a[dragging]) {
      a[dragging] = t;
      ev.chart.draw();
      syncAdjustBar();
    }
  });
  const end = () => (dragging = null);
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  // Exact entry (and keyboard access) via the inputs.
  for (const which of ["start", "end"]) {
    $(`#ev-adjust-${which}`).addEventListener("change", (evt) => {
      const a = ev.adjust;
      const t = fromLocalInput(evt.target.value);
      if (!a || t == null) return;
      if ((which === "start" && t >= a.end) || (which === "end" && t <= a.start)) {
        $("#ev-adjust-error").textContent = "Start must be before end.";
        return syncAdjustBar();
      }
      a[which] = Math.min(t, Date.now());
      ev.chart.draw();
      syncAdjustBar();
    });
  }
  $("#ev-adjust").addEventListener("click", () => startAdjust());
  $("#ev-adjust-cancel").addEventListener("click", stopAdjust);
  $("#ev-adjust-reset").addEventListener("click", () => {
    const a = ev.adjust;
    if (!a) return;
    a.start = a.savedStart;
    a.end = a.savedEnd;
    ev.chart.draw();
    syncAdjustBar();
  });
  $("#ev-adjust-save").addEventListener("click", saveAdjust);
  $("#ev-adjust-ongoing").addEventListener("change", (e) => startAdjust({ keep: true, ongoing: e.target.checked }));
}

// Statistics for the zoomed-in window (or the whole event).
function renderSelection(range) {
  const d = ev.data;
  const root = $("#ev-selection");
  $("#ev-zoom-reset").hidden = !range;
  const from = range ? range.from : 0;
  const to = range ? range.to : d.buckets.length - 1;
  const totals = d.totals.slice(from, to + 1);
  const valid = totals.map((v, i) => [v, i + from]).filter(([v]) => v != null);
  const unit = ev.chartOpts.metric === "outages" ? "outages" : "customers";
  if (!valid.length) {
    root.textContent = range ? "No data recorded in the selected period." : "No data recorded during this event.";
    return;
  }
  const [peakV, peakI] = valid.reduce((a, b) => (b[0] > a[0] ? b : a));
  const avg = valid.reduce((s, [v]) => s + v, 0) / valid.length;
  const change = valid.at(-1)[0] - valid[0][0];
  const start = d.buckets[from].start;
  const end = d.buckets[to].start + d.bucketMs;
  const began = ev.incidents.filter((i) => i.type === "unplanned" && i.first_seen >= start && i.first_seen < end).length;
  root.replaceChildren(
    el("strong", "", range ? `Selected: ${fmtTime(start)} → ${fmtTime(end)}` : "Whole event"),
    el("span", "", `Peak ${num(peakV)} ${unit} at ${fmtTime(d.buckets[peakI].at ?? d.buckets[peakI].start)}`),
    el("span", "", `Average ${num(avg)}`),
    el("span", "", `Change ${change >= 0 ? "+" : "−"}${num(Math.abs(change))}`),
    el("span", "", `${num(began)} incidents began`),
  );
}

const INCIDENT_COLUMNS = [
  ["network", "Network"],
  ["id", "Incident"],
  ["place", "Location"],
  ["type", "Type"],
  ["peak_customers", "Peak customers", "num"],
  ["first_seen", "First seen"],
  ["last_seen", "Last seen"],
  ["duration", "Duration", "num"],
];

function visibleIncidents() {
  const o = ev.chartOpts;
  const q = ev.incidentQuery.toLowerCase();
  const rows = ev.incidents
    .filter((i) => o.nets.has(i.network) && o.types.has(i.type))
    .filter((i) => !q || [i.id, i.place, i.cause, i.status, ctx.names[i.network]].some((v) => String(v ?? "").toLowerCase().includes(q)))
    .map((i) => ({ ...i, duration: i.last_seen - i.first_seen }));
  const { key, dir } = ev.sort;
  return rows.sort((a, b) => {
    const x = key === "network" ? ctx.names[a.network] : a[key];
    const y = key === "network" ? ctx.names[b.network] : b[key];
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""))) * dir;
  });
}

function renderIncidentTable() {
  const table = $("#ev-incidents");
  const head = table.tHead.rows[0];
  head.replaceChildren();
  for (const [key, label, cls] of INCIDENT_COLUMNS) {
    const th = document.createElement("th");
    if (cls) th.className = cls;
    const b = el("button", "sort-btn", label);
    b.type = "button";
    const active = ev.sort.key === key;
    th.setAttribute("aria-sort", active ? (ev.sort.dir > 0 ? "ascending" : "descending") : "none");
    if (active) b.append(el("span", "sort-arrow", ev.sort.dir > 0 ? " ▲" : " ▼"));
    b.addEventListener("click", () => {
      ev.sort = { key, dir: active ? -ev.sort.dir : key === "peak_customers" || key === "duration" ? -1 : 1 };
      renderIncidentTable();
    });
    th.append(b);
    head.append(th);
  }
  const rows = visibleIncidents();
  $("#ev-incident-count").textContent = `${num(rows.length)} incident${rows.length === 1 ? "" : "s"}`;
  const body = table.tBodies[0];
  body.replaceChildren();
  const end = ev.detail.endedAt ?? Date.now();
  if (!rows.length) {
    const td = body.insertRow().insertCell();
    td.colSpan = INCIDENT_COLUMNS.length;
    td.className = "empty";
    td.textContent = "No incidents match.";
    return;
  }
  for (const i of rows.slice(0, 1000)) {
    const row = body.insertRow();
    const net = row.insertCell();
    net.className = "net-cell";
    net.style.setProperty("--c", colors()[i.network]);
    net.textContent = ctx.names[i.network];
    row.insertCell().textContent = i.id;
    row.insertCell().textContent = i.place ?? "—";
    row.insertCell().textContent = i.type;
    const peak = row.insertCell();
    peak.className = "num strong";
    peak.textContent = num(i.peak_customers);
    row.insertCell().textContent = fmtTime(i.first_seen);
    const ongoing = ev.detail.active && i.last_seen >= Date.now() - 10 * 60000;
    const last = row.insertCell();
    last.textContent = ongoing ? "Ongoing" : fmtTime(i.last_seen);
    if (ongoing) last.className = "ongoing";
    const dur = row.insertCell();
    dur.className = "num";
    dur.textContent = fmtDuration(Math.min(i.last_seen, end) - i.first_seen) + (ongoing ? "+" : "");
  }
}

function exportCsv() {
  const rows = visibleIncidents();
  const iso = (ms) => new Date(ms).toISOString();
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["network", "incident", "location", "type", "peak_customers", "first_seen_utc", "last_seen_utc", "duration_min", "cause", "status"].join(",")];
  for (const i of rows) lines.push([ctx.names[i.network], i.id, i.place, i.type, i.peak_customers, iso(i.first_seen), iso(i.last_seen), Math.round(i.duration / 60000), i.cause, i.status].map(esc).join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${ev.detail.name.replace(/[^\w-]+/g, "_").slice(0, 60)}_incidents.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- Chart controls (detail) --------------------------------------------------------------

function wireDetailControls() {
  const o = ev.chartOpts;
  const segment = (root, key) => {
    const sync = () =>
      root.querySelectorAll("button").forEach((b) => {
        b.classList.toggle("active", b.dataset.value === o[key]);
        b.setAttribute("aria-pressed", String(b.dataset.value === o[key]));
      });
    root.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        o[key] = b.dataset.value;
        sync();
        if (key === "metric") ev.adjust ? startAdjust({ keep: true }) : loadDetail(ev.route.id);
        else renderChart({ keepZoom: true });
      }),
    );
    sync();
  };
  segment($("#ev-metric"), "metric");
  segment($("#ev-chart-type"), "chart");

  const chips = (root, key, entries, withColor) => {
    root.replaceChildren();
    for (const [value, label] of entries) {
      const b = el("button", `chip${o[key].has(value) ? " active" : ""}`, label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(o[key].has(value)));
      if (withColor) b.style.setProperty("--c", colors()[value]);
      b.addEventListener("click", () => {
        if (o[key].has(value) && o[key].size === 1) return;
        o[key].has(value) ? o[key].delete(value) : o[key].add(value);
        chips(root, key, entries, withColor);
        if (ev.adjust) startAdjust({ keep: true });
        else if (ev.detail) loadDetail(ev.route.id);
      });
      root.append(b);
    }
  };
  ev.paintChips = () => {
    chips($("#ev-types"), "types", [["unplanned", "Unplanned"], ["planned", "Planned"]]);
    chips($("#ev-nets"), "nets", STACK_ORDER.map((n) => [n, ctx.names[n]]), true);
  };
  ev.paintChips();

  $("#ev-zoom-reset").addEventListener("click", () => {
    ev.chart?.resetZoom();
    renderSelection(null);
  });
  $("#ev-table-toggle").addEventListener("click", (e) => {
    const t = $("#ev-table-data");
    t.hidden = !t.hidden;
    e.currentTarget.textContent = t.hidden ? "Show data table" : "Hide data table";
    e.currentTarget.setAttribute("aria-expanded", String(!t.hidden));
  });
  $("#ev-incident-search").addEventListener("input", (e) => {
    ev.incidentQuery = e.target.value.trim();
    renderIncidentTable();
  });
  $("#ev-csv").addEventListener("click", exportCsv);
}

// Theme or colour change: re-render without refetching.
export function repaintEvents() {
  ev.paintChips?.();
  if (ev.detail && !$("#events").hidden && ev.route.id != null) renderDetail({ keepZoom: true });
}

// ---- Init ---------------------------------------------------------------------------------

export function initEvents(context) {
  ctx = context;
  renderControl();

  wireDialog("#ev-start-dialog", async (form) => {
    const created = await api("POST", "/api/events", { name: form.name.value, category: form.category.value, notes: form.notes.value, startedAt: fromLocalInput(form.startedAt.value) });
    ev.active = created;
    renderControl();
    ctx.onActiveChange?.(created);
    ctx.toast(`Event started: ${created.name}. Outages are being recorded against it.`, 4000);
    if (!$("#events").hidden) showEvents(ev.route.id);
  });
  wireDialog("#ev-stop-dialog", async (form) => {
    const id = +form.dataset.id;
    const stopped = await api("POST", `/api/events/${id}/stop`, { endedAt: fromLocalInput(form.endedAt.value), notes: form.notes.value });
    ev.active = null;
    renderControl();
    ctx.onActiveChange?.(null);
    ctx.toast(`Event stopped: ${stopped.name}. It is now available in Events.`, 4000);
    location.hash = `#events/${id}`;
    if (ev.route.id === id) loadDetail(id);
  });
  wireDialog("#ev-edit-dialog", async (form) => {
    const id = +form.dataset.id;
    const body = { name: form.name.value, category: form.category.value, notes: form.notes.value, startedAt: fromLocalInput(form.startedAt.value) };
    if (!form.endedAt.disabled) body.endedAt = fromLocalInput(form.endedAt.value);
    await api("PATCH", `/api/events/${id}`, body);
    await refreshActive();
    loadDetail(id);
  });

  // List filters
  const f = ev.filters;
  let debounce;
  $("#ev-q").addEventListener("input", (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      f.q = e.target.value.trim();
      loadList();
    }, 250);
  });
  const cat = $("#ev-category");
  cat.innerHTML = `<option value="">All categories</option>${Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}`;
  cat.addEventListener("change", (e) => {
    f.category = e.target.value;
    loadList();
  });
  $("#ev-status").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      f.status = b.dataset.value;
      $("#ev-status").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      loadList();
    }),
  );
  for (const key of ["from", "to"]) {
    $(`#ev-${key}`).addEventListener("change", (e) => {
      f[key] = e.target.value;
      loadList();
    });
  }
  $("#ev-clear").addEventListener("click", () => {
    Object.assign(f, { q: "", category: "", status: "", from: "", to: "" });
    $("#ev-q").value = "";
    cat.value = "";
    $("#ev-from").value = "";
    $("#ev-to").value = "";
    $("#ev-status").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x.dataset.value === ""));
    loadList();
  });
  $("#ev-start-btn").addEventListener("click", () => (ev.active ? (location.hash = `#events/${ev.active.id}`) : openStart()));

  // Detail actions
  $("#ev-back").addEventListener("click", () => (location.hash = "#events"));
  $("#ev-edit").addEventListener("click", () => ev.detail && openEdit(ev.detail));
  $("#ev-stop").addEventListener("click", () => ev.detail && openStop(ev.detail));
  $("#ev-resume").addEventListener("click", async () => {
    const e = ev.detail;
    if (!e || !confirm(`Resume "${e.name}"?

It becomes in progress again and keeps tracking outages until you stop it. Its current end time (${fmtTime(e.endedAt)}) is cleared.`)) return;
    try {
      await api("POST", `/api/events/${e.id}/resume`);
      await refreshActive();
      ctx.toast(`Event resumed: ${e.name}. It will keep tracking until you stop it.`, 4500);
      loadDetail(e.id);
    } catch (error) {
      ctx.toast(error.message, 6000);
    }
  });
  $("#ev-delete").addEventListener("click", async () => {
    if (!ev.detail || !confirm(`Delete "${ev.detail.name}"? The recorded outage history is kept; only the event is removed.`)) return;
    try {
      await api("DELETE", `/api/events/${ev.detail.id}`);
      if (ev.active?.id === ev.detail.id) {
        ev.active = null;
        renderControl();
      }
      ctx.toast("Event deleted.", 3000);
      location.hash = "#events";
    } catch (error) {
      ctx.toast(`Could not delete: ${error.message}`);
    }
  });
  wireDetailControls();
  wireAdjust();
  refreshActive();
}

export function updateStartButton() {
  $("#ev-start-btn").textContent = ev.active ? "View active event" : "Start event";
}
