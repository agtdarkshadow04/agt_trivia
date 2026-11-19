# syntax=docker/dockerfile:1

# The AGT Galactic Trivia image (DEP-1). Build: docker compose build (README, Installation).

# ---- build: compile better-sqlite3, build the client and the server bundle, drop the dev dependencies
FROM node:26-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime: the slim Node 26 image, as the non-root node user (SEC-15)
FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production \
    AGT_TRIVIA_CONFIG_FILE=/app/config.yaml \
    AGT_TRIVIA_SERVER_HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
# The database, the log store and the backups directory (storage.dataDir: data).
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 8082
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8082/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist-server/index.mjs"]
