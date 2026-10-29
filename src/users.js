// Signed-in user: session check, sign-out and role-based UI. Account management is in admin.js.
const $ = (s) => document.querySelector(s);
export const ROLE_LABEL = { viewer: "Viewer", operator: "Operator", admin: "Admin" };

let me = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const toLogin = () => location.replace("/login");

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

export function initUsers() {
  renderUserBox();
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
