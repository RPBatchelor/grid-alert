// Admin page (admins only): Users (access requests and accounts), Usage (sign-ins and daily
// activity) and Database (size, tables, gaps in the recorded timeline, backups).
import { fmtDuration, fmtTime, num } from "./outageChart.js";
import { ROLE_LABEL, currentUser } from "./users.js";

const $ = (s) => document.querySelector(s);
const ROLE_HELP = { viewer: "Can view everything", operator: "Can also start, stop and edit events", admin: "Can also manage users" };
const TABS = ["users", "usage", "database"];
const TABLE_INFO = {
  snapshots: "One row per outage fetch",
  totals: "Per-network totals for each snapshot",
  incidents: "Incident register (first/last seen, peak)",
  incident_observations: "Each incident's customers at every snapshot",
  events: "Named events",
  users: "Accounts",
  sessions: "Signed-in browsers",
  auth_tokens: "Set-password links",
  access_requests: "Requests from the sign-in page",
  logins: "Sign-in history",
  user_activity: "Days each person used the app",
};

let toast = () => {};
let names = {};
let tab = "users";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const when = (ts) => (ts ? fmtTime(ts) : "Never");
const pct = (x) => (x == null ? "—" : `${x >= 99.95 ? 100 : x.toFixed(1)}%`);
const isAdmin = () => currentUser()?.role === "admin";

function ago(ts) {
  if (!ts) return "Never";
  const ms = Date.now() - ts;
  if (ms < 120_000) return "Just now";
  if (ms < 3600e3) return `${Math.round(ms / 60000)} min ago`;
  if (ms < 48 * 3600e3) return `${Math.round(ms / 3600e3)} h ago`;
  return `${Math.round(ms / 86400e3)} days ago`;
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

const tile = (label, value, note = "", cls = "") => `<div class="tile ${cls}"><div class="tile-label">${label}</div><div class="tile-value">${value}</div><div class="tile-note">${note}</div></div>`;
const table = (el, head, rows, empty) =>
  (el.innerHTML = `<thead><tr>${head.map(([h, cls]) => `<th${cls ? ` class="${cls}"` : ""}>${h}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.join("") : `<tr><td colspan="${head.length}" class="muted">${empty}</td></tr>`}</tbody>`);

// 30 vertical bars; `value` is 0–1 of the bar height.
function dayBars(el, days) {
  el.innerHTML =
    `<div class="day-bars-plot">${days.map((d) => `<div class="day-bar${d.cls ? ` ${d.cls}` : ""}" title="${esc(d.title)}"><span style="height:${Math.max(d.value > 0 ? 3 : 0, Math.round(d.value * 100))}%"></span></div>`).join("")}</div>` +
    `<div class="day-bars-axis"><span>${esc(days[0].label)}</span><span>${esc(days.at(-1).label)}</span></div>`;
}

const dayLabel = (ts) => new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", day: "numeric", month: "short" }).format(new Date(ts));

export function initAdmin(opts = {}) {
  toast = opts.toast ?? toast;
  names = opts.names ?? names;
  if (!isAdmin()) return;
  $("#sb-admin").hidden = false;
  document.querySelectorAll("#admin-tabs [data-admin-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      history.replaceState(null, "", `#admin/${b.dataset.adminTab}`);
      showAdmin(b.dataset.adminTab);
    }),
  );
  wireInvite();
  $("#db-check").addEventListener("click", runCheck);
  refreshRequestCount();

  // The "Review request" link in the admin email (and older ?settings=users links) opens the
  // Users tab.
  const params = new URLSearchParams(location.search);
  if (params.get("admin") || params.get("settings") === "users") {
    const target = TABS.includes(params.get("admin")) ? params.get("admin") : "users";
    history.replaceState(null, "", `${location.pathname}#admin/${target}`);
  }
}

// Called by the router for #admin and #admin/<tab>. Returns false for non-admins.
export function showAdmin(name) {
  if (!isAdmin()) return false;
  tab = TABS.includes(name) ? name : tab;
  document.querySelectorAll("#admin-tabs [data-admin-tab]").forEach((b) => {
    const on = b.dataset.adminTab === tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll("#admin [data-admin]").forEach((p) => (p.hidden = p.dataset.admin !== tab));
  ({ users: loadUsers, usage: loadUsage, database: loadDatabase })[tab]();
  return true;
}

function setRequestCount(n) {
  for (const id of ["#users-request-count", "#sb-admin-count"]) {
    $(id).textContent = n ? String(n) : "";
    $(id).hidden = !n;
  }
  $("#sb-admin").title = n ? `Admin (${n} access request${n === 1 ? "" : "s"} waiting)` : "Admin";
}

async function refreshRequestCount() {
  try {
    setRequestCount((await api("/api/admin/overview")).requests.length);
  } catch {
    /* shown when the page is opened */
  }
}

// ---- Users -------------------------------------------------------------------------------

const roleSelect = (value, attrs = "") =>
  `<select ${attrs}>${Object.entries(ROLE_LABEL)
    .map(([k, label]) => `<option value="${k}"${k === value ? " selected" : ""} title="${ROLE_HELP[k]}">${label}</option>`)
    .join("")}</select>`;

// When an email couldn't be sent, show the set-password link so the admin can pass it on.
function showLink(result, who) {
  const box = $("#users-link");
  if (result.emailed || !result.link) {
    box.hidden = true;
    toast(`Email sent to ${who}.`, 4000);
    return;
  }
  box.hidden = false;
  box.innerHTML = `<div><b>Email not sent</b> (mail isn’t set up yet, or it failed). Send ${esc(who)} this one-time link yourself. It expires in 48 hours.</div>
    <div class="users-link-row"><input readonly value="${esc(result.link)}" aria-label="Set-password link" /><button type="button" class="btn small">Copy</button></div>`;
  const input = box.querySelector("input");
  box.querySelector("button").addEventListener("click", async () => {
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
      toast("Link copied.", 2500);
    } catch {
      document.execCommand?.("copy");
    }
  });
}

async function act(fn, done) {
  try {
    const result = await fn();
    done?.(result);
    await loadUsers();
  } catch (error) {
    toast(error.message, 6000);
  }
}

async function loadUsers() {
  let data;
  try {
    data = await api("/api/admin/overview");
  } catch (error) {
    $("#users-requests").innerHTML = `<div class="empty">Couldn’t load users: ${esc(error.message)}</div>`;
    return;
  }
  const { requests, users } = data;
  const me = currentUser();
  setRequestCount(requests.length);

  $("#users-requests").innerHTML = requests.length
    ? requests
        .map(
          (r) => `<div class="req-row" data-id="${r.id}">
        <div class="req-who"><b>${esc(r.name)}</b> <span class="muted">${esc(r.email)}</span>${r.organisation ? `<div class="muted">${esc(r.organisation)}</div>` : ""}${r.reason ? `<div class="req-reason">“${esc(r.reason)}”</div>` : ""}<div class="muted small">Requested ${when(r.created_at)}</div></div>
        <div class="req-actions">${roleSelect("viewer", 'aria-label="Role" class="req-role"')}<button type="button" class="btn small primary" data-approve>Approve</button><button type="button" class="btn small" data-decline>Decline</button></div>
      </div>`,
        )
        .join("")
    : `<div class="empty">No pending requests.</div>`;
  $("#users-requests").querySelectorAll(".req-row").forEach((row) => {
    const id = row.dataset.id;
    const r = requests.find((x) => String(x.id) === id);
    row.querySelector("[data-approve]").addEventListener("click", () =>
      act(() => api(`/api/admin/requests/${id}/approve`, { method: "POST", body: { role: row.querySelector(".req-role").value } }), (res) => showLink(res, r.email)),
    );
    row.querySelector("[data-decline]").addEventListener("click", () => {
      if (!confirm(`Decline the request from ${r.name} (${r.email})?`)) return;
      act(() => api(`/api/admin/requests/${id}/decline`, { method: "POST", body: { notify: true } }));
    });
  });

  const active = users.filter((u) => u.status === "active").length;
  $("#users-total").textContent = `${active} active${users.length > active ? ` · ${users.length - active} disabled` : ""}`;
  $("#users-table tbody").innerHTML = users
    .map((u) => {
      const self = u.id === me.id;
      const disabled = u.status === "disabled";
      return `<tr data-id="${u.id}" class="${disabled ? "is-disabled" : ""}">
        <td><b>${esc(u.name || "—")}</b>${self ? ' <span class="tag">You</span>' : ""}<div class="muted">${esc(u.email)}${u.organisation ? ` · ${esc(u.organisation)}` : ""}</div></td>
        <td>${roleSelect(u.role, `aria-label="Role for ${esc(u.email)}" class="user-role"${self ? " disabled" : ""}`)}</td>
        <td>${disabled ? '<span class="tag bad">Disabled</span>' : u.has_password ? when(u.last_login) : '<span class="tag warn" title="Hasn’t set a password yet">Invited</span>'}</td>
        <td title="${u.last_seen ? esc(when(u.last_seen)) : ""}">${ago(u.last_seen)}${u.sessions ? ` <span class="muted small">· ${u.sessions} session${u.sessions === 1 ? "" : "s"}</span>` : ""}</td>
        <td class="num">${u.logins_30d}</td>
        <td class="user-actions">${
          self
            ? ""
            : `<button type="button" class="btn small" data-reset${disabled ? " disabled" : ""} title="Email a one-time link to set a new password">Reset link</button>` +
              `<button type="button" class="btn small" data-signout${u.sessions ? "" : " disabled"} title="End all of their signed-in sessions">Sign out</button>` +
              `<button type="button" class="btn small" data-toggle>${disabled ? "Enable" : "Disable"}</button>` +
              `<button type="button" class="btn small danger" data-remove title="Delete the account and its usage history">Remove</button>`
        }</td>
      </tr>`;
    })
    .join("");
  $("#users-table tbody").querySelectorAll("tr").forEach((tr) => {
    const id = tr.dataset.id;
    const u = users.find((x) => String(x.id) === id);
    tr.querySelector(".user-role").addEventListener("change", (e) => act(() => api(`/api/admin/users/${id}`, { method: "PATCH", body: { role: e.target.value } }), () => toast(`${u.email} is now ${ROLE_LABEL[e.target.value]}.`, 3000)));
    tr.querySelector("[data-reset]")?.addEventListener("click", () => act(() => api(`/api/admin/users/${id}/reset`, { method: "POST" }), (res) => showLink(res, u.email)));
    tr.querySelector("[data-signout]")?.addEventListener("click", () => {
      if (!confirm(`Sign ${u.email} out of every browser they’re signed in on?`)) return;
      act(() => api(`/api/admin/users/${id}/signout`, { method: "POST" }), (res) => toast(`Ended ${res.sessions} session${res.sessions === 1 ? "" : "s"} for ${u.email}.`, 3500));
    });
    tr.querySelector("[data-toggle]")?.addEventListener("click", () => {
      const status = u.status === "disabled" ? "active" : "disabled";
      if (status === "disabled" && !confirm(`Disable ${u.email}? They’ll be signed out straight away.`)) return;
      act(() => api(`/api/admin/users/${id}`, { method: "PATCH", body: { status } }));
    });
    tr.querySelector("[data-remove]")?.addEventListener("click", () => {
      if (!confirm(`Remove ${u.email}? This deletes the account, signs them out and erases their usage history. They’d need to request access again. This can’t be undone.`)) return;
      act(() => api(`/api/admin/users/${id}`, { method: "DELETE" }), () => toast(`${u.email} removed.`, 3500));
    });
  });
}

function wireInvite() {
  const form = $("#users-invite");
  form.querySelector(".user-invite-role").outerHTML = roleSelect("viewer", 'name="role" aria-label="Role" class="user-invite-role"');
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    act(
      () => api("/api/admin/users", { method: "POST", body: d }),
      (res) => {
        form.reset();
        showLink(res, d.email);
      },
    );
  });
}

// ---- Usage -------------------------------------------------------------------------------

async function loadUsage() {
  let overview, usage;
  try {
    [overview, usage] = await Promise.all([api("/api/admin/overview"), api("/api/admin/usage")]);
  } catch (error) {
    $("#usage-tiles").innerHTML = `<div class="empty">Couldn’t load usage: ${esc(error.message)}</div>`;
    return;
  }
  const { users } = overview;
  const active = users.filter((u) => u.status === "active");
  const invited = active.filter((u) => !u.has_password).length;
  const signIns30 = usage.days.reduce((s, d) => s + d.signIns, 0);
  $("#usage-tiles").innerHTML =
    tile("People with access", active.length, invited ? `${invited} yet to set a password` : "All have signed in") +
    tile("Active today", usage.activeToday, `of ${active.length}`) +
    tile("Active · 7 days", usage.active7d, `${usage.active30d} in the last 30 days`) +
    tile("Sign-ins · 30 days", signIns30, usage.recentSignIns[0] ? `Last ${ago(usage.recentSignIns[0].ts).toLowerCase()}` : "None yet");

  const peak = Math.max(1, ...usage.days.map((d) => d.active));
  dayBars(
    $("#usage-days"),
    usage.days.map((d) => {
      const ts = Date.parse(`${d.day}T12:00:00`);
      return { value: d.active / peak, label: dayLabel(ts), title: `${dayLabel(ts)}: ${d.active} active, ${d.signIns} sign-in${d.signIns === 1 ? "" : "s"}` };
    }),
  );
  $("#usage-note").textContent = `Bars show how many people used the app each day (peak ${peak}). Someone counts as active if they signed in or had the app open that day.${
    usage.trackingSince ? ` Usage tracking started ${fmtTime(usage.trackingSince)}.` : " Usage tracking starts with this version."
  }`;

  const dormantMs = 30 * 86400e3;
  const people = [...users].sort((a, b) => (b.last_seen ?? 0) - (a.last_seen ?? 0));
  table(
    $("#usage-people"),
    [["Person"], ["Role"], ["Last active"], ["Active days (30 d)", "num"], ["Sign-ins (30 d)", "num"]],
    people.map((u) => {
      const flag =
        u.status === "disabled"
          ? ' <span class="tag bad">Disabled</span>'
          : !u.has_password
            ? ' <span class="tag warn">Invited</span>'
            : !u.last_seen || Date.now() - u.last_seen > dormantMs
              ? ' <span class="tag warn" title="No activity for 30 days or more. Consider disabling the account.">Dormant</span>'
              : "";
      return `<tr><td><b>${esc(u.name || u.email)}</b>${flag}</td><td>${ROLE_LABEL[u.role]}</td><td title="${u.last_seen ? esc(when(u.last_seen)) : ""}">${ago(u.last_seen)}</td><td class="num">${u.active_days_30d}</td><td class="num">${u.logins_30d}</td></tr>`;
    }),
    "No accounts yet.",
  );
  table(
    $("#usage-signins"),
    [["When"], ["Person"]],
    usage.recentSignIns.map((s) => `<tr><td>${when(s.ts)}</td><td>${esc(s.name || s.email)}</td></tr>`),
    "No sign-ins recorded yet.",
  );
}

// ---- Database ----------------------------------------------------------------------------

async function loadDatabase() {
  let d;
  try {
    d = await api("/api/admin/database");
  } catch (error) {
    $("#db-tiles").innerHTML = `<div class="empty">Couldn’t load database details: ${esc(error.message)}</div>`;
    return;
  }
  const s = d.snapshots;
  const total = d.size.db + d.size.wal;
  const lastAge = s.last ? Date.now() - s.last : null;
  const overdue = s.collecting && (lastAge == null || lastAge > d.gaps.thresholdMs);
  $("#db-tiles").innerHTML =
    tile("Database size", bytes(total), d.size.free > 1024 ** 2 ? `${bytes(d.size.free)} reclaimable` : `${bytes(d.size.wal)} in the write-ahead log`) +
    tile("Snapshots", num(s.count), s.collecting ? `Every ${s.intervalMinutes} min · last ${ago(s.last).toLowerCase()}` : "Collection is off (COLLECT_INTERVAL_MINUTES=0)", overdue ? "tile-bad" : "") +
    tile("Recorded since", s.first ? dayLabel(s.first) : "—", s.first ? `${fmtDuration(d.coverage.span)} of history` : "No snapshots yet") +
    tile("Coverage", pct(d.coverage.percent), d.gaps.count ? `${d.gaps.count} gap${d.gaps.count === 1 ? "" : "s"} · ${fmtDuration(d.coverage.missingMs)} missing` : "No gaps", d.coverage.percent != null && d.coverage.percent < 95 ? "tile-warn" : "");

  dayBars(
    $("#db-days"),
    d.days.map((day) => {
      const ratio = day.expected ? Math.min(1, day.snapshots / day.expected) : 0;
      return {
        value: day.expected ? ratio : 0,
        cls: !day.expected ? "none" : ratio < 0.9 ? "low" : "",
        label: dayLabel(day.end),
        title: day.expected ? `24 h to ${fmtTime(day.end)}: ${day.snapshots} of ${day.expected} expected snapshots (${pct(ratio * 100)})` : `${dayLabel(day.end)}: before recording started`,
      };
    }),
  );
  $("#db-days-note").textContent = `Each bar is a 24-hour period ending now and going back 30 days. It shows the share of the expected snapshots (one every ${s.intervalMinutes || 5} min) that were recorded. Red bars are below 90%.`;

  $("#db-gap-count").textContent = d.gaps.count ? `${d.gaps.count} total` : "None";
  $("#db-gap-note").textContent = `A gap is any stretch longer than ${fmtDuration(d.gaps.thresholdMs)} (2.5 collection intervals) with no snapshot. Gaps usually mean the server was stopped, restarting or offline. Outages that started and ended inside a gap weren't recorded.${d.gaps.count > 100 ? " The 100 most recent are shown." : ""}`;
  table(
    $("#db-gaps"),
    [["From"], ["To"], ["Length", "num"]],
    d.gaps.recent.map(
      (g) =>
        `<tr${g === d.gaps.recent[0] && g.end == null ? ' class="row-bad"' : ""}><td>${fmtTime(g.start)}</td><td>${g.end ? fmtTime(g.end) : '<span class="tag bad">Ongoing</span>'}</td><td class="num">${fmtDuration((g.end ?? Date.now()) - g.start)}</td></tr>`,
    ),
    "No gaps. Every collection interval has a snapshot.",
  );

  table(
    $("#db-feeds"),
    [["Network"], ["Coverage", "num"], ["Failed snapshots", "num"], ["Outages", "num"], ["Longest"], ["Last failure"], ["Status"]],
    d.feeds.map((f) => {
      const coverage = f.snapshots ? 100 * (1 - f.missing / f.snapshots) : null;
      const longest = f.longest ? `${fmtDuration((f.longest.end ?? Date.now()) - f.longest.start)}${f.longest.end ? "" : " (ongoing)"}` : "—";
      return `<tr><td>${esc(names[f.network] ?? f.network)}</td><td class="num">${pct(coverage)}</td><td class="num">${num(f.missing)}</td><td class="num">${f.gaps}</td><td>${longest}</td><td>${f.lastMissing ? fmtTime(f.lastMissing) : "—"}</td><td>${
        f.failing ? '<span class="tag bad">Failing</span>' : '<span class="tag ok">OK</span>'
      }</td></tr>`;
    }),
    "No snapshots in the last 30 days.",
  );

  table(
    $("#db-tables"),
    [["Table"], ["Holds"], ["Rows", "num"]],
    d.tables.map((t) => `<tr><td><code>${esc(t.name)}</code></td><td class="muted">${esc(TABLE_INFO[t.name] ?? "")}</td><td class="num">${num(t.rows)}</td></tr>`),
    "No tables.",
  );

  $("#db-storage").innerHTML = [
    ["File", `<code>${esc(d.path)}</code>`],
    ["Database", bytes(d.size.db)],
    ["Write-ahead log", bytes(d.size.wal)],
    ["Free pages", bytes(d.size.free)],
    ["SQLite", esc(d.sqliteVersion)],
  ]
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join("");
  table(
    $("#db-backups"),
    [["Daily backup"], ["Size", "num"], ["Written"]],
    d.backups.map((b) => `<tr><td><code>${esc(b.file)}</code></td><td class="num">${bytes(b.size)}</td><td>${fmtTime(b.at)}</td></tr>`),
    "No backups yet. The first is written a minute after the server starts, then one a day.",
  );
}

async function runCheck() {
  const btn = $("#db-check");
  const out = $("#db-check-result");
  btn.disabled = true;
  out.hidden = false;
  out.textContent = "Checking the database…";
  try {
    const r = await api("/api/admin/database/check", { method: "POST" });
    out.textContent = r.ok ? `Integrity check passed (${(r.ms / 1000).toFixed(1)} s).` : `Integrity check found problems: ${r.messages.join("; ")}`;
    out.classList.toggle("bad", !r.ok);
  } catch (error) {
    out.textContent = `Check failed: ${error.message}`;
    out.classList.add("bad");
  } finally {
    btn.disabled = false;
  }
}
