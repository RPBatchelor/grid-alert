// Signed-in user: session check, sign-out, role-based UI, and the admin's Settings → Users page.
const $ = (s) => document.querySelector(s);
const ROLE_LABEL = { viewer: "Viewer", operator: "Operator", admin: "Admin" };
const ROLE_HELP = { viewer: "Can view everything", operator: "Can also start, stop and edit events", admin: "Can also manage users" };

let me = null;
let toast = () => {};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const when = (ts) => (ts ? new Date(ts).toLocaleString("en-AU", { timeZone: "Australia/Melbourne", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Never");
const toLogin = () => location.replace("/login");

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// Call before anything else loads. Resolves with the user, or sends the browser to /login.
export async function requireUser() {
  // Any API call that finds the session gone (expired, signed out elsewhere, disabled)
  // sends the browser back to the landing page.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await nativeFetch(input, init);
    const url = typeof input === "string" ? input : input.url;
    if (res.status === 401 && new URL(url, location.href).pathname.startsWith("/api/") && !url.includes("/api/auth/")) toLogin();
    return res;
  };
  const res = await nativeFetch("/api/auth/me");
  if (!res.ok) {
    toLogin();
    return new Promise(() => {}); // never resolves: the page is navigating away
  }
  me = (await res.json()).user;
  document.body.dataset.role = me.role;
  return me;
}

export const currentUser = () => me;
export const canEdit = () => me?.role === "operator" || me?.role === "admin";

export function initUsers(opts = {}) {
  toast = opts.toast ?? toast;
  renderUserBox();
  if (me?.role !== "admin") return;

  $("#settings-nav-users").hidden = false;
  const refreshIfShown = () => setTimeout(() => !$('[data-panel="users"]').hidden && loadUsers(), 0);
  $("#settings-nav-users").addEventListener("click", refreshIfShown);
  $("#settings-button").addEventListener("click", refreshIfShown);
  wireInvite();

  // The "Review request" link in the admin email opens straight to this page.
  const params = new URLSearchParams(location.search);
  if (params.get("settings") === "users") {
    try {
      localStorage.setItem("settingsSection", "users");
    } catch {
      /* ignore */
    }
    history.replaceState(null, "", location.pathname + location.hash);
    // Open once the disclaimer has been accepted, so the two dialogs don't stack.
    const open = () => $("#settings-button").click();
    if ($("#disclaimer")?.open) $("#disclaimer-ok").addEventListener("click", () => setTimeout(open, 0), { once: true });
    else open();
  }
}

function renderUserBox() {
  const box = $("#user-box");
  if (!me) return;
  const initials = (me.name || me.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  box.innerHTML = `<span class="user-avatar" aria-hidden="true">${esc(initials)}</span>
    <span class="sb-label user-label"><span class="user-name">${esc(me.name || me.email)}</span><small>${esc(ROLE_LABEL[me.role])} · ${esc(me.email)}</small></span>
    <button type="button" class="sb-icon-btn user-signout" id="sign-out" title="Sign out" aria-label="Sign out"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg></button>`;
  box.title = `${me.name || me.email} (${ROLE_LABEL[me.role]})`;
  box.hidden = false;
  $("#sign-out").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    toLogin();
  });
}

// ---- Settings → Users (admin) ------------------------------------------------------------

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

export async function loadUsers() {
  let data;
  try {
    data = await api("/api/admin/overview");
  } catch (error) {
    $("#users-requests").innerHTML = `<div class="empty">Couldn’t load users: ${esc(error.message)}</div>`;
    return;
  }
  const { requests, users } = data;
  $("#users-request-count").textContent = requests.length ? String(requests.length) : "";
  $("#users-request-count").hidden = !requests.length;

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

  $("#users-table tbody").innerHTML = users
    .map((u) => {
      const self = u.id === me.id;
      return `<tr data-id="${u.id}" class="${u.status === "disabled" ? "is-disabled" : ""}">
        <td><b>${esc(u.name || "—")}</b>${self ? ' <span class="tag">You</span>' : ""}<div class="muted">${esc(u.email)}</div></td>
        <td>${roleSelect(u.role, `aria-label="Role for ${esc(u.email)}" class="user-role"${self ? " disabled" : ""}`)}</td>
        <td>${u.status === "disabled" ? '<span class="muted">Disabled</span>' : u.has_password ? when(u.last_login) : '<span class="muted" title="Hasn’t set a password yet">Invited</span>'}</td>
        <td class="user-actions">${
          self
            ? ""
            : `<button type="button" class="btn small" data-reset${u.status === "disabled" ? " disabled" : ""}>Reset link</button><button type="button" class="btn small" data-toggle>${u.status === "disabled" ? "Enable" : "Disable"}</button>`
        }</td>
      </tr>`;
    })
    .join("");
  $("#users-table tbody").querySelectorAll("tr").forEach((tr) => {
    const id = tr.dataset.id;
    const u = users.find((x) => String(x.id) === id);
    tr.querySelector(".user-role").addEventListener("change", (e) => act(() => api(`/api/admin/users/${id}`, { method: "PATCH", body: { role: e.target.value } }), () => toast(`${u.email} is now ${ROLE_LABEL[e.target.value]}.`, 3000)));
    tr.querySelector("[data-reset]")?.addEventListener("click", () => act(() => api(`/api/admin/users/${id}/reset`, { method: "POST" }), (res) => showLink(res, u.email)));
    tr.querySelector("[data-toggle]")?.addEventListener("click", () => {
      const status = u.status === "disabled" ? "active" : "disabled";
      if (status === "disabled" && !confirm(`Disable ${u.email}? They’ll be signed out straight away.`)) return;
      act(() => api(`/api/admin/users/${id}`, { method: "PATCH", body: { status } }));
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
