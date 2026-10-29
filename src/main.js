import "./style.css";
import { NETWORKS, buildInsights, buildSamplePoints, clusterIncidents, inMultiPolygon, nowIndex, setNetworkColors, strongestWind } from "./intel.js";
import { BASEMAPS } from "./basemaps.js";
import { fdpInsights, initFdpLayer, refreshFdp } from "./fdpLayer.js";
import { fireInsights, initFireLayer, refreshFire } from "./fireLayer.js";
import { HALO, applyTheme, getSettings, initSettings, loadSettings, resolvedTheme, setSetting } from "./settings.js";
import { initEvents, refreshActive, refreshEvents, repaintEvents, showEvents, updateStartButton } from "./events.js";
import { initTrends, loadTrends, refreshTrends } from "./trends.js";
import { SCALES, WindField } from "./windfield.js";
import { initUsers, requireUser } from "./users.js";
import { initAdmin, showAdmin } from "./admin.js";

const L = window.L;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (n) => Math.round(n).toLocaleString("en-AU");
const TZ = "Australia/Melbourne";

// Phones (≤ 700px) get a vertical layout: the map as a block at the top, then the timeline and
// panels, with a bottom tab bar. Layout lives in the "Phone layout" section of style.css.
const phoneQuery = matchMedia("(max-width: 700px)");
const isPhone = () => phoneQuery.matches;

const store = {
  get(key, fallback) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable: setting applies to this session only */
    }
  },
};

const state = {
  map: null,
  windy: null, // Windy API object when a key is configured
  outages: null,
  previous: null,
  weather: null,
  boundaries: null,
  samplePoints: null,
  t: 0,
  variable: store.get("weatherLayer", "speed"),
  windStyle: store.get("windStyle", "arrows"),
  visible: new Set(Object.keys(NETWORKS)),
  collapsed: new Set(JSON.parse(store.get("collapsed", "[]"))),
  liveTimer: null,
  playTimer: null,
  followNow: true, // the timeline tracks the current hour until the user scrubs away
  calloutPositions: JSON.parse(store.get("dockedCallouts", "{}")),
  labelPositions: JSON.parse(store.get("labelPositions", "{}")),
  hiddenCallouts: new Set(JSON.parse(store.get("hiddenCallouts", "[]"))),
};

const layers = {};

// ---- Formatting -------------------------------------------------------------------------

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function bannerTime(iso) {
  const d = new Date(iso);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-AU", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${ordinal(+parts.day)} of ${parts.month} ${parts.year} ${parts.hour}:${parts.minute} ${String(parts.dayPeriod).toUpperCase()}`;
}

const shortTime = (iso) => (iso ? new Intl.DateTimeFormat("en-AU", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "Not yet available");
const hourLabel = (iso) => new Intl.DateTimeFormat("en-AU", { timeZone: TZ, weekday: "short", day: "numeric", hour: "numeric" }).format(new Date(iso));

function toast(message, ms = 6000) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), ms);
}

// ---- Map setup --------------------------------------------------------------------------

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.append(s);
  });
}

async function initWindy(key) {
  await loadScript("https://api.windy.com/assets/map-forecast/libBoot.js");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Windy did not initialise (check the API key and allowed domains)")), 20000);
    window.windyInit({ key, lat: -37.2, lon: 145.2, zoom: 7, overlay: "wind", verbose: false }, (api) => {
      clearTimeout(timer);
      resolve(api);
    });
  });
}

function initLeaflet() {
  const map = L.map(document.querySelector(".map-root"), { zoomControl: false, attributionControl: false, minZoom: 5, maxZoom: 14, zoomSnap: 0.25, zoomDelta: 0.5 }).setView([-37.0, 145.3], 7);
  L.control.zoom({ position: "topleft" }).addTo(map);
  L.control
    .attribution({ position: "bottomleft", prefix: false })
    .addAttribution('Forecast <a href="https://open-meteo.com/">Open-Meteo</a> · Boundaries derived from ABS ASGS 2021 + distributor lookups')
    .addTo(map);
  map.createPane("placeLabels").style.zIndex = 455;
  map.getPane("placeLabels").style.pointerEvents = "none";
  return map;
}

// Which base map is showing: the user's choice ("auto" follows light/dark mode), unless the
// weather layer is off and a separate "no weather" base map is configured.
function activeBasemap() {
  const s = getSettings();
  const pick = (key) => (key === "auto" || !BASEMAPS[key] ? (resolvedTheme() === "light" ? "light-gray" : "dark-gray") : key);
  if (state.variable === "none" && s.basemapNoWeather !== "same") return pick(s.basemapNoWeather);
  return pick(s.basemap);
}

// The panel dropdown edits whichever base map is in use: the normal one, or the "weather
// off" one (Settings → Map layers) while the weather layer is Off.
function basemapKeyInUse() {
  return state.variable === "none" && getSettings().basemapNoWeather !== "same" ? "basemapNoWeather" : "basemap";
}

function syncBasemapSelect() {
  const select = $("#basemap-select");
  if (!select) return;
  const key = basemapKeyInUse();
  const options = `<option value="auto">Auto (match light/dark)</option>${Object.entries(BASEMAPS).map(([k, b]) => `<option value="${k}">${esc(b.name)}</option>`).join("")}`;
  if (select.dataset.mode !== key) {
    select.innerHTML = options;
    select.dataset.mode = key;
  }
  select.value = getSettings()[key];
  $('label[for="basemap-select"]').textContent = key === "basemapNoWeather" ? "Weather off" : "With weather";
  select.title = key === "basemapNoWeather" ? "Used while the weather layer is Off (also in Settings → Map layers)" : "";
}

function applyBasemap() {
  if (state.windy || !state.map) return;
  const key = activeBasemap();
  document.body.dataset.mapTone = BASEMAPS[key].tone;
  syncBasemapSelect();
  if (layers.baseKey === key) return;
  layers.baseKey = key;
  const def = BASEMAPS[key];
  if (layers.base) state.map.removeLayer(layers.base);
  if (layers.reference) state.map.removeLayer(layers.reference);
  layers.base = L.tileLayer(def.base, { maxNativeZoom: def.maxNativeZoom, maxZoom: 19, attribution: def.attribution }).addTo(state.map);
  layers.reference = def.reference ? L.tileLayer(def.reference, { maxNativeZoom: def.maxNativeZoom, maxZoom: 19, pane: "placeLabels", opacity: 0.9 }).addTo(state.map) : null;
  syncBoundaries();
  updateLeaders();
}

function createPanes(map) {
  const panes = { weather: 350, radar: 360, boundaries: 400, areas: 410, leaders: 420 };
  for (const [name, z] of Object.entries(panes)) {
    if (!map.getPane(name)) map.createPane(name);
    map.getPane(name).style.zIndex = z;
  }
  map.getPane("weather").style.pointerEvents = "none";
  map.getPane("radar").style.pointerEvents = "none";
}

// Height of the lower-right legend stack (weather scale and/or fire danger key).
function legendHeight() {
  const el = $("#legends");
  if (!el || getComputedStyle(el).display === "none") return 0;
  const h = el.getBoundingClientRect().height;
  return h > 4 ? h + 10 : 0;
}

// Screen space not covered by the sidebar, outputs column, top bar and timeline.
function mapViewport() {
  if (isPhone()) {
    // The map is its own block on phones; nothing overlays it.
    const { x, y } = state.map.getSize();
    return { left: 10, right: x - 10, top: 10, bottom: y - 10, width: x, height: y };
  }
  const outputs = $("#outputs");
  const outRect = outputs && getComputedStyle(outputs).display !== "none" ? outputs.getBoundingClientRect() : null;
  const narrow = window.innerWidth < 1100;
  // A temporary flyout overlays the map; only the rail (or pinned width) is reserved. Read the
  // target width from the layout variables, since the sidebar animates its width.
  const css = getComputedStyle(document.documentElement);
  const railRight = 10 + parseFloat(css.getPropertyValue(document.body.classList.contains("sb-pinned") ? "--sb-open" : "--rail"));
  return {
    left: railRight + 10,
    right: outRect && outRect.top < window.innerHeight / 2 ? outRect.left - 10 : window.innerWidth - 10,
    top: narrow ? 130 : 70,
    // Above the timeline, and above the colour legend when it is showing (lower right).
    bottom: window.innerHeight - (document.body.classList.contains("windy-mode") ? 130 : 84) - legendHeight(),
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function fitVictoria() {
  const v = mapViewport();
  state.map.fitBounds([[-39.2, 140.9], [-33.98, 150.0]], {
    paddingTopLeft: [v.left, v.top],
    paddingBottomRight: [v.width - v.right, v.height - v.bottom + 10],
    animate: false,
  });
}

// ---- Data -------------------------------------------------------------------------------

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

async function refresh({ force = false } = {}) {
  const button = $("#refresh-button");
  button.disabled = true;
  button.querySelector("span").textContent = "Refreshing…";
  try {
    const [outages, weather] = await Promise.allSettled([getJson(`/api/outages${force ? "?force" : ""}`), getJson("/api/weather")]);
    if (outages.status === "fulfilled") {
      if (state.outages && state.outages.fetchedAt !== outages.value.fetchedAt) state.previous = state.outages;
      state.outages = outages.value;
    } else {
      toast(`Outage refresh failed: ${outages.reason.message}. Showing previous data.`);
    }
    if (weather.status === "fulfilled") {
      const isNew = !state.weather || state.weather.fetchedAt !== weather.value.fetchedAt;
      if (isNew) {
        // Keep the user's selected hour across forecast updates unless they are following now.
        const selected = state.weather?.times[state.t];
        state.weather = weather.value;
        state.t = state.followNow || !selected ? nowIndex(state.weather) : nowIndex(state.weather, Date.parse(selected));
        setupTimeline();
        layers.wind?.setData(state.weather, state.t);
      }
    } else {
      toast(`Weather refresh failed: ${weather.reason.message}.`);
    }
    renderAll();
    if (state.view === "trends") loadTrends();
    if (state.view === "events") refreshEvents();
    refreshFire();
    refreshFdp();
    refreshActive();
  } finally {
    button.disabled = false;
    button.querySelector("span").textContent = "Refresh";
  }
}

function incidents({ includePlanned = $("#t-planned").checked } = {}) {
  if (!state.outages) return [];
  return Object.values(state.outages.networks)
    .flatMap((n) => n.incidents)
    .filter((i) => state.visible.has(i.network) && (includePlanned || i.type === "unplanned"));
}

// ---- Rendering --------------------------------------------------------------------------

function renderAll() {
  renderBanner();
  renderPanels();
  renderClusters();
  renderAreas();
  renderLabels();
  renderWindCallouts();
  renderInsights();
}

function renderBanner() {
  if (!state.outages) return;
  const nets = Object.entries(state.outages.networks);
  const failed = nets.filter(([, n]) => !n.ok).map(([k]) => NETWORKS[k].name);
  $("#updated-at").textContent = window.innerWidth <= 700 ? `Updated ${shortTime(state.outages.fetchedAt)}` : bannerTime(state.outages.fetchedAt);
  const banner = $("#updated-banner");
  banner.classList.toggle("degraded", failed.length > 0);
  banner.title = nets.map(([k, n]) => `${NETWORKS[k].name}: ${n.ok ? "OK" : `FAILED (${n.error})`} · tracker time ${n.sourceTime ? shortTime(n.sourceTime) : "n/a"}`).join("\n");
  $(".updated-label").textContent = failed.length ? `Outage information (${failed.join(", ")} unavailable) last updated` : "Outage information last updated";

  // Headline: unplanned customers off supply across the networks selected on the map.
  const selected = Object.keys(NETWORKS).filter((k) => state.visible.has(k) && state.outages.networks[k]);
  const total = selected.reduce((s, k) => s + state.outages.networks[k].incidents.filter((i) => i.type === "unplanned").reduce((a, i) => a + i.customers, 0), 0);
  const sub = $("#banner-total-sub");
  if (!selected.length) {
    $("#banner-total").textContent = "—";
    sub.textContent = "no networks selected";
  } else {
    $("#banner-total").textContent = num(total);
    sub.textContent = selected.length === 1 ? `off supply in ${NETWORKS[selected[0]].name} network` : `off supply across ${selected.length} networks`;
  }
  $("#banner-total").closest(".banner-total").title = selected.length ? `Unplanned customers off supply: ${selected.map((k) => NETWORKS[k].name).join(", ")}` : "";
}

function renderPanels() {
  const root = $("#network-panels");
  if (!state.outages) return;
  const includePlanned = $("#t-planned").checked;
  root.replaceChildren();
  renderMiniPanel();
  for (const [net, meta] of Object.entries(NETWORKS)) {
    const feed = state.outages.networks[net];
    if (!feed) continue;
    const unplanned = feed.incidents.filter((i) => i.type === "unplanned");
    const list = feed.incidents.filter((i) => includePlanned || i.type === "unplanned").sort((a, b) => b.customers - a.customers);
    const customers = unplanned.reduce((s, i) => s + i.customers, 0);
    const prev = state.previous?.networks[net]?.incidents.filter((i) => i.type === "unplanned");
    const prevCustomers = prev?.reduce((s, i) => s + i.customers, 0);
    const delta = prev ? customers - prevCustomers : 0;
    const collapsed = state.collapsed.has(net);
    const el = document.createElement("section");
    el.className = `net-panel${collapsed ? " collapsed" : ""}${state.visible.has(net) ? "" : " muted"}`;
    el.style.setProperty("--c", meta.color);
    el.innerHTML = `
      <button class="net-head" type="button" aria-expanded="${!collapsed}">
        <div class="net-head-main">
          <div class="net-title-row">
            <span class="net-title"><span class="swatch"></span>${esc(meta.name)}</span>
            <span class="net-off"><strong>${num(customers)}</strong> off supply</span>
          </div>
          <div class="net-sub">${unplanned.length} unplanned outage${unplanned.length === 1 ? "" : "s"}${delta ? ` <span class="delta ${delta > 0 ? "up" : "down"}">${delta > 0 ? "▲" : "▼"} ${num(Math.abs(delta))} customers</span>` : ""}${feed.ok ? "" : ' <span class="stale">feed unavailable</span>'}</div>
        </div>
        <span class="net-toggle" aria-hidden="true">${collapsed ? "+" : "−"}</span>
      </button>
      <div class="net-list">${list.length ? list.map((i) => `
        <button class="row" type="button" data-lat="${i.lat}" data-lon="${i.lon}">
          <div class="row-top"><span class="row-place">${esc(i.place)}${i.type === "planned" ? ' <span class="pill">planned</span>' : ""}</span><span class="row-off">${num(i.customers)} off</span></div>
          <div class="row-meta">${esc(i.id)} · ETR ${esc(shortTime(i.etr))}${i.status ? ` · ${esc(i.status)}` : ""}</div>
        </button>`).join("") : '<div class="empty">No current outages</div>'}
      </div>`;
    el.querySelector(".net-head").addEventListener("click", () => {
      state.collapsed.has(net) ? state.collapsed.delete(net) : state.collapsed.add(net);
      store.set("collapsed", JSON.stringify([...state.collapsed]));
      renderPanels();
    });
    el.querySelectorAll(".row").forEach((row) => row.addEventListener("click", () => state.map.flyTo([+row.dataset.lat, +row.dataset.lon], 11)));
    root.append(el);
  }
  const total = Object.entries(state.outages.networks)
    .filter(([net]) => state.visible.has(net))
    .flatMap(([, f]) => f.incidents)
    .filter((i) => i.type === "unplanned")
    .reduce((s, i) => s + i.customers, 0);
  $("#network-total").textContent = `${num(total)} off`;
}

// Summary strip shown when the outputs column is collapsed: unplanned customers off per network.
function renderMiniPanel() {
  const rows = Object.entries(NETWORKS)
    .filter(([net]) => state.outages.networks[net])
    .map(([net, meta]) => {
      const feed = state.outages.networks[net];
      const customers = feed.incidents.filter((i) => i.type === "unplanned").reduce((s, i) => s + i.customers, 0);
      return { net, meta, feed, customers };
    });
  const total = rows.filter((r) => state.visible.has(r.net)).reduce((s, r) => s + r.customers, 0);
  $("#out-mini").innerHTML =
    `<span class="mini-row mini-total"><span class="mini-name">Off supply</span><span class="mini-off">${num(total)}</span></span>` +
    rows
      .map(
        ({ net, meta, feed, customers }) => `<span class="mini-row${state.visible.has(net) ? "" : " muted"}" style="--c:${meta.color}" title="${esc(meta.name)}: ${num(customers)} customers off supply (unplanned)${feed.ok ? "" : " · feed unavailable"}">
        <span class="swatch"></span><span class="mini-name">${esc(meta.name)}</span><span class="mini-off">${num(customers)}${feed.ok ? "" : ' <span class="mini-stale">!</span>'}</span></span>`,
      )
      .join("");
}

function clusterSize(customers) {
  return Math.round(Math.min(78, 26 + Math.log10(customers + 1) * 15));
}

function renderClusters() {
  layers.clusters.clearLayers();
  if (!$("#t-clusters").checked) return;
  const map = state.map;
  const clusters = clusterIncidents(incidents(), (ll) => map.latLngToLayerPoint(ll), map.getZoom() >= 10 ? 30 : 46);
  for (const c of clusters) {
    const color = NETWORKS[c.network].color;
    const size = clusterSize(c.customers);
    const planned = c.items.every((i) => i.type === "planned");
    const html = `<div class="cluster${planned ? " planned" : ""}" style="--c:${color};--s:${size}px">
      <span class="cluster-tag">${c.items.length} outage${c.items.length > 1 ? "s" : ""}</span>
      <span class="cluster-ring">${num(c.customers)}</span></div>`;
    const marker = L.marker([c.lat, c.lon], { icon: L.divIcon({ className: "", html, iconSize: [0, 0] }), riseOnHover: true });
    marker.bindPopup(`<div class="pop"><div class="pop-head"><span class="swatch" style="--c:${color}"></span>${esc(NETWORKS[c.network].name)} · ${num(c.customers)} customers</div>${c.items
      .slice(0, 12)
      .map((i) => `${esc(i.place)} — ${num(i.customers)} off · ${esc(i.id)}<br><span class="dim">${esc(i.status)} · ${esc(i.cause || "Cause not stated")} · ETR ${esc(shortTime(i.etr))}</span>`)
      .join("<br>")}${c.items.length > 12 ? `<br>…and ${c.items.length - 12} more` : ""}</div>`, { maxWidth: 360 });
    layers.clusters.addLayer(marker);
  }
}

function renderAreas() {
  layers.areas.clearLayers();
  if (!$("#t-areas").checked || state.map.getZoom() < 10) return;
  for (const i of incidents()) {
    if (!i.geometry) continue;
    L.geoJSON(i.geometry, { pane: "areas", style: { color: HALO, weight: 1.5, fillColor: NETWORKS[i.network].color, fillOpacity: 0.45, dashArray: i.type === "planned" ? "4 4" : null } })
      .bindTooltip(`${esc(i.place)} · ${num(i.customers)} off`)
      .addTo(layers.areas);
  }
}

function renderLabels() {
  layers.labels.clearLayers();
  if (!$("#t-labels").checked || !state.outages) return;
  for (const [net, meta] of Object.entries(NETWORKS)) {
    if (!state.visible.has(net) || (meta.metro && state.map.getZoom() < 10)) continue;
    const feed = state.outages.networks[net];
    const unplanned = feed?.incidents.filter((i) => i.type === "unplanned") ?? [];
    const planned = feed?.incidents.filter((i) => i.type === "planned") ?? [];
    const customers = unplanned.reduce((s, i) => s + i.customers, 0);
    const plural = (n, word) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;
    const plannedLine = $("#t-planned").checked && planned.length ? `<div class="label-meta">+ ${plural(planned.length, "planned outage")} · ${num(planned.reduce((s, i) => s + i.customers, 0))} customers</div>` : "";
    const html = `<div class="label-name">${esc(meta.name)}</div>
      <div class="label-sub">${num(customers)} customers off supply</div>
      <div class="label-meta">${plural(unplanned.length, "unplanned outage")}${feed && !feed.ok ? " · feed unavailable" : ""}</div>${plannedLine}`;
    const pos = state.labelPositions[net] ?? meta.label;
    const box = L.marker(pos, { draggable: true, icon: L.divIcon({ className: "", html: `<div class="callout label" style="--c:${meta.color}">${html}</div>`, iconSize: [0, 0] }) });
    box.on("dragend", () => {
      const ll = box.getLatLng();
      state.labelPositions[net] = [ll.lat, ll.lng];
      store.set("labelPositions", JSON.stringify(state.labelPositions));
    });
    layers.labels.addLayer(box);
  }
}

// ---- Docked wind callouts --------------------------------------------------------------
// Boxes live in screen space so they stay readable at any zoom; leader lines are redrawn to
// follow their map anchor as the map moves. Positions are saved as viewport fractions.

const dock = { items: {} }; // net -> { el, anchor, color }

function safeArea() {
  const v = mapViewport();
  return { left: v.left - 2, right: v.right + 2, top: v.top - 4, bottom: v.bottom };
}

function placeBox(el, x, y) {
  const a = safeArea();
  el.style.left = `${Math.max(a.left, Math.min(x, a.right - el.offsetWidth))}px`;
  el.style.top = `${Math.max(a.top, Math.min(y, a.bottom - el.offsetHeight))}px`;
}

function updateLeaders() {
  const svg = $("#callout-leaders");
  if (!svg || !state.map) return;
  const lines = [];
  for (const { el, anchor, color } of Object.values(dock.items)) {
    const p = state.map.latLngToContainerPoint(anchor);
    const r = el.getBoundingClientRect();
    if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) continue;
    // Attach to the closest point on the box edge.
    const bx = Math.max(r.left, Math.min(p.x, r.right));
    const by = Math.max(r.top, Math.min(p.y, r.bottom));
    lines.push(`<line x1="${bx}" y1="${by}" x2="${p.x}" y2="${p.y}" stroke="${casingColor()}" stroke-opacity="0.9" stroke-width="5" stroke-linecap="round" />`);
    lines.push(`<line x1="${bx}" y1="${by}" x2="${p.x}" y2="${p.y}" stroke="${color}" stroke-width="2" stroke-linecap="round" />`);
  }
  svg.innerHTML = lines.join("");
}

function makeDraggable(el, net) {
  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".callout-close")) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const ox = e.clientX - el.offsetLeft;
    const oy = e.clientY - el.offsetTop;
    el.classList.add("dragging");
    const move = (ev) => {
      placeBox(el, ev.clientX - ox, ev.clientY - oy);
      updateLeaders();
    };
    const up = () => {
      el.classList.remove("dragging");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      state.calloutPositions[net] = { fx: el.offsetLeft / window.innerWidth, fy: el.offsetTop / window.innerHeight };
      store.set("dockedCallouts", JSON.stringify(state.calloutPositions));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  });
}

function renderWindCallouts() {
  layers.windCallouts.clearLayers();
  $("#callout-dock").querySelectorAll(".callout.docked").forEach((n) => n.remove());
  dock.items = {};
  updateLeaders();
  if (isPhone()) return; // no room for docked callouts on a phone
  if (!$("#t-windcallouts").checked || !state.weather || !state.samplePoints) return;
  const strongest = strongestWind(state.weather, state.samplePoints, state.t);
  const when = hourLabel(state.weather.times[state.t]);
  // Default slots: two staggered rows along the bottom of the map, ordered by anchor
  // longitude so leader lines don't cross.
  const order = Object.keys(strongest)
    .filter((n) => state.visible.has(n) && !state.hiddenCallouts.has(n))
    .sort((a, b) => strongest[a].lon - strongest[b].lon);
  order.forEach((net, i) => {
    const w = strongest[net];
    const meta = NETWORKS[net];
    layers.windCallouts.addLayer(L.circleMarker([w.lat, w.lon], { pane: "leaders", radius: 7, color: "#fff", weight: 2, fillColor: meta.color, fillOpacity: 1 }).bindTooltip(`${meta.name}: strongest sampled gust ${Math.round(w.gust)} km/h`));
    const el = document.createElement("div");
    el.className = "callout docked";
    el.style.setProperty("--c", meta.color);
    el.title = "Drag to move";
    el.innerHTML = `<button class="callout-close" type="button" aria-label="Hide ${esc(meta.name)} callout">×</button>
      <div class="callout-title"><span class="swatch"></span>${esc(meta.name)} strongest sampled wind</div>
      <div class="callout-body">Wind <b>${Math.round(w.speed)}</b> · Gust <b>${Math.round(w.gust)} km/h</b></div>
      <div class="callout-foot">${esc(w.place)} · ${esc(when)}</div>`;
    $("#callout-dock").append(el);
    const saved = state.calloutPositions[net];
    if (saved?.fx != null) {
      placeBox(el, saved.fx * window.innerWidth, saved.fy * window.innerHeight);
    } else {
      const a = safeArea();
      const span = a.right - a.left - el.offsetWidth;
      const x = a.left + (order.length > 1 ? (i * span) / (order.length - 1) : span / 2);
      const y = a.bottom - el.offsetHeight - 8 - (i % 2 ? el.offsetHeight + 12 : 0);
      placeBox(el, x, y);
    }
    el.querySelector(".callout-close").addEventListener("click", () => {
      state.hiddenCallouts.add(net);
      store.set("hiddenCallouts", JSON.stringify([...state.hiddenCallouts]));
      renderWindCallouts();
      toast(`${meta.name} callout hidden. "Reset view & callouts" brings it back.`, 3500);
    });
    makeDraggable(el, net);
    dock.items[net] = { el, anchor: [w.lat, w.lon], color: meta.color };
  });
  updateLeaders();
}

const SEVERITY_LABEL = { severe: "Severe", high: "High", warn: "Data", elevated: "Elevated", info: "Info" };

// Dismissed callouts stay hidden for a day in this browser. The key ignores numbers, so a
// callout stays dismissed as its figures update ("gusts to 73" → "75 km/h"), but includes the
// severity, so it comes back if it escalates.
const DISMISS_MS = 24 * 3600e3;
const insightKey = (x) => `${x.severity}|${x.title.replace(/\d+/g, "#")}`;
function dismissedInsights() {
  let saved = {};
  try {
    saved = JSON.parse(store.get("dismissedInsights", "{}"));
  } catch {
    /* corrupt value: start afresh */
  }
  return Object.fromEntries(Object.entries(saved).filter(([, ts]) => Date.now() - ts < DISMISS_MS));
}

function renderInsights() {
  if (!state.outages) return;
  const rank = { severe: 0, high: 1, warn: 2, elevated: 3, info: 4 };
  const all = [...buildInsights({ outages: state.outages, previous: state.previous, weather: state.weather, samplePoints: state.samplePoints ?? {} }), ...fireInsights(), ...fdpInsights()].sort((a, b) => rank[a.severity] - rank[b.severity]);
  const dismissed = dismissedInsights();
  const list = all.filter((x) => !dismissed[insightKey(x)]);
  const hidden = all.length - list.length;
  const root = $("#insights");
  $("#insight-count").textContent = `${list.length} active`;
  $("#out-toggle-count").textContent = list.length;
  $("#out-toggle-count").hidden = !list.length;
  const restore = hidden ? `<button class="link-button insights-restore" type="button">Show ${hidden} dismissed</button>` : "";
  if (!list.length) {
    root.innerHTML = (hidden ? '<div class="empty">All callouts dismissed.</div>' : '<div class="empty">No callouts. Unplanned outages are below thresholds and no forecast gusts ≥ 55 km/h in the next 24 h.</div>') + restore;
  } else {
    root.innerHTML =
      list
        .map((x, idx) => `<div class="insight sev-${x.severity}" role="button" tabindex="0" data-idx="${idx}" style="--c:${x.color ?? NETWORKS[x.network]?.color ?? "#9ab"}">
      <span class="sev">${SEVERITY_LABEL[x.severity]}</span>
      <button class="insight-x" type="button" title="Dismiss for 24 hours" aria-label="Dismiss: ${esc(x.title)}">×</button>
      <span class="insight-title">${esc(x.title)}</span>
      <span class="insight-detail">${esc(x.detail)}</span></div>`)
        .join("") + restore;
  }
  root.querySelectorAll(".insight").forEach((el) => {
    const x = list[+el.dataset.idx];
    const go = () => x.at && state.map.flyTo(x.at, 9);
    el.addEventListener("click", (e) => {
      if (!e.target.closest(".insight-x")) go();
    });
    el.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target === el) {
        e.preventDefault();
        go();
      }
    });
    el.querySelector(".insight-x").addEventListener("click", () => {
      store.set("dismissedInsights", JSON.stringify({ ...dismissedInsights(), [insightKey(x)]: Date.now() }));
      renderInsights();
    });
  });
  root.querySelector(".insights-restore")?.addEventListener("click", () => {
    store.set("dismissedInsights", "{}");
    renderInsights();
  });
}

// ---- Boundaries -------------------------------------------------------------------------

// Networks whose (approximate) service area overlaps a polygon, judged from points sampled
// along the polygon's rings and a grid inside its bounds.
function networksIn(geometry) {
  if (!geometry || !state.boundaries) return [];
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const pts = [];
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const poly of polys) {
    const ring = poly[0];
    const step = Math.max(1, Math.floor(ring.length / 40));
    for (let i = 0; i < ring.length; i += step) pts.push(ring[i]);
    for (const [x, y] of ring) [w, s, e, n] = [Math.min(w, x), Math.min(s, y), Math.max(e, x), Math.max(n, y)];
  }
  for (let i = 1; i < 6; i++) for (let j = 1; j < 6; j++) {
    const p = [w + ((e - w) * i) / 6, s + ((n - s) * j) / 6];
    if (inMultiPolygon(p[0], p[1], geometry)) pts.push(p);
  }
  const hit = new Set();
  for (const f of state.boundaries.features) if (pts.some(([x, y]) => inMultiPolygon(x, y, f.geometry))) hit.add(f.properties.network);
  return Object.keys(NETWORKS).filter((k) => hit.has(k)).map((k) => NETWORKS[k].name);
}

async function loadBoundaries() {
  try {
    state.boundaries = await getJson("/data/network-boundaries.geojson");
    state.samplePoints = buildSamplePoints(state.boundaries);
    // A contrasting casing under each line keeps very dark/light network colours visible.
    layers.boundaryCasing = L.geoJSON(state.boundaries, { pane: "boundaries", interactive: false, style: { weight: 5.5, fill: false, lineJoin: "round" } });
    layers.boundaries = L.geoJSON(state.boundaries, {
      pane: "boundaries",
      style: { weight: 2.6, lineJoin: "round" },
      onEachFeature: (f, layer) => layer.bindTooltip(`${f.properties.name} service area (approx.)`, { sticky: true }),
    });
    syncBoundaries();
  } catch (error) {
    toast(`Network boundaries failed to load: ${error.message}`);
  }
}

// One dark halo works on every background: on dark maps the bright line carries the
// contrast, on light maps and weather colours the halo does (see DEFAULT_COLORS).
function casingColor() {
  return HALO;
}

function syncBoundaries() {
  if (!layers.boundaries) return;
  const s = getSettings();
  const shown = (l) => $("#t-boundaries").checked && state.visible.has(l.feature.properties.network);
  layers.boundaryCasing.eachLayer((l) => l.setStyle({ color: casingColor(), opacity: shown(l) && s.boundaryCasing ? 0.9 : 0 }));
  layers.boundaries.eachLayer((l) => {
    const color = NETWORKS[l.feature.properties.network].color;
    l.setStyle({ color, fillColor: color, opacity: shown(l) ? 1 : 0, fillOpacity: shown(l) ? s.boundaryFill : 0 });
  });
  if (!state.map.hasLayer(layers.boundaryCasing)) layers.boundaryCasing.addTo(state.map);
  if (!state.map.hasLayer(layers.boundaries)) layers.boundaries.addTo(state.map);
}

// ---- Settings changes -------------------------------------------------------------------

let recolorFrame = null;
function onSettingChange(key) {
  const s = getSettings();
  if (key === "theme") {
    applyTheme();
    applyBasemap();
    syncBoundaries();
    updateLeaders();
    refreshTrends();
    repaintEvents();
  }
  if (key === "colors") {
    setNetworkColors(s.colors);
    // Coalesce rapid picker input into one redraw per frame.
    cancelAnimationFrame(recolorFrame);
    recolorFrame = requestAnimationFrame(() => {
      document.querySelectorAll("#net-filter .chip").forEach((c) => c.style.setProperty("--c", NETWORKS[c.dataset.net].color));
      syncBoundaries();
      renderAll();
      refreshTrends();
    repaintEvents();
    });
  }
  if (key === "weatherOpacity") layers.wind?.setOpacity(s.weatherOpacity);
  if (key === "basemap" || key === "basemapNoWeather") applyBasemap();
  if (key === "boundaryFill" || key === "boundaryCasing") syncBoundaries();
  if (key === "liveInterval" && $("#live-toggle").checked) setLive(true);
}

// ---- Weather controls -------------------------------------------------------------------

const WINDY_OVERLAY = { speed: "wind", gust: "gust", rain: "rain", temp: "temp" };

function setVariable(variable) {
  state.variable = variable;
  store.set("weatherLayer", variable);
  document.querySelectorAll("#weather-layers button").forEach((b) => b.classList.toggle("active", b.dataset.layer === variable));
  if (state.windy) {
    state.windy.store.set("overlay", WINDY_OVERLAY[variable] ?? "wind");
  } else {
    layers.wind.setVariable(variable);
  }
  // Arrows/animation only make sense on a wind layer.
  $("#wind-style-row").hidden = !(variable === "speed" || variable === "gust");
  renderLegend();
  applyBasemap();
}

function setWindStyle(style) {
  state.windStyle = style;
  store.set("windStyle", style);
  document.querySelectorAll("#wind-style button").forEach((b) => b.classList.toggle("active", b.dataset.style === style));
  if (state.windy) state.windy.store.set("particlesAnim", style === "animated" ? "on" : "off");
  else layers.wind.setWindStyle(style);
}

function renderLegend() {
  const el = $("#legend");
  const scale = SCALES[state.variable];
  const before = legendHeight();
  el.hidden = !!state.windy || !scale;
  if (!el.hidden) {
    const gradient = scale.stops.map(([v, c], i) => `${c} ${(i / (scale.stops.length - 1)) * 100}%`).join(",");
    el.innerHTML = `<span class="legend-unit">${scale.unit}</span><div class="legend-bar" style="background:linear-gradient(90deg,${gradient})">${scale.stops.map(([v]) => `<span>${v}</span>`).join("")}</div>`;
  }
  legendsChanged(before);
}

// The legend stack sits above the timeline at lower right; re-place callouts when it resizes.
function legendsChanged(before) {
  if (Math.abs(legendHeight() - before) > 2 && layers.windCallouts) renderWindCallouts();
}


function setupTimeline() {
  if (!state.weather) return;
  const slider = $("#time-slider");
  slider.max = String(state.weather.times.length - 1);
  slider.value = String(state.t);
  $("#time-ticks").innerHTML = state.weather.times
    .map((iso, i) => {
      const h = +new Intl.DateTimeFormat("en-AU", { timeZone: TZ, hour: "numeric", hour12: false }).format(new Date(iso));
      return h === 0 ? `<span style="--p:${trackFraction(i)}">${new Intl.DateTimeFormat("en-AU", { timeZone: TZ, weekday: "short", day: "numeric" }).format(new Date(iso))}</span>` : "";
    })
    .join("");
  updateTimeLabel();
}

// Position along the slider as a 0–1 fraction; CSS offsets it by the thumb radius so
// markers line up with the thumb's centre.
function trackFraction(i) {
  return i / Math.max(1, state.weather.times.length - 1);
}

function updateTimeLabel() {
  if (!state.weather) return;
  const now = nowIndex(state.weather);
  const diff = state.t - now;
  $("#time-label").innerHTML = `${esc(hourLabel(state.weather.times[state.t]))}<small>${diff === 0 ? "now" : diff > 0 ? `+${diff} h forecast` : `${diff} h`}</small>`;
  $("#now-marker").style.setProperty("--p", trackFraction(now));
  $("#time-slider").style.setProperty("--frac", trackFraction(state.t));
  $("#now-marker").title = `Now: ${hourLabel(state.weather.times[now])}`;
  const atNow = diff === 0;
  $("#now-button").disabled = atNow;
  $("#timebar").classList.toggle("off-now", !atNow);
}

function setTime(t, { follow = false } = {}) {
  state.t = t;
  state.followNow = follow || (state.weather && t === nowIndex(state.weather));
  $("#time-slider").value = String(t);
  layers.wind?.setTime(t);
  updateTimeLabel();
  renderWindCallouts();
}

function stopPlay() {
  clearInterval(state.playTimer);
  state.playTimer = null;
  $("#play-button").classList.remove("playing");
}

function snapToNow() {
  if (!state.weather) return;
  stopPlay();
  setTime(nowIndex(state.weather), { follow: true });
}

// ---- Rain radar (RainViewer, observed) ---------------------------------------------------

async function setRadar(on) {
  if (layers.radar) state.map.removeLayer(layers.radar);
  layers.radar = null;
  if (!on) return;
  try {
    const meta = await getJson("https://api.rainviewer.com/public/weather-maps.json");
    const frame = meta.radar?.past?.at(-1);
    if (!frame) throw new Error("no radar frames available");
    layers.radar = L.tileLayer(`${meta.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, { pane: "radar", opacity: 0.75, maxNativeZoom: 7, maxZoom: 14, attribution: '<a href="https://www.rainviewer.com/">RainViewer</a>' }).addTo(state.map);
    toast(`Radar frame ${shortTime(new Date(frame.time * 1000).toISOString())}`, 3000);
  } catch (error) {
    $("#t-radar").checked = false;
    toast(`Rain radar unavailable: ${error.message}`);
  }
}

// ---- Live mode --------------------------------------------------------------------------

function setLive(on) {
  clearInterval(state.liveTimer);
  const seconds = +store.get("liveInterval", "120");
  $("#live-toggle").checked = on;
  $("#live-label").textContent = on ? `Live · ${seconds >= 60 ? `${seconds / 60} min` : `${seconds}s`}` : "Manual";
  document.body.classList.toggle("is-live", on);
  store.set("live", on ? "1" : "0");
  if (on) state.liveTimer = setInterval(() => refresh(), seconds * 1000);
}

// ---- Views (Map / Trends / Events / Admin) ---------------------------------------------

// Routes: #trends, #events, #events/<id>, #admin, #admin/<tab>; no hash = map.
function parseRoute() {
  const m = location.hash.match(/^#(map|trends|events|admin)(?:\/(\w+))?$/);
  return m ? { view: m[1], id: m[2] == null ? null : /^\d+$/.test(m[2]) ? +m[2] : m[2] } : null;
}

function setView(view, id = null) {
  if (view === "admin" && document.body.dataset.role !== "admin") view = "map";
  state.view = view;
  document.body.classList.toggle("view-page", view !== "map");
  $("#trends").hidden = view !== "trends";
  $("#events").hidden = view !== "events";
  $("#admin").hidden = view !== "admin";
  document.querySelectorAll(".sb-item[data-view], #mobile-tabs [data-tab]").forEach((b) => {
    const on = (b.dataset.view ?? b.dataset.tab) === view;
    b.classList.toggle("active", on);
    b.setAttribute("aria-current", on ? "page" : "false");
  });
  if (isPhone()) window.scrollTo(0, 0);
  $("#sb-layers-group").hidden = view !== "map";
  const hash = view === "map" ? "" : `#${view}${id != null ? `/${id}` : ""}`;
  if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname);
  closeSidebar();
  if (view === "trends") loadTrends();
  else if (view === "events") showEvents(id);
  else if (view === "admin") showAdmin(id);
  else {
    state.map?.invalidateSize();
    renderWindCallouts();
  }
}

// ---- Sidebar (rail → flyout → pinned) and output windows ---------------------------------

function setSidebar({ open = document.body.classList.contains("sb-open"), pinned = document.body.classList.contains("sb-pinned") } = {}) {
  const wasPinned = document.body.classList.contains("sb-pinned");
  document.body.classList.toggle("sb-pinned", pinned);
  document.body.classList.toggle("sb-open", open && !pinned);
  $("#sb-scrim").hidden = !(open && !pinned);
  $("#sb-toggle").setAttribute("aria-expanded", String(open || pinned));
  $("#sb-toggle").title = open || pinned ? "Collapse sidebar" : "Expand sidebar";
  if (!isPhone()) store.set("sidebarPinned", pinned ? "1" : "0"); // phones never pin
  if (pinned !== wasPinned && state.map) {
    // Reserved space changed: shift the map so the same area stays centred in the visible
    // part, and keep callouts inside it.
    const css = getComputedStyle(document.documentElement);
    const delta = parseFloat(css.getPropertyValue("--sb-open")) - parseFloat(css.getPropertyValue("--rail"));
    if (state.view === "map") state.map.panBy([pinned ? -delta / 2 : delta / 2, 0], { animate: false });
    renderWindCallouts();
    updateLeaders();
  }
}

// Collapse the outputs column to its summary strip, or expand it (desktop only; phones stack
// it below the map).
function setOutputs(collapsed) {
  const was = document.body.classList.contains("out-collapsed");
  const now = collapsed && !isPhone();
  document.body.classList.toggle("out-collapsed", now);
  $("#out-toggle").setAttribute("aria-expanded", String(!now));
  $("#out-toggle").title = now ? "Expand intelligence panel" : "Collapse intelligence panel";
  if (!isPhone()) store.set("outputsCollapsed", collapsed ? "1" : "0");
  if (now !== was && state.map) {
    // Same as the sidebar: keep the same area centred in the visible part of the map.
    const css = getComputedStyle(document.documentElement);
    const delta = parseFloat(css.getPropertyValue("--out-w")) - parseFloat(css.getPropertyValue("--out-mini-w"));
    if (state.view === "map") state.map.panBy([now ? -delta / 2 : delta / 2, 0], { animate: false });
    renderWindCallouts();
    updateLeaders();
  }
}

function closeSidebar() {
  if (document.body.classList.contains("sb-open")) setSidebar({ open: false });
}

// Switch between the desktop overlay layout and the phone layout (also on rotate/resize).
function applyPhoneLayout() {
  const phone = isPhone();
  document.body.classList.toggle("phone", phone);
  if (!phone) document.body.classList.remove("map-expanded");
  setSidebar({ open: false, pinned: !phone && store.get("sidebarPinned", "0") === "1" });
  setOutputs(store.get("outputsCollapsed", "0") === "1");
  if (!state.map) return;
  state.map.invalidateSize();
  fitVictoria();
  renderWindCallouts();
}

// Phone only: grow the map to the full screen height and back.
function addMapExpandControl() {
  const Expand = L.Control.extend({
    onAdd() {
      const b = L.DomUtil.create("button", "map-expand");
      b.type = "button";
      b.id = "map-expand";
      b.title = "Expand map";
      b.setAttribute("aria-pressed", "false");
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" /></svg>';
      L.DomEvent.disableClickPropagation(b);
      L.DomEvent.on(b, "click", () => {
        const expanded = document.body.classList.toggle("map-expanded");
        b.setAttribute("aria-pressed", String(expanded));
        b.title = expanded ? "Shrink map" : "Expand map";
        window.scrollTo(0, 0);
        requestAnimationFrame(() => state.map.invalidateSize());
      });
      return b;
    },
  });
  new Expand({ position: "topright" }).addTo(state.map);
}

function wireLayout() {
  applyPhoneLayout();
  phoneQuery.addEventListener("change", applyPhoneLayout);
  addMapExpandControl();
  document.querySelectorAll("#mobile-tabs [data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.tab === "menu") setSidebar({ open: !document.body.classList.contains("sb-open") });
      else setView(b.dataset.tab);
    }),
  );
  document.querySelectorAll(".sb-item[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  $("#sb-layers-btn").addEventListener("click", () => {
    if (document.body.classList.contains("sb-pinned")) return;
    setSidebar({ open: !document.body.classList.contains("sb-open") });
  });
  // Expanding from the top button keeps the sidebar open (pinned, remembered) until it is
  // collapsed again; the rail's Map layers button still opens a temporary flyout.
  $("#sb-toggle").addEventListener("click", () => {
    const expanded = document.body.classList.contains("sb-open") || document.body.classList.contains("sb-pinned");
    setSidebar({ open: false, pinned: !expanded });
  });
  $("#sb-scrim").addEventListener("click", closeSidebar);
  $("#out-toggle").addEventListener("click", () => setOutputs(!document.body.classList.contains("out-collapsed")));
  $("#out-mini").addEventListener("click", () => setOutputs(false));
  document.addEventListener("keydown", (e) => e.key === "Escape" && !document.querySelector("dialog[open]") && closeSidebar());

  const collapsed = new Set(JSON.parse(store.get("collapsedWindows", "[]")));
  document.querySelectorAll(".window").forEach((win) => {
    const head = win.querySelector(".win-head");
    const apply = () => {
      const isCollapsed = collapsed.has(win.dataset.win);
      win.classList.toggle("collapsed", isCollapsed);
      head.setAttribute("aria-expanded", String(!isCollapsed));
    };
    apply();
    head.addEventListener("click", () => {
      collapsed.has(win.dataset.win) ? collapsed.delete(win.dataset.win) : collapsed.add(win.dataset.win);
      store.set("collapsedWindows", JSON.stringify([...collapsed]));
      apply();
    });
  });
}

// ---- Boot -------------------------------------------------------------------------------

function wireControls() {
  $("#refresh-button").addEventListener("click", () => refresh({ force: true }));
  $("#live-toggle").addEventListener("change", (e) => setLive(e.target.checked));
  document.querySelectorAll("#weather-layers button").forEach((b) => b.addEventListener("click", () => setVariable(b.dataset.layer)));
  document.querySelectorAll("#wind-style button").forEach((b) => b.addEventListener("click", () => setWindStyle(b.dataset.style)));
  $("#t-radar").addEventListener("change", (e) => setRadar(e.target.checked));
  $("#t-boundaries").addEventListener("change", syncBoundaries);
  $("#t-clusters").addEventListener("change", renderClusters);
  $("#t-areas").addEventListener("change", renderAreas);
  $("#t-windcallouts").addEventListener("change", renderWindCallouts);
  $("#t-labels").addEventListener("change", renderLabels);
  $("#t-planned").addEventListener("change", renderAll);

  const filter = $("#net-filter");
  filter.innerHTML = Object.entries(NETWORKS)
    .map(([k, m]) => `<button type="button" class="chip active" data-net="${k}" style="--c:${m.color}">${esc(m.name)}</button>`)
    .join("");
  filter.querySelectorAll(".chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      const net = chip.dataset.net;
      state.visible.has(net) ? state.visible.delete(net) : state.visible.add(net);
      chip.classList.toggle("active", state.visible.has(net));
      syncBoundaries();
      renderAll();
    }),
  );

  $("#time-slider").addEventListener("input", (e) => setTime(+e.target.value));
  $("#play-button").addEventListener("click", () => {
    if (state.playTimer) return stopPlay();
    $("#play-button").classList.add("playing");
    state.playTimer = setInterval(() => setTime(state.weather ? (state.t + 1) % state.weather.times.length : 0), 900);
  });
  $("#now-button").addEventListener("click", snapToNow);
  $("#now-marker").addEventListener("click", snapToNow);
  // Move the now line as hours roll over, and keep following it if the user is on "now".
  setInterval(() => {
    if (!state.weather) return;
    const now = nowIndex(state.weather);
    if (state.followNow && !state.playTimer && state.t !== now) setTime(now, { follow: true });
    else updateTimeLabel();
  }, 60000);

  initSettings(onSettingChange, () => state.outages);
  const basemapSelect = $("#basemap-select");
  basemapSelect.addEventListener("change", (e) => setSetting(basemapKeyInUse(), e.target.value));
  syncBasemapSelect();

  state.map.on("move zoom viewreset", updateLeaders);
  window.addEventListener("resize", () => renderWindCallouts());
  state.map.on("zoomend", () => {
    renderClusters();
    renderAreas();
    renderLabels();
  });
  $("#reset-callouts").addEventListener("click", () => {
    state.calloutPositions = {};
    state.labelPositions = {};
    state.hiddenCallouts.clear();
    store.set("dockedCallouts", "{}");
    store.set("labelPositions", "{}");
    store.set("hiddenCallouts", "[]");
    fitVictoria();
    renderLabels();
    renderWindCallouts();
  });
}

// Disclaimer: shown on every app open and closed only with "I understand" (not Esc or a
// backdrop click). The same text heads Settings → About.
function showDisclaimer() {
  const text = $("#disclaimer-template").content;
  document.querySelectorAll("[data-disclaimer]").forEach((el) => el.replaceChildren(text.cloneNode(true)));
  $("#disclaimer-version").textContent = `Version ${__APP_VERSION__}`;
  const dialog = $("#disclaimer");
  let accepted = false;
  dialog.addEventListener("cancel", (e) => e.preventDefault());
  dialog.addEventListener("close", () => !accepted && dialog.showModal());
  $("#disclaimer-ok").addEventListener("click", () => {
    accepted = true;
    dialog.close();
  });
  dialog.showModal();
  $("#disclaimer-ok").focus();
}

async function boot() {
  await requireUser();
  showDisclaimer();
  const settings = loadSettings(store);
  setNetworkColors(settings.colors);
  applyTheme();
  const key = store.get("windyKey", "") || import.meta.env.VITE_WINDY_KEY || "";
  if (key) {
    try {
      state.windy = await initWindy(key);
      state.map = state.windy.map;
      document.body.classList.add("windy-mode");
      $("#weather-source").textContent = "Windy";
      document.querySelector('#weather-layers [data-layer="none"]').hidden = true;
      $("#basemap-row").hidden = true;
      if (state.variable === "none") state.variable = "speed";
      // Windy has no static arrows; only its particle animation can be toggled.
      document.querySelector('#wind-style [data-style="arrows"]').hidden = true;
      if (state.windStyle === "arrows") state.windStyle = "none";
      // Keep our "strongest wind" callouts in step with Windy's own timeline.
      state.windy.store.on("timestamp", (ts) => {
        if (!state.weather) return;
        state.t = nowIndex(state.weather, ts);
        renderWindCallouts();
      });
    } catch (error) {
      console.error(error);
      toast(`Windy unavailable (${error.message}). Using built-in weather layers.`, 9000);
      // Windy may have restructured/styled #windy; start the fallback on a clean container.
      const fresh = document.createElement("div");
      fresh.id = "map-fallback";
      fresh.className = "map-root";
      document.getElementById("windy").replaceWith(fresh);
    }
  }
  if (!state.map) state.map = initLeaflet();

  createPanes(state.map);
  layers.clusters = L.layerGroup().addTo(state.map);
  layers.areas = L.layerGroup().addTo(state.map);
  layers.labels = L.layerGroup().addTo(state.map);
  layers.windCallouts = L.layerGroup().addTo(state.map);
  if (!state.windy) layers.wind = new WindField({ variable: state.variable, windStyle: state.windStyle, opacity: settings.weatherOpacity }).addTo(state.map);

  wireLayout(); // applies the saved sidebar pin before the map is framed
  fitVictoria();
  wireControls();
  initTrends({
    names: Object.fromEntries(Object.entries(NETWORKS).map(([k, m]) => [k, m.name])),
    colors: () => Object.fromEntries(Object.entries(NETWORKS).map(([k, m]) => [k, m.color])),
    getLive: () => state.outages,
    store,
  });
  initEvents({
    names: Object.fromEntries(Object.entries(NETWORKS).map(([k, m]) => [k, m.name])),
    colors: () => Object.fromEntries(Object.entries(NETWORKS).map(([k, m]) => [k, m.color])),
    store,
    toast,
    onActiveChange: () => updateStartButton(),
  });
  initAdmin({ toast, names: Object.fromEntries(Object.entries(NETWORKS).map(([k, m]) => [k, m.name])) }); // before routing: turns ?admin= links into #admin/…
  window.addEventListener("hashchange", () => {
    const r = parseRoute();
    setView(r?.view ?? "map", r?.id ?? null);
  });
  const route = parseRoute();
  setView(route ? route.view : settings.defaultView, route?.id ?? null);
  setWindStyle(state.windStyle);
  setVariable(state.variable);
  await loadBoundaries();
  let legendBefore = legendHeight();
  initFdpLayer({
    map: state.map,
    store,
    onChange: () => renderInsights(),
    onLegendChange: () => {
      legendsChanged(legendBefore);
      legendBefore = legendHeight();
    },
    networksIn,
  });
  initFireLayer({
    map: state.map,
    store,
    toast,
    onChange: () => renderInsights(),
    onLegendChange: () => {
      legendsChanged(legendBefore);
      legendBefore = legendHeight();
    },
  });
  initUsers({ toast });
  setLive(store.get("live", "0") === "1");
  await refresh();
}

boot();
