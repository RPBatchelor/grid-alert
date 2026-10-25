// CFA Fire Danger Ratings / Total Fire Bans as a map layer: the 9 fire districts filled with
// the official rating colours for a selected forecast day, plus alerts for the intelligence
// panel. Data: /api/fire-danger (CFA RSS); geography: /data/fire-districts.geojson (Vicmap).
const L = window.L;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Australian Fire Danger Rating System colours, as used by CFA.
export const FDR = {
  "NO RATING": { label: "No rating", color: "#ffffff", ink: "#13202a", level: 0 },
  MODERATE: { label: "Moderate", color: "#64bf30", ink: "#0d2a06", level: 1 },
  HIGH: { label: "High", color: "#ffe500", ink: "#2b2600", level: 2 },
  EXTREME: { label: "Extreme", color: "#f28a1d", ink: "#2d1400", level: 3 },
  CATASTROPHIC: { label: "Catastrophic", color: "#b11f24", ink: "#ffffff", level: 4 },
};
const TFB_COLOR = "#e5484d";

// Label anchors inside each district (more reliable than centroids for these shapes).
const LABEL_AT = {
  Mallee: [-35.25, 142.25],
  Wimmera: [-36.75, 141.95],
  "South West": [-37.95, 142.45],
  "Northern Country": [-36.2, 145.0],
  "North Central": [-37.2, 143.55],
  Central: [-37.5, 144.4],
  "North East": [-36.6, 146.95],
  "East Gippsland": [-37.3, 148.75],
  "West and South Gippsland": [-38.35, 146.3],
};

let ctx; // { map, store, toast, onChange }
const fire = { data: null, districts: null, layer: null, labels: null, day: 0, enabled: false, error: null };

function dayLabel(d, i) {
  if (i === 0) return "Today";
  if (i === 1) return "Tomorrow";
  const date = d.date ? new Date(`${d.date}T12:00`) : null;
  return date ? date.toLocaleDateString("en-AU", { weekday: "short", day: "numeric" }) : d.title;
}

function districtState(name) {
  const day = fire.data?.days[fire.day];
  return day?.districts[name] ?? null;
}

function style(feature) {
  const d = districtState(feature.properties.district);
  const r = FDR[d?.rating] ?? FDR["NO RATING"];
  const tfb = !!d?.tfb;
  return {
    pane: "fire",
    color: tfb ? TFB_COLOR : "#3b4650",
    weight: tfb ? 3.5 : 1.2,
    opacity: tfb ? 1 : 0.7,
    dashArray: tfb ? "8 5" : null,
    fillColor: r.color,
    fillOpacity: d?.rating && d.rating !== "NO RATING" ? 0.5 : 0.12,
  };
}

function popupHtml(name) {
  const rows = (fire.data?.days ?? [])
    .map((day, i) => {
      const d = day.districts[name];
      const r = FDR[d?.rating] ?? FDR["NO RATING"];
      return `<tr${i === fire.day ? ' class="sel"' : ""}><td>${esc(dayLabel(day, i))}</td><td><span class="fdr-chip" style="--fc:${r.color};--fi:${r.ink}">${r.label}</span></td><td>${d?.tfb ? '<b class="tfb">TOTAL FIRE BAN</b>' : "No TFB"}</td></tr>`;
    })
    .join("");
  const day = fire.data?.days[fire.day];
  return `<div class="pop fire-pop"><div class="pop-head">${esc(name)} fire district</div>
    <table class="fire-days-table">${rows}</table>
    <div class="dim">BoM forecast issued ${esc(day?.issued ?? "—")} · Source: CFA</div></div>`;
}

function render() {
  if (!fire.districts || !ctx.map) return;
  if (!fire.layer) {
    fire.layer = L.geoJSON(fire.districts, {
      pane: "fire",
      style,
      onEachFeature: (f, layer) => layer.bindPopup(() => popupHtml(f.properties.district), { maxWidth: 360 }),
    });
    fire.labels = L.layerGroup();
  }
  fire.layer.setStyle(style);
  fire.labels.clearLayers();
  for (const f of fire.districts.features) {
    const name = f.properties.district;
    const d = districtState(name);
    const r = FDR[d?.rating] ?? FDR["NO RATING"];
    const html = `<div class="fire-label${d?.tfb ? " tfb" : ""}"><span class="fire-name">${esc(name)}</span><span class="fdr-chip" style="--fc:${r.color};--fi:${r.ink}">${fire.data ? r.label : "…"}</span>${d?.tfb ? '<span class="tfb-badge">TOTAL FIRE BAN</span>' : ""}</div>`;
    fire.labels.addLayer(L.marker(LABEL_AT[name] ?? [-37, 145], { pane: "fireLabels", interactive: false, keyboard: false, icon: L.divIcon({ className: "", html, iconSize: [0, 0] }) }));
  }
  const show = fire.enabled;
  for (const l of [fire.layer, fire.labels]) {
    if (show && !ctx.map.hasLayer(l)) l.addTo(ctx.map);
    if (!show && ctx.map.hasLayer(l)) ctx.map.removeLayer(l);
  }
  renderControls();
  renderLegend();
}

function renderControls() {
  const days = $("#fire-days");
  days.hidden = !fire.enabled || !fire.data;
  if (fire.data) {
    days.replaceChildren(
      ...fire.data.days.map((d, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = dayLabel(d, i);
        b.className = i === fire.day ? "active" : "";
        b.setAttribute("aria-pressed", String(i === fire.day));
        if (d.anyTfb) b.classList.add("has-tfb");
        b.title = d.anyTfb ? "Total Fire Ban declared in at least one district" : d.title;
        b.addEventListener("click", () => {
          fire.day = i;
          render();
        });
        return b;
      }),
    );
  }
  const status = $("#fire-status");
  status.textContent = fire.error
    ? `CFA feed unavailable: ${fire.error}`
    : fire.data
      ? `BoM forecast issued ${fire.data.days[fire.day]?.issued ?? "—"}${fire.data.stale ? " (showing last good data)" : ""}`
      : fire.enabled
        ? "Loading CFA ratings…"
        : "";
  status.classList.toggle("bad", !!fire.error || !!fire.data?.stale);
}

function renderLegend() {
  const el = $("#legend-fire");
  if (!el) return;
  el.hidden = !fire.enabled;
  if (el.hidden) return ctx.onLegendChange?.();
  el.innerHTML = `<span class="legend-unit">Fire danger${fire.data ? ` · ${esc(dayLabel(fire.data.days[fire.day], fire.day))}` : ""}</span>${Object.values(FDR)
    .map((r) => `<span class="fdr-chip" style="--fc:${r.color};--fi:${r.ink}">${r.label}</span>`)
    .join("")}<span class="tfb-key">TFB</span>`;
  ctx.onLegendChange?.();
}

export async function refreshFire() {
  try {
    const res = await fetch("/api/fire-danger");
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    fire.data = body;
    fire.error = body.ok === false ? body.error : null;
    if (fire.day >= body.days.length) fire.day = 0;
  } catch (error) {
    fire.error = error.message;
  }
  render();
  ctx.onChange?.();
}

// Alerts for the automated intelligence panel (always computed, even when the layer is off).
export function fireInsights() {
  const out = [];
  const days = fire.data?.days ?? [];
  days.slice(0, 3).forEach((day, i) => {
    const when = dayLabel(day, i);
    const tfb = Object.entries(day.districts).filter(([, d]) => d.tfb).map(([n]) => n);
    if (tfb.length) {
      out.push({ severity: i === 0 ? "severe" : "high", color: TFB_COLOR, title: `Total Fire Ban ${i === 0 ? "in force" : "declared"} — ${when}`, detail: `${tfb.join(", ")}. Review network operating restrictions and fire-risk works.`, at: LABEL_AT[tfb[0]] });
    }
    const byLevel = {};
    for (const [n, d] of Object.entries(day.districts)) if (FDR[d.rating]?.level >= 2) (byLevel[d.rating] ??= []).push(n);
    for (const rating of ["CATASTROPHIC", "EXTREME", "HIGH"]) {
      const names = byLevel[rating];
      if (!names) continue;
      out.push({ severity: rating === "CATASTROPHIC" ? "severe" : rating === "EXTREME" ? "high" : "elevated", color: FDR[rating].color === "#ffffff" ? "#9ab" : FDR[rating].color, title: `${FDR[rating].label} fire danger — ${when}`, detail: `${names.join(", ")} fire district${names.length > 1 ? "s" : ""} (CFA, BoM forecast ${day.issued ?? ""}).`, at: LABEL_AT[names[0]] });
    }
  });
  return out;
}

export function setFireEnabled(on) {
  fire.enabled = on;
  ctx.store.set("fireLayer", on ? "1" : "0");
  $("#t-fire").checked = on;
  if (on && !fire.data) refreshFire();
  render();
}

export async function initFireLayer(context) {
  ctx = context;
  const map = ctx.map;
  for (const [name, z] of [["fire", 380], ["fireLabels", 640]]) {
    if (!map.getPane(name)) map.createPane(name);
    map.getPane(name).style.zIndex = z;
  }
  map.getPane("fireLabels").style.pointerEvents = "none";
  $("#t-fire").addEventListener("change", (e) => setFireEnabled(e.target.checked));
  try {
    const res = await fetch("/data/fire-districts.geojson");
    fire.districts = await res.json();
  } catch (error) {
    fire.error = `fire district boundaries failed to load (${error.message})`;
  }
  setFireEnabled(ctx.store.get("fireLayer", "0") === "1");
  refreshFire();
}
