# Grid Alert Victoria — production image (multi-arch: works on Raspberry Pi 5 / arm64
# and x86_64). Build: docker compose build   Run: docker compose up -d

# ---- Build the browser app ----------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Shown in Settings → About (the build context has no .git folder).
ARG GIT_COMMIT=""
ENV GIT_COMMIT=${GIT_COMMIT}
RUN npm run build

# ---- Runtime: Node server + built app ------------------------------------------------------
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    HISTORY_DB=/data/history.sqlite \
    COLLECT_INTERVAL_MINUTES=5 \
    TZ=Australia/Melbourne
RUN apk add --no-cache tzdata
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server

# History lives on a mounted volume so it survives rebuilds and upgrades.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8080

# Unhealthy if the server stops answering or snapshots stop arriving.
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
