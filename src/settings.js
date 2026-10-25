// Settings: persisted preferences plus the sectioned settings dialog.
// Changes apply immediately (no Save step), except the Windy key, which needs a reload.
import { BASEMAPS, previewUrl } from "./basemaps.js";
import { contrast } from "./color.js";
import { DEFAULT_COLORS, NETWORKS } from "./intel.js";

const DEFAULTS = {
  theme: "dark", // dark | light | system
  defaultView: "map", // map | trends
  colors: { ...DEFAULT_COLORS },
  weatherOpacity: 0.62,
  boundaryFill: 0.06,
  boundaryCasing: true,
  basemap: "auto", // auto | key of BASEMAPS
  basemapNoWeather: "light-gray", // same | auto | key of BASEMAPS — used when the weather layer is Off
};

let store;
let onChange;
let settings;
const $ = (s) => document.querySelector(s);

export function loadSettings(storage) {
  store = storage;
  let saved = {};
  try {
    saved = JSON.parse(store.get("settings", "{}"));
  } catch {
    /* corrupt value: fall back to defaults */
  }
  // Only colours that differ from the defaults are stored, so changing a default reaches
  // everyone who has not customised that network. Values equal to a former default are
  // treated as "not customised".
  const overrides = Object.fromEntries(Object.entries(saved.colors ?? {}).filter(([net, c]) => c && !FORMER_DEFAULTS.some((set) => set[net] === c.toLowerCase())));
  settings = { ...DEFAULTS, ...saved, colors: { ...DEFAULT_COLORS, ...overrides } };
  return settings;
}

const FORMER_DEFAULTS = [
  { ausnet: "#253a69", citipower: "#b01243", powercor: "#dc2a23", jemena: "#7dcde4", ue: "#9a258f" },
  { ausnet: "#ffcb08", powercor: "#3ccf8e", citipower: "#33c6f0", jemena: "#ff6a3d", ue: "#a97bff" },
];

function persist() {
  const colors = Object.fromEntries(Object.entries(settings.colors).filter(([net, c]) => c.toLowerCase() !== DEFAULT_COLORS[net]));
  store.set("settings", JSON.stringify({ ...settings, colors }));
}

export const getSettings = () => settings;

export function setSetting(key, value) {
  set(key, value);
  if (key === "basemap" && document.querySelector("#settings").open) renderBasemapCards();
}

function set(key, value) {
  settings[key] = value;
  persist();
  onChange?.(key, value);
}

// ---- Theme ------------------------------------------------------------------------------

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function resolvedTheme() {
  return settings.theme === "system" ? (darkQuery.matches ? "dark" : "light") : settings.theme;
}

export function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0b1217" : "#eef2f4");
  return theme;
}

// ---- Colour helpers -----------------------------------------------------------------------

const validHex = (v) => /^#[0-9a-f]{6}$/i.test(v);
export const HALO = "#0b1217"; // dark outline drawn under every network line

// ---- Dialog -----------------------------------------------------------------------------

function showSection(name) {
  document.querySelectorAll(".settings-nav [data-section]").forEach((b) => {
    const on = b.dataset.section === name;
    b.classList.toggle("active", on);
    b.setAttribute("aria-current", on ? "page" : "false");
  });
  document.querySelectorAll(".settings-body [data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
  store.set("settingsSection", name);
}

function renderThemeChoice() {
  document.querySelectorAll("[data-theme-choice]").forEach((b) => {
    const on = b.dataset.themeChoice === settings.theme;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", String(on));
  });
}

function renderColorRows() {
  const root = $("#color-rows");
  root.replaceChildren();
  for (const [net, meta] of Object.entries(NETWORKS)) {
    const value = settings.colors[net];
    const row = document.createElement("div");
    row.className = "color-row";
    row.style.setProperty("--c", value);

    const picker = document.createElement("input");
    picker.type = "color";
    picker.value = value;
    picker.className = "color-swatch";
    picker.setAttribute("aria-label", `${meta.name} colour`);

    const name = document.createElement("div");
    name.className = "color-name";
    name.textContent = meta.name;
    const hint = document.createElement("div");
    hint.className = "color-hint";
    // Map lines sit inside a dark halo, so a colour must be light enough to read against it.
    const ratio = contrast(value, HALO);
    hint.textContent = value.toLowerCase() === DEFAULT_COLORS[net] ? "Default" : "Custom";
    if (ratio < 4.5) hint.textContent += ` · too dark to stand out inside the map outline (${ratio.toFixed(1)}:1); try a lighter tone`;
    name.append(hint);

    const hex = document.createElement("input");
    hex.type = "text";
    hex.className = "hex-input";
    hex.value = value;
    hex.maxLength = 7;
    hex.spellcheck = false;
    hex.setAttribute("aria-label", `${meta.name} hex colour`);

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "btn small";
    reset.textContent = "Reset";
    reset.disabled = value.toLowerCase() === DEFAULT_COLORS[net];

    const commit = (v) => {
      if (!validHex(v)) return;
      set("colors", { ...settings.colors, [net]: v.toLowerCase() });
      renderColorRows();
    };
    // Live preview while dragging in the picker; persist on change.
    picker.addEventListener("input", () => {
      row.style.setProperty("--c", picker.value);
      hex.value = picker.value;
      settings.colors[net] = picker.value;
      onChange?.("colors", settings.colors);
    });
    picker.addEventListener("change", () => commit(picker.value));
    hex.addEventListener("change", () => {
      const v = hex.value.trim().replace(/^([0-9a-f]{6})$/i, "#$1");
      if (validHex(v)) commit(v);
      else hex.value = settings.colors[net];
    });
    reset.addEventListener("click", () => commit(DEFAULT_COLORS[net]));

    row.append(picker, name, hex, reset);
    root.append(row);
  }
}

function renderBasemapCards() {
  const root = $("#basemap-cards");
  root.replaceChildren();
  const options = [["auto", "Auto", "Follows light/dark"], ...Object.entries(BASEMAPS).map(([k, b]) => [k, b.name, b.tone === "dark" ? "Dark map" : "Light map"])];
  for (const [key, name, note] of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `basemap-card${settings.basemap === key ? " active" : ""}`;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(settings.basemap === key));
    const thumb = document.createElement("div");
    thumb.className = "basemap-thumb";
    if (key === "auto") {
      thumb.classList.add("split");
      thumb.style.setProperty("--a", `url("${previewUrl("light-gray")}")`);
      thumb.style.setProperty("--b", `url("${previewUrl("dark-gray")}")`);
    } else {
      thumb.style.backgroundImage = `url("${previewUrl(key)}")`;
    }
    const label = document.createElement("div");
    label.className = "basemap-name";
    label.textContent = name;
    const sub = document.createElement("div");
    sub.className = "basemap-note";
    sub.textContent = note;
    b.append(thumb, label, sub);
    b.addEventListener("click", () => {
      set("basemap", key);
      renderBasemapCards();
    });
    root.append(b);
  }
  const noWx = $("#set-basemap-noweather");
  if (!noWx.options.length) {
    noWx.innerHTML = `<option value="same">Keep the selected base map</option><option value="auto">Auto (match light/dark)</option>${Object.entries(BASEMAPS).map(([k, b]) => `<option value="${k}">${b.name}</option>`).join("")}`;
  }
  noWx.value = settings.basemapNoWeather;
}

async function renderHistoryStats() {
  const el = $("#history-stats");
  try {
    const res = await fetch(`/api/history?from=${Date.now() - 3600_000}`);
    const d = await res.json();
    const c = d.coverage;
    el.textContent = c.snapshots
      ? `${c.snapshots.toLocaleString("en-AU")} snapshots stored, from ${new Date(c.first).toLocaleString("en-AU")} to ${new Date(c.last).toLocaleString("en-AU")}.`
      : "No snapshots stored yet.";
  } catch {
    el.textContent = "History unavailable (is the server running?).";
  }
}

function syncControls() {
  renderThemeChoice();
  renderColorRows();
  renderBasemapCards();
  $("#set-default-view").value = settings.defaultView;
  $("#set-weather-opacity").value = String(Math.round(settings.weatherOpacity * 100));
  $("#set-weather-opacity-out").textContent = `${Math.round(settings.weatherOpacity * 100)}%`;
  $("#set-boundary-fill").value = String(Math.round(settings.boundaryFill * 100));
  $("#set-boundary-fill-out").textContent = `${Math.round(settings.boundaryFill * 100)}%`;
  $("#set-casing").checked = settings.boundaryCasing;
  $("#live-interval").value = store.get("liveInterval", "120");
  $("#windy-key").value = store.get("windyKey", "");
  $("#windy-status").textContent = document.body.classList.contains("windy-mode")
    ? "Connected: Windy is the active base map."
    : store.get("windyKey", "")
      ? "Key saved, but Windy did not load. Using built-in layers."
      : "Not configured: using built-in Open-Meteo layers.";
}

// Settings → About: version stamp (from the build) and live feed status.
function renderAbout() {
  const built = new Date(__BUILD_DATE__).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  $("#about-version").textContent = `${__APP_VERSION__}${__APP_COMMIT__ ? ` (${__APP_COMMIT__})` : ""} · built ${built}`;
  const feeds = getFeedStatus?.()?.networks ?? {};
  document.querySelectorAll(".src-status").forEach((dot) => {
    const f = feeds[dot.dataset.feed];
    dot.className = `src-status ${f ? (f.ok ? "ok" : "bad") : "unknown"}`;
    dot.title = f ? (f.ok ? "Last fetch succeeded" : `Last fetch failed: ${f.error}`) : "Not fetched yet";
  });
}

let getFeedStatus;
export function initSettings(handler, feedStatus) {
  onChange = handler;
  getFeedStatus = feedStatus;
  const dialog = $("#settings");

  $("#settings-button").addEventListener("click", () => {
    syncControls();
    renderAbout();
    showSection(store.get("settingsSection", "general"));
    renderHistoryStats();
    dialog.showModal();
  });
  $("#settings-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // backdrop click
  });

  document.querySelectorAll(".settings-nav [data-section]").forEach((b) => b.addEventListener("click", () => showSection(b.dataset.section)));

  document.querySelectorAll("[data-theme-choice]").forEach((b) =>
    b.addEventListener("click", () => {
      set("theme", b.dataset.themeChoice);
      renderThemeChoice();
      renderColorRows();
    }),
  );
  darkQuery.addEventListener("change", () => settings.theme === "system" && onChange?.("theme", "system"));

  $("#set-default-view").addEventListener("change", (e) => set("defaultView", e.target.value));
  $("#set-basemap-noweather").addEventListener("change", (e) => set("basemapNoWeather", e.target.value));

  $("#reset-colors").addEventListener("click", () => {
    set("colors", { ...DEFAULT_COLORS });
    renderColorRows();
  });
  $("#set-weather-opacity").addEventListener("input", (e) => {
    $("#set-weather-opacity-out").textContent = `${e.target.value}%`;
    set("weatherOpacity", +e.target.value / 100);
  });
  $("#set-boundary-fill").addEventListener("input", (e) => {
    $("#set-boundary-fill-out").textContent = `${e.target.value}%`;
    set("boundaryFill", +e.target.value / 100);
  });
  $("#set-casing").addEventListener("change", (e) => set("boundaryCasing", e.target.checked));

  $("#live-interval").addEventListener("change", (e) => {
    store.set("liveInterval", e.target.value);
    onChange?.("liveInterval", +e.target.value);
  });

  $("#windy-key-toggle").addEventListener("click", (e) => {
    const input = $("#windy-key");
    input.type = input.type === "password" ? "text" : "password";
    e.currentTarget.textContent = input.type === "password" ? "Show" : "Hide";
  });
  $("#windy-save").addEventListener("click", () => {
    const value = $("#windy-key").value.trim();
    if (value === store.get("windyKey", "")) return dialog.close();
    store.set("windyKey", value);
    location.reload();
  });
}
