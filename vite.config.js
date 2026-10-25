import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { apiMiddleware, startCollector } from "./server/api.js";

// Version info shown in Settings → About.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
// GIT_COMMIT is passed in by the Docker build, which has no .git folder.
let commit = process.env.GIT_COMMIT ?? "";
try {
  commit ||= execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {
  /* not a git checkout */
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(commit),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    {
      name: "outage-api",
      configureServer(server) {
        server.middlewares.use(apiMiddleware);
        startCollector();
      },
      configurePreviewServer(server) {
        server.middlewares.use(apiMiddleware);
        startCollector();
      },
    },
  ],
});
