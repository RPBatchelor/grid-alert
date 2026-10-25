// Excel export of an event: summary, customers/outages over time (per snapshot), per-incident
// timeline, and the incident register. Times are written as Melbourne local time.
import ExcelJS from "exceljs";
import { getEvent } from "./events.js";
import { open } from "./history.js";

const NETWORKS = [
  ["ausnet", "AusNet"],
  ["citipower", "CitiPower"],
  ["powercor", "Powercor"],
  ["jemena", "Jemena"],
  ["ue", "United Energy"],
];
const NAME = Object.fromEntries(NETWORKS);
const CATEGORY = { bushfire: "Bushfire", heatwave: "Heatwave", flood: "Flood", storm: "Storm", thunderstorm: "Thunderstorm", lightning: "Lightning", other: "Other" };
const TZ = "Australia/Melbourne";
const MAX_OBSERVATION_ROWS = 500_000; // well under Excel's 1,048,576-row sheet limit

// Excel has no time zones: write Melbourne wall-clock time as a "UTC" Date so the cell shows
// local time, and say so in the header.
function local(ms) {
  if (ms == null) return null;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-AU", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second));
}

const DATE_FMT = "dd/mm/yyyy hh:mm";
const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D2B33" } };

function sheet(wb, name, columns) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map(([header, key, width, numFmt]) => ({ header, key, width: width ?? 14, style: numFmt ? { numFmt } : {} }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = HEADER_FILL;
  head.alignment = { vertical: "middle", wrapText: true };
  head.height = 30;
  return ws;
}

export async function exportEventXlsx(id) {
  const event = getEvent(id);
  const start = event.startedAt;
  const end = event.endedAt ?? Date.now();
  const d = open();
  const wb = new ExcelJS.Workbook();
  wb.creator = "Grid Alert Victoria (grid-alert.com)";
  wb.created = new Date();

  // ---- Summary ----------------------------------------------------------------------------
  const s = event.stats;
  const summary = wb.addWorksheet("Summary");
  summary.columns = [{ width: 34 }, { width: 46 }];
  const kv = [
    ["Event", event.name],
    ["Category", CATEGORY[event.category] ?? event.category],
    ["Status", event.active ? "In progress (export is up to the time of download)" : "Completed"],
    ["Start (Melbourne time)", local(start)],
    ["End (Melbourne time)", event.active ? null : local(end)],
    ["Exported (Melbourne time)", local(Date.now())],
    ["Duration (hours)", Math.round(((end - start) / 3600e3) * 100) / 100],
    ["Peak customers off supply (unplanned)", s.peak?.value ?? null],
    ["Peak at (Melbourne time)", s.peak ? local(s.peak.ts) : null],
    ["Unplanned incidents", s.incidents],
    ["Incidents that began during the event", s.newIncidents],
    ["Customer-minutes off supply (approx.)", s.customerMinutes],
    ["Networks affected", s.networksAffected],
    ["Snapshots recorded", s.snapshots],
    ["Notes", event.notes || ""],
  ];
  summary.addRow(["Grid Alert Victoria — event export"]).font = { bold: true, size: 14 };
  summary.addRow([]);
  for (const [k, v] of kv) {
    const row = summary.addRow([k, v]);
    row.getCell(1).font = { bold: true };
    if (v instanceof Date) row.getCell(2).numFmt = DATE_FMT;
    else if (typeof v === "number") row.getCell(2).numFmt = "#,##0.##";
    row.getCell(2).alignment = { wrapText: true, vertical: "top", horizontal: "left" };
  }
  summary.addRow([]);
  summary.addRow(["By network (unplanned)"]).font = { bold: true };
  const nh = summary.addRow(["Network", "Peak customers", "Peak at (Melbourne time)", "Incidents", "Customer-minutes (approx.)"]);
  nh.font = { bold: true, color: { argb: "FFFFFFFF" } };
  nh.eachCell((c) => (c.fill = HEADER_FILL));
  summary.getColumn(3).width = 24;
  summary.getColumn(4).width = 12;
  summary.getColumn(5).width = 24;
  for (const [key, name] of NETWORKS) {
    const n = s.networks[key] ?? { peak: 0, peakTs: null, incidents: 0, customerMinutes: 0 };
    const r = summary.addRow([name, n.peak, local(n.peakTs), n.incidents, n.customerMinutes]);
    r.getCell(2).numFmt = "#,##0";
    r.getCell(3).numFmt = DATE_FMT;
    r.getCell(5).numFmt = "#,##0";
  }
  summary.addRow([]);
  summary.addRow(["Times are Melbourne local time. Customer-minutes are integrated from the recorded snapshots (gaps over 15 minutes are not bridged). A network missing from a snapshot means its tracker was unavailable at that time."]).getCell(1).alignment = { wrapText: true };
  summary.mergeCells(`A${summary.rowCount}:E${summary.rowCount}`);
  summary.getRow(summary.rowCount).height = 45;

  // ---- Customers over time --------------------------------------------------------------
  const cols = [["Time (Melbourne)", "ts", 18, DATE_FMT]];
  for (const [key, name] of NETWORKS) {
    cols.push([`${name} unplanned customers`, `${key}_uc`, 14, "#,##0"], [`${name} unplanned outages`, `${key}_uo`, 12, "#,##0"]);
  }
  cols.push(["Total unplanned customers", "total_uc", 14, "#,##0"], ["Total unplanned outages", "total_uo", 12, "#,##0"]);
  for (const [key, name] of NETWORKS) cols.push([`${name} planned customers`, `${key}_pc`, 13, "#,##0"]);
  cols.push(["Total planned customers", "total_pc", 13, "#,##0"], ["Networks reporting", "reporting", 11]);
  const timeline = sheet(wb, "Customers over time", cols);
  const totals = d
    .prepare("SELECT s.id, s.ts, t.network, t.type, t.customers, t.outages FROM snapshots s LEFT JOIN totals t ON t.snapshot_id = s.id WHERE s.ts BETWEEN ? AND ? ORDER BY s.ts")
    .all(start, end);
  const bySnap = new Map();
  for (const r of totals) {
    if (!bySnap.has(r.id)) bySnap.set(r.id, { ts: r.ts, values: {} });
    if (r.network) bySnap.get(r.id).values[`${r.network}|${r.type}`] = r;
  }
  for (const { ts, values } of bySnap.values()) {
    const row = { ts: local(ts), total_uc: 0, total_uo: 0, total_pc: 0, reporting: 0 };
    for (const [key] of NETWORKS) {
      const u = values[`${key}|unplanned`];
      const p = values[`${key}|planned`];
      if (u) {
        row[`${key}_uc`] = u.customers;
        row[`${key}_uo`] = u.outages;
        row.total_uc += u.customers;
        row.total_uo += u.outages;
        row.reporting++;
      }
      if (p) {
        row[`${key}_pc`] = p.customers;
        row.total_pc += p.customers;
      }
    }
    timeline.addRow(row);
  }
  timeline.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

  // ---- Incident timeline (customers per incident per snapshot) ----------------------------
  const obsCols = [
    ["Time (Melbourne)", "ts", 18, DATE_FMT],
    ["Network", "network", 14],
    ["Incident", "id", 18],
    ["Type", "type", 11],
    ["Location", "place", 22],
    ["Customers off supply", "customers", 12, "#,##0"],
    ["Status", "status", 26],
  ];
  const obsSheet = sheet(wb, "Incident timeline", obsCols);
  const observations = d
    .prepare(
      `SELECT s.ts, o.network, o.id, o.customers, o.status, i.type, i.place
       FROM incident_observations o JOIN snapshots s ON s.id = o.snapshot_id
       LEFT JOIN incidents i ON i.network = o.network AND i.id = o.id
       WHERE s.ts BETWEEN ? AND ? ORDER BY s.ts, o.network, o.customers DESC LIMIT ?`,
    )
    .all(start, end, MAX_OBSERVATION_ROWS + 1);
  for (const o of observations.slice(0, MAX_OBSERVATION_ROWS)) obsSheet.addRow({ ...o, ts: local(o.ts), network: NAME[o.network] ?? o.network });
  if (!observations.length) {
    obsSheet.addRow({ ts: null, network: "No per-incident history was recorded for this period (per-incident recording started after it). See the Incidents sheet for each incident's first/last seen and peak customers." });
    obsSheet.mergeCells(`B2:G2`);
  } else if (observations.length > MAX_OBSERVATION_ROWS) {
    obsSheet.addRow({ network: `Truncated at ${MAX_OBSERVATION_ROWS.toLocaleString("en-AU")} rows.` });
  } else {
    obsSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: obsCols.length } };
  }

  // ---- Incident register ------------------------------------------------------------------
  const incCols = [
    ["Network", "network", 14],
    ["Incident", "id", 18],
    ["Type", "type", 11],
    ["Location", "place", 22],
    ["Cause", "cause", 24],
    ["Last status", "status", 26],
    ["Peak customers", "peak_customers", 12, "#,##0"],
    ["Customers at last sighting", "last_customers", 13, "#,##0"],
    ["First seen (Melbourne)", "first_seen", 18, DATE_FMT],
    ["Last seen (Melbourne)", "last_seen", 18, DATE_FMT],
    ["Duration (min)", "duration", 11, "#,##0"],
    ["Began during event", "began", 11],
    ["Latitude", "lat", 11, "0.00000"],
    ["Longitude", "lon", 11, "0.00000"],
  ];
  const incSheet = sheet(wb, "Incidents", incCols);
  const incidents = d
    .prepare("SELECT * FROM incidents WHERE first_seen <= ? AND last_seen >= ? ORDER BY peak_customers DESC")
    .all(end, start);
  for (const i of incidents) {
    incSheet.addRow({
      ...i,
      network: NAME[i.network] ?? i.network,
      first_seen: local(i.first_seen),
      last_seen: local(i.last_seen),
      duration: Math.round((Math.min(i.last_seen, end) - Math.max(i.first_seen, start)) / 60000),
      began: i.first_seen >= start ? "Yes" : "No (already active)",
    });
  }
  incSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: incCols.length } };

  const buffer = await wb.xlsx.writeBuffer();
  const date = local(start).toISOString().slice(0, 10);
  const filename = `${date} ${event.name}`.replace(/[^\w\- ]+/g, "").replace(/\s+/g, "_").slice(0, 80) + ".xlsx";
  return { buffer: Buffer.from(buffer), filename };
}
