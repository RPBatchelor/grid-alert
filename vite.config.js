import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { apiMiddleware, startCollector } from "./server/api.js";
import { pageGate } from "./server/auth.js";

// Version info shown in Settings → About.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
// GIT_COMMIT is passed in by the Docker build, which has no .git folder.
let commit = process.env.GIT_COMMIT ?? "";
try {
  commit ||= execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {
  /* not a git checkout */
}

// The dev/preview server reads server settings (ADMIN_*, RESEND_API_KEY, …) from .env, like
// `npm start` does. Variables already set in the shell take precedence.
for (const [k, v] of Object.entries(loadEnv("development", process.cwd(), ""))) process.env[k] ??= v;

// Same sign-in rules as the production server (server/index.js).
function gate(req, res, next) {
  const result = pageGate(req, res);
  if (result === "done") return;
  if (result === "login") req.url = `/login.html${new URL(req.url, "http://localhost").search}`;
  next();
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(commit),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        login: fileURLToPath(new URL("./login.html", import.meta.url)),
      },
    },
  },
  plugins: [
    {
      name: "outage-api",
      configureServer(server) {
        server.middlewares.use(apiMiddleware);
        server.middlewares.use(gate);
        startCollector();
      },
      configurePreviewServer(server) {
        server.middlewares.use(apiMiddleware);
        server.middlewares.use(gate);
        startCollector();
      },
    },
  ],
});
