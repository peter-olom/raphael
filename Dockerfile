# syntax=docker/dockerfile:1.7
#
# Hardened production image:
# - Multi-stage build (compile native deps + build client/server)
# - Distroless runtime (no shell, no package manager)
# - Non-root by default
#
# Notes:
# - SQLite DB should live on a writable volume mounted at /data
# - Compose should run with read-only rootfs + tmpfs for /tmp

FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Native deps for better-sqlite3 builds on Debian.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Build server + client into dist/
RUN npm run build

# Reduce runtime surface: keep only production deps.
RUN npm prune --omit=dev

# Prepare runtime writable dir with correct ownership for distroless nonroot (65532).
RUN mkdir -p /data \
  && chown -R 65532:65532 /data


FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=6274
ENV RAPHAEL_DB_PATH=/data/raphael.db

# App code + production deps only.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Writable volume mountpoint (copied into an empty named volume on first run).
COPY --from=builder /data /data

EXPOSE 6274

# Distroless node images use "node" as entrypoint; provide the script as CMD.
CMD ["dist/server/index.js"]

