// CFA Fire Danger Period (fire restrictions) by council area. When an area is declared, network
// businesses carry stricter bushfire-mitigation obligations, so the layer shows declared,
// upcoming and partly declared councils, and the intelligence panel flags them by network.
// Data: /api/fire-restrictions (CFA page); geography: /data/fdp-areas.geojson (Vicmap LGA).
const L = window.L;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const SOON_DAYS = 21; // "upcoming" councils starting within this many days are highlighted
const COLORS = { declared: "#b45309", upcoming: "#d97706", partly: "#b45309" };
const STATUS_LABEL = { declared: "Declared", upcoming: "Upcoming", ended: "Ended", "not-declared": "Not yet declared" };

let ctx; // { map, store, onChange, onLegendChange, networksIn(geometry) -> [names] }
const fdp = { data: null, areas: null, layer: null, labels: null, enabled: false, error: null };

const fmtDate = (iso) => (iso ? new Date(`${iso}T12:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "—");
const shortDate = (iso) => new Date(`${iso}T12:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// Combine a council's rows (split councils have several parts) into one map state.
function councilState(lga) {
  const rows = fdp.data?.rows.filter((r) => r.lga === lga) ?? [];
  if (!rows.length) return null;
  const declared = rows.filter((r) => r.status === "declared");
  const upcoming = rows.filter((r) => r.status === "upcoming" && !r.anomaly).sort((a, b) => a.startsInDays - b.startsInDays);
  let state = "none";
  if (declared.length && declared.length === rows.length) state = "declared";
  else if (declared.length) state = "partly";
  else if (upcoming.length && upcoming[0].startsInDays <= SOON_DAYS) state = "soon";
  else if (upcoming.length) state = "later";
  return { rows, state, declared, upcoming, name: titleCase(rows[0].council), anomaly: rows.some((r) => r.anomaly) };
}

function style(feature) {
  const s = councilState(feature.properties.lga);
  const base = { pane: "fdp", color: "#7c4a1e", weight: 0.6, opacity: 0.35, fillOpacity: 0, dashArray: null };
  if (!s) return base;
  switch (s.state) {
    case "declared":
      return { ...base, color: COLORS.declared, weight: 2.2, opacity: 1, fillColor: COLORS.declared, fillOpacity: 0.32 };
    case "partly":
      return { ...base, color: COLORS.partly, weight: 2.2, opacity: 1, dashArray: "6 4", fillColor: COLORS.partly, fillOpacity: 0.16 };
    case "soon":
      return { ...base, color: COLORS.upcoming, weight: 2.4, opacity: 1, dashArray: "3 5", fillColor: COLORS.upcoming, fillOpacity: 0.08 };
    case "later":
      return { ...base, color: COLORS.upcoming, weight: 1.2, opacity: 0.8, dashArray: "3 5" };
    default:
      return base;
  }
}

function labelText(s) {
  if (s.state === "declared") return `Declared since ${shortDate(s.declared[0].start)}`;
  if (s.state === "partly") return `Partly declared (${s.declared.map((r) => titleCase(r.part ?? "")).join(", ")})`;
  const d = s.upcoming[0].startsInDays;
  return d === 1 ? "Starts tomorrow" : `Starts ${shortDate(s.upcoming[0].start)} (${d} days)`;
}

function popupHtml(lga) {
  const s = councilState(lga);
  if (!s) return `<div class="pop"><div class="pop-head">${esc(titleCase(lga))}</div><div class="dim">Not listed by CFA (outside the CFA area).</div></div>`;
  const rows = s.rows
    .map(
      (r) => `<tr><td>${esc(r.part ? titleCase(r.part) : "Whole council")}</td><td><span class="fdp-chip fdp-${r.status}">${STATUS_LABEL[r.status]}</span></td>
      <td>${r.start ? `${esc(fmtDate(r.start))} → ${esc(fmtDate(r.end))}` : esc(r.note ?? "")}${r.anomaly ? `<div class="fdp-anomaly">⚠ ${esc(r.anomaly)}</div>` : ""}</td>
      <td>${r.map ? `<a href="${esc(r.map)}" target="_blank" rel="noopener noreferrer">Map</a>` : ""}</td></tr>`,
    )
    .join("");
  const nets = ctx.networksIn?.(fdp.areas.features.find((f) => f.properties.lga === lga)?.geometry) ?? [];
  return `<div class="pop fdp-pop"><div class="pop-head">${esc(s.name)} — Fire Danger Period</div>
    <table class="fdp-table">${rows}</table>
    ${nets.length ? `<div class="dim">Networks in this area (approx.): ${esc(nets.join(", "))}</div>` : ""}
    <div class="dim">Source: CFA fire restriction dates. Split-council part boundaries are in the CFA PDF maps.</div></div>`;
}

function render() {
  if (!fdp.areas || !ctx.map) return;
  if (!fdp.layer) {
    fdp.layer = L.geoJSON(fdp.areas, { pane: "fdp", style, onEachFeature: (f, layer) => layer.bindPopup(() => popupHtml(f.properties.lga), { maxWidth: 440 }) });
    fdp.labels = L.layerGroup();
  }
  fdp.layer.setStyle(style);
  fdp.labels.clearLayers();
  for (const f of fdp.areas.features) {
    const s = councilState(f.properties.lga);
    if (!s || !["declared", "partly", "soon"].includes(s.state)) continue;
    const html = `<div class="fdp-label fdp-${s.state}"><span class="fdp-name">${esc(s.name)}</span><span class="fdp-when">${esc(labelText(s))}</span></div>`;
    fdp.labels.addLayer(L.marker(f.properties.label, { pane: "fireLabels", interactive: false, keyboard: false, icon: L.divIcon({ className: "", html, iconSize: [0, 0] }) }));
  }
  for (const l of [fdp.layer, fdp.labels]) {
    if (fdp.enabled && !ctx.map.hasLayer(l)) l.addTo(ctx.map);
    if (!fdp.enabled && ctx.map.hasLayer(l)) ctx.map.removeLayer(l);
  }
  renderStatus();
  renderLegend();
}

function renderStatus() {
  const el = $("#fdp-status");
  const sm = fdp.data?.summary;
  el.classList.toggle("bad", !!fdp.error || !!fdp.data?.stale);
  if (fdp.error) el.textContent = `CFA page unavailable: ${fdp.error}`;
  else if (!sm) el.textContent = fdp.enabled ? "Loading CFA restriction dates…" : "";
  else {
    const soon = fdp.data.rows.filter((r) => r.status === "upcoming" && !r.anomaly && r.startsInDays <= SOON_DAYS).length;
    el.textContent = `${sm.declared} of ${sm.total} areas declared · ${soon} starting within ${SOON_DAYS} days${fdp.data.stale ? " (last good data)" : ""}`;
  }
}

function renderLegend() {
  const el = $("#legend-fdp");
  if (!el) return;
  el.hidden = !fdp.enabled;
  if (!el.hidden) {
    el.innerHTML = `<span class="legend-unit">Fire Danger Period</span>
      <span class="fdp-key declared">Declared</span><span class="fdp-key partly">Partly declared</span><span class="fdp-key soon">Starts ≤ ${SOON_DAYS} days</span>`;
  }
  ctx.onLegendChange?.();
}

export async function refreshFdp() {
  try {
    const res = await fetch("/api/fire-restrictions");
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    fdp.data = body;
    fdp.error = body.ok === false ? body.error : null;
  } catch (error) {
    fdp.error = error.message;
  }
  render();
  ctx.onChange?.();
}

// Alerts for the intelligence panel (computed even when the layer is hidden).
export function fdpInsights() {
  if (!fdp.data || !fdp.areas) return [];
  const out = [];
  const geomOf = (lga) => fdp.areas.features.find((f) => f.properties.lga === lga);
  const netsFor = (lgas) => [...new Set(lgas.flatMap((l) => ctx.networksIn?.(geomOf(l)?.geometry) ?? []))];
  const declared = fdp.data.rows.filter((r) => r.status === "declared");
  if (declared.length) {
    const nets = netsFor([...new Set(declared.map((r) => r.lga))]);
    out.push({
      severity: "elevated",
      color: COLORS.declared,
      title: `Fire Danger Period declared — ${declared.length} area${declared.length > 1 ? "s" : ""}`,
      detail: `${declared.map((r) => titleCase(r.area)).join(", ")}.${nets.length ? ` Networks affected: ${nets.join(", ")}.` : ""} Bushfire mitigation obligations apply.`,
      at: geomOf(declared[0].lga)?.properties.label,
    });
  }
  // Upcoming within the window, grouped by start date.
  const byDate = {};
  for (const r of fdp.data.rows) if (r.status === "upcoming" && !r.anomaly && r.startsInDays <= SOON_DAYS) (byDate[r.start] ??= []).push(r);
  for (const [start, rows] of Object.entries(byDate).sort()) {
    const d = rows[0].startsInDays;
    const nets = netsFor([...new Set(rows.map((r) => r.lga))]);
    out.push({
      severity: d <= 7 ? "elevated" : "info",
      color: COLORS.upcoming,
      title: `Fire Danger Period starts ${d === 1 ? "tomorrow" : `in ${d} days`} (${shortDate(start)})`,
      detail: `${rows.map((r) => titleCase(r.area)).join(", ")}.${nets.length ? ` Networks: ${nets.join(", ")}.` : ""} Check bushfire mitigation works are compliant before the start date.`,
      at: geomOf(rows[0].lga)?.properties.label,
    });
  }
  const odd = fdp.data.rows.filter((r) => r.anomaly);
  if (odd.length) out.push({ severity: "info", color: "#9ab", title: "Check CFA restriction dates", detail: `${odd.map((r) => `${titleCase(r.area)} (${r.start} → ${r.end})`).join(", ")}: start date is after the end date on the CFA page.` });
  return out;
}

export function setFdpEnabled(on) {
  fdp.enabled = on;
  ctx.store.set("fdpLayer", on ? "1" : "0");
  $("#t-fdp").checked = on;
  render();
}

export async function initFdpLayer(context) {
  ctx = context;
  if (!ctx.map.getPane("fdp")) ctx.map.createPane("fdp");
  ctx.map.getPane("fdp").style.zIndex = 390; // above fire districts, below network boundaries
  $("#t-fdp").addEventListener("change", (e) => setFdpEnabled(e.target.checked));
  try {
    fdp.areas = await (await fetch("/data/fdp-areas.geojson")).json();
  } catch (error) {
    fdp.error = `council boundaries failed to load (${error.message})`;
  }
  setFdpEnabled(ctx.store.get("fdpLayer", "0") === "1");
  refreshFdp();
}
