// Landing page: sign in, request access, forgot password and set password (from an emailed link).
import "./style.css";
import "./login.css";

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const token = params.get("token");

const views = ["#lp-main", "#form-forgot", "#form-setpw", "#lp-done"];
function show(view) {
  for (const v of views) $(v).hidden = v !== view;
  $(view).querySelector("input")?.focus();
}

function tab(name) {
  const signin = name === "signin";
  $("#tab-signin").setAttribute("aria-selected", String(signin));
  $("#tab-request").setAttribute("aria-selected", String(!signin));
  $("#form-signin").hidden = !signin;
  $("#form-request").hidden = signin;
  (signin ? $("#form-signin") : $("#form-request")).querySelector("input").focus();
}

function done(text) {
  $("#lp-done-text").textContent = text;
  show("#lp-done");
}

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Something went wrong (HTTP ${res.status}).`);
  return json;
}

// Wire a form: validate, disable while sending, show errors inline.
function handle(form, submit) {
  const error = form.querySelector(".form-error");
  const button = form.querySelector("[type=submit]");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    const data = Object.fromEntries(new FormData(form));
    const invalid = [...form.querySelectorAll("[required]")].find((el) => !el.value.trim() || !el.checkValidity());
    if (invalid) {
      error.textContent = invalid.type === "email" ? "Enter a valid email address." : invalid.minLength > 0 ? `Use at least ${invalid.minLength} characters.` : "Fill in the required fields.";
      invalid.focus();
      return;
    }
    button.disabled = true;
    try {
      await submit(data);
    } catch (err) {
      error.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
}

const goToApp = () => location.replace(params.get("next")?.startsWith("/") ? params.get("next") : "/");

handle($("#form-signin"), async (d) => {
  await post("/api/auth/login", { email: d.email, password: d.password });
  goToApp();
});
handle($("#form-request"), async (d) => {
  const r = await post("/api/auth/request-access", d);
  $("#form-request").reset();
  done(r.message);
});
handle($("#form-forgot"), async (d) => {
  const r = await post("/api/auth/forgot", { email: d.email });
  done(r.message);
});
handle($("#form-setpw"), async (d) => {
  if (d.password !== d.confirm) throw new Error("The passwords don’t match.");
  await post("/api/auth/set-password", { token, password: d.password });
  history.replaceState(null, "", "/login");
  location.replace("/");
});

$("#tab-signin").addEventListener("click", () => tab("signin"));
$("#tab-request").addEventListener("click", () => tab("request"));
$(".lp-tabs").addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") tab($("#tab-signin").getAttribute("aria-selected") === "true" ? "request" : "signin");
});
$("#show-forgot").addEventListener("click", () => {
  $("#form-forgot [name=email]").value = $("#form-signin [name=email]").value;
  show("#form-forgot");
});
document.querySelectorAll("[data-back]").forEach((b) =>
  b.addEventListener("click", () => {
    show("#lp-main");
    tab("signin");
  }),
);

if (token) show("#form-setpw");
else if (params.get("tab") === "request") tab("request");
else $("#form-signin [name=email]").focus();
