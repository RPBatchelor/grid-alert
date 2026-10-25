// Sign-in for Grid Alert Victoria: personal accounts with a request-access flow.
//
// - People request access on the landing page; the admin is emailed and approves or declines
//   in Settings → Users, choosing a role. Approval emails a one-time link to set a password.
// - Roles: viewer (read only) < operator (start/stop/edit events) < admin (manage users).
// - Passwords: scrypt (Node crypto). Sessions: random token in an HttpOnly cookie; only its
//   SHA-256 is stored. Set-password links are single-use and expire after 48 hours.
// - The first admin is created from ADMIN_EMAIL / ADMIN_PASSWORD on start-up if no admin exists.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { open } from "./history.js";
import { escapeHtml, sendMail } from "./mail.js";

export const ROLES = ["viewer", "operator", "admin"];
const ROLE_LABEL = { viewer: "Viewer", operator: "Operator", admin: "Admin" };
const SESSION_DAYS = 14;
const TOKEN_HOURS = 48;
const MIN_PASSWORD = 10;
const COOKIE = "ga_session";

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let ready = false;
function db() {
  const d = open();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL DEFAULT '',
        organisation TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'viewer',
        status TEXT NOT NULL DEFAULT 'active',      -- active | disabled
        password_hash TEXT,
        created_at INTEGER NOT NULL,
        last_login INTEGER
      );
      CREATE TABLE IF NOT EXISTS access_requests (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        organisation TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',     -- pending | approved | declined
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users (id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users (id),
        purpose TEXT NOT NULL,                      -- set-password
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
    `);
    ready = true;
  }
  return d;
}

// ---- Primitives -------------------------------------------------------------------------

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const normEmail = (e) => String(e ?? "").trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyPassword(password, stored) {
  if (!stored?.startsWith("scrypt$")) return false;
  const [, N, r, p, salt, hash] = stored.split("$");
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(actual, expected);
}

// Simple in-memory rate limiting (per key, sliding window).
const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) throw new AuthError(429, "Too many attempts. Please wait a few minutes and try again.");
  list.push(now);
  hits.set(key, list);
}

export function clientIp(req) {
  return String(req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "").split(",")[0].trim();
}

function appUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  return `${proto}://${req.headers.host}`;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(req, value, maxAgeSeconds) {
  const secure = req.headers["x-forwarded-proto"] === "https" || process.env.COOKIE_SECURE === "1";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

const publicUser = (u) => u && { id: u.id, email: u.email, name: u.name, organisation: u.organisation, role: u.role };

// ---- Sessions ---------------------------------------------------------------------------

function createSession(userId) {
  const token = newToken();
  const now = Date.now();
  db().prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)").run(sha256(token), userId, now, now + SESSION_DAYS * 86400e3, now);
  db().prepare("UPDATE users SET last_login = ? WHERE id = ?").run(now, userId);
  return token;
}

// The signed-in user for a request, or null.
export function sessionUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const row = db()
    .prepare("SELECT u.*, s.last_seen AS s_last_seen, s.token_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'")
    .get(sha256(token), Date.now());
  if (!row) return null;
  if (Date.now() - row.s_last_seen > 5 * 60000) db().prepare("UPDATE sessions SET last_seen = ? WHERE token_hash = ?").run(Date.now(), row.token_hash);
  return row;
}

export const roleAtLeast = (user, role) => !!user && ROLES.indexOf(user.role) >= ROLES.indexOf(role);

// ---- Set-password links -----------------------------------------------------------------

function issueSetPasswordLink(req, userId) {
  const token = newToken();
  db().prepare("UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(Date.now(), userId); // one live link per user
  db().prepare("INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, 'set-password', ?)").run(sha256(token), userId, Date.now() + TOKEN_HOURS * 3600e3);
  return `${appUrl(req)}/login?token=${token}`;
}

async function emailSetPassword(req, user, { welcome }) {
  const link = issueSetPasswordLink(req, user.id);
  const sent = await sendMail({
    to: user.email,
    subject: welcome ? "Your Grid Alert Victoria access is approved" : "Set your Grid Alert Victoria password",
    heading: welcome ? "Access approved" : "Set a new password",
    paragraphs: [
      `Hi ${escapeHtml(user.name || user.email)},`,
      welcome
        ? `Your request for access to Grid Alert Victoria has been approved with the <b>${ROLE_LABEL[user.role]}</b> role. Set your password to sign in.`
        : "Use the button below to set a new password for Grid Alert Victoria.",
      `This link works once and expires in ${TOKEN_HOURS} hours.`,
    ],
    button: { label: "Set your password", url: link },
    footer: "If you didn’t expect this email, you can ignore it.",
  });
  return { emailed: sent, link: sent ? undefined : link };
}

// ---- Bootstrap the first admin ----------------------------------------------------------

export function ensureAdmin() {
  const email = normEmail(process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD;
  const hasAdmin = db().prepare("SELECT 1 FROM users WHERE role = 'admin' AND status = 'active'").get();
  if (hasAdmin) return;
  if (!email || !password || password.length < MIN_PASSWORD) {
    console.warn(`AUTH: no admin account yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (${MIN_PASSWORD}+ characters) in .env and restart.`);
    return;
  }
  const existing = db().prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) db().prepare("UPDATE users SET role = 'admin', status = 'active', password_hash = ? WHERE id = ?").run(hashPassword(password), existing.id);
  else db().prepare("INSERT INTO users (email, name, role, status, password_hash, created_at) VALUES (?, ?, 'admin', 'active', ?, ?)").run(email, process.env.ADMIN_NAME ?? "Administrator", hashPassword(password), Date.now());
  console.log(`AUTH: admin account ready for ${email}. You can remove ADMIN_PASSWORD from .env now.`);
}

export function purgeExpired() {
  const now = Date.now();
  db().prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
  db().prepare("DELETE FROM auth_tokens WHERE expires_at < ? OR used_at < ?").run(now - 86400e3, now - 30 * 86400e3);
}

// ---- Handlers ---------------------------------------------------------------------------

const adminEmails = () =>
  (process.env.ADMIN_NOTIFY_EMAIL ? process.env.ADMIN_NOTIFY_EMAIL.split(",") : db().prepare("SELECT email FROM users WHERE role = 'admin' AND status = 'active'").all().map((r) => r.email))
    .map(normEmail)
    .filter(Boolean);

async function login(req, body) {
  const email = normEmail(body.email);
  rateLimit(`login:${clientIp(req)}`, 20, 15 * 60000);
  rateLimit(`login:${email}`, 8, 15 * 60000);
  const user = db().prepare("SELECT * FROM users WHERE email = ?").get(email);
  // Same message for unknown email, wrong password or disabled account.
  if (!user || user.status !== "active" || !verifyPassword(String(body.password ?? ""), user.password_hash)) {
    throw new AuthError(401, "Email or password is incorrect.");
  }
  return { user: publicUser(user), session: createSession(user.id) };
}

async function requestAccess(req, body) {
  rateLimit(`request:${clientIp(req)}`, 5, 60 * 60000);
  const email = normEmail(body.email);
  const name = String(body.name ?? "").trim().slice(0, 120);
  const organisation = String(body.organisation ?? "").trim().slice(0, 120);
  const reason = String(body.reason ?? "").trim().slice(0, 1000);
  if (!validEmail(email)) throw new AuthError(400, "Enter a valid email address.");
  if (!name) throw new AuthError(400, "Enter your name.");
  const existingUser = db().prepare("SELECT status FROM users WHERE email = ?").get(email);
  const pending = db().prepare("SELECT 1 FROM access_requests WHERE email = ? AND status = 'pending'").get(email);
  // Respond the same way regardless, so the form can't be used to discover who has access.
  if (!pending && !(existingUser?.status === "active")) {
    db().prepare("INSERT INTO access_requests (email, name, organisation, reason, created_at) VALUES (?, ?, ?, ?, ?)").run(email, name, organisation, reason, Date.now());
    for (const to of adminEmails()) {
      await sendMail({
        to,
        replyTo: email,
        subject: `Access request: ${name} (${email})`,
        heading: "New access request",
        paragraphs: [
          `<b>${escapeHtml(name)}</b> &lt;${escapeHtml(email)}&gt;${organisation ? ` · ${escapeHtml(organisation)}` : ""}`,
          reason ? `“${escapeHtml(reason)}”` : "No reason given.",
          "Approve or decline in Settings → Users.",
        ],
        button: { label: "Review request", url: `${appUrl(req)}/?settings=users` },
      });
    }
  }
  return { ok: true, message: "Thanks — your request has been sent. You’ll get an email when it’s approved." };
}

async function forgotPassword(req, body) {
  rateLimit(`forgot:${clientIp(req)}`, 5, 60 * 60000);
  const user = db().prepare("SELECT * FROM users WHERE email = ? AND status = 'active'").get(normEmail(body.email));
  if (user) await emailSetPassword(req, user, { welcome: false });
  return { ok: true, message: "If that email has access, a link to set a new password is on its way." };
}

function setPassword(req, body) {
  rateLimit(`setpw:${clientIp(req)}`, 10, 15 * 60000);
  const password = String(body.password ?? "");
  if (password.length < MIN_PASSWORD) throw new AuthError(400, `Use at least ${MIN_PASSWORD} characters.`);
  const row = db()
    .prepare("SELECT t.*, u.status FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ?")
    .get(sha256(String(body.token ?? "")), Date.now());
  if (!row || row.status !== "active") throw new AuthError(400, "This link has expired or has already been used. Ask for a new one with “Forgot password”.");
  db().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), row.user_id);
  db().prepare("UPDATE auth_tokens SET used_at = ? WHERE token_hash = ?").run(Date.now(), row.token_hash);
  db().prepare("DELETE FROM sessions WHERE user_id = ?").run(row.user_id); // sign out other sessions
  const user = db().prepare("SELECT * FROM users WHERE id = ?").get(row.user_id);
  return { user: publicUser(user), session: createSession(user.id) };
}

// ---- Admin ------------------------------------------------------------------------------

function listAdmin() {
  return {
    requests: db().prepare("SELECT * FROM access_requests WHERE status = 'pending' ORDER BY created_at").all(),
    users: db().prepare("SELECT id, email, name, organisation, role, status, created_at, last_login, password_hash IS NOT NULL AS has_password FROM users ORDER BY role = 'admin' DESC, name").all(),
  };
}

async function approveRequest(req, admin, id, body) {
  const r = db().prepare("SELECT * FROM access_requests WHERE id = ? AND status = 'pending'").get(id);
  if (!r) throw new AuthError(404, "Request not found or already handled.");
  const role = ROLES.includes(body.role) ? body.role : "viewer";
  let user = db().prepare("SELECT * FROM users WHERE email = ?").get(r.email);
  if (user) db().prepare("UPDATE users SET role = ?, status = 'active', name = ?, organisation = ? WHERE id = ?").run(role, r.name, r.organisation, user.id);
  else db().prepare("INSERT INTO users (email, name, organisation, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)").run(r.email, r.name, r.organisation, role, Date.now());
  user = db().prepare("SELECT * FROM users WHERE email = ?").get(r.email);
  db().prepare("UPDATE access_requests SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ?").run(Date.now(), admin.email, id);
  return { ok: true, user: publicUser(user), ...(await emailSetPassword(req, user, { welcome: true })) };
}

async function declineRequest(admin, id, body) {
  const r = db().prepare("SELECT * FROM access_requests WHERE id = ? AND status = 'pending'").get(id);
  if (!r) throw new AuthError(404, "Request not found or already handled.");
  db().prepare("UPDATE access_requests SET status = 'declined', decided_at = ?, decided_by = ? WHERE id = ?").run(Date.now(), admin.email, id);
  if (body.notify) {
    await sendMail({ to: r.email, subject: "Your Grid Alert Victoria access request", heading: "Access request not approved", paragraphs: [`Hi ${escapeHtml(r.name)},`, "Your request for access to Grid Alert Victoria wasn’t approved at this time. Reply to the person who invited you if you think this is a mistake."] });
  }
  return { ok: true };
}

async function inviteUser(req, body) {
  const email = normEmail(body.email);
  if (!validEmail(email)) throw new AuthError(400, "Enter a valid email address.");
  const role = ROLES.includes(body.role) ? body.role : "viewer";
  if (db().prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new AuthError(409, "That person already has an account.");
  db().prepare("INSERT INTO users (email, name, organisation, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)").run(email, String(body.name ?? "").trim().slice(0, 120), String(body.organisation ?? "").trim().slice(0, 120), role, Date.now());
  const user = db().prepare("SELECT * FROM users WHERE email = ?").get(email);
  return { ok: true, user: publicUser(user), ...(await emailSetPassword(req, user, { welcome: true })) };
}

function updateUser(admin, id, body) {
  const user = db().prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!user) throw new AuthError(404, "User not found.");
  const role = body.role && ROLES.includes(body.role) ? body.role : user.role;
  const status = body.status === "disabled" || body.status === "active" ? body.status : user.status;
  if (user.id === admin.id && (role !== "admin" || status !== "active")) throw new AuthError(400, "You can’t remove your own admin access.");
  db().prepare("UPDATE users SET role = ?, status = ? WHERE id = ?").run(role, status, id);
  if (status === "disabled") db().prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  return { ok: true };
}

async function resetUser(req, id) {
  const user = db().prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(id);
  if (!user) throw new AuthError(404, "User not found or disabled.");
  return { ok: true, ...(await emailSetPassword(req, user, { welcome: false })) };
}

// ---- Router -----------------------------------------------------------------------------
// Handles /api/auth/* (public) and /api/admin/* (admin only). Returns true if it handled the
// request. `send(status, body, headers)` writes the JSON response.

export async function authRoutes(req, res, url, body, send) {
  const path = url.pathname;
  if (!path.startsWith("/api/auth/") && !path.startsWith("/api/admin/")) return false;
  const m = req.method;
  const withSession = (result) => send(200, { user: result.user }, { "Set-Cookie": cookieHeader(req, result.session, SESSION_DAYS * 86400) });

  if (path === "/api/auth/me" && m === "GET") {
    const user = sessionUser(req);
    return user ? send(200, { user: publicUser(user) }) : send(401, { error: "Not signed in." });
  }
  if (path === "/api/auth/login" && m === "POST") return withSession(await login(req, body));
  if (path === "/api/auth/logout" && m === "POST") {
    const token = parseCookies(req)[COOKIE];
    if (token) db().prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    return send(200, { ok: true }, { "Set-Cookie": cookieHeader(req, "", 0) });
  }
  if (path === "/api/auth/request-access" && m === "POST") return send(200, await requestAccess(req, body));
  if (path === "/api/auth/forgot" && m === "POST") return send(200, await forgotPassword(req, body));
  if (path === "/api/auth/set-password" && m === "POST") return withSession(setPassword(req, body));

  if (path.startsWith("/api/admin/")) {
    const admin = sessionUser(req);
    if (!admin) throw new AuthError(401, "Not signed in.");
    if (admin.role !== "admin") throw new AuthError(403, "Admins only.");
    let mm;
    if (path === "/api/admin/overview" && m === "GET") return send(200, listAdmin());
    if (path === "/api/admin/users" && m === "POST") return send(200, await inviteUser(req, body));
    if ((mm = path.match(/^\/api\/admin\/requests\/(\d+)\/approve$/)) && m === "POST") return send(200, await approveRequest(req, admin, +mm[1], body));
    if ((mm = path.match(/^\/api\/admin\/requests\/(\d+)\/decline$/)) && m === "POST") return send(200, await declineRequest(admin, +mm[1], body));
    if ((mm = path.match(/^\/api\/admin\/users\/(\d+)$/)) && m === "PATCH") return send(200, updateUser(admin, +mm[1], body));
    if ((mm = path.match(/^\/api\/admin\/users\/(\d+)\/reset$/)) && m === "POST") return send(200, await resetUser(req, +mm[1]));
  }
  throw new AuthError(404, "Not found.");
}

// ---- Page gate --------------------------------------------------------------------------
// Decides what a page request gets: the app (signed in), the landing page, or a redirect.
// Returns "app" (continue as normal), "login" (serve login.html) or "done" (response sent).
// Bundled assets and dev-server internals pass through; they hold no data.
export function pageGate(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const redirect = (to) => {
    res.writeHead(302, { Location: to, "Cache-Control": "no-store" });
    res.end();
    return "done";
  };
  if (p.startsWith("/api/") || p.startsWith("/@") || p.startsWith("/__")) return "app";
  if (p === "/login" || p === "/login.html" || p === "/set-password") {
    if (!url.searchParams.has("token") && sessionUser(req)) return redirect("/");
    return "login";
  }
  const isPage = p === "/" || p === "/index.html" || !/\.[a-z0-9]+$/i.test(p);
  if (isPage && !sessionUser(req)) return redirect("/login");
  return "app";
}
