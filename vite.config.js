import { defineConfig } from "vite";
import { apiMiddleware, startCollector } from "./server/api.js";

export default defineConfig({
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
