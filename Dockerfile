# syntax=docker/dockerfile:1
# Base image pinned by digest (supply-chain habit; see docs/ARCHITECTURE.md).
FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS base
RUN npm install -g --ignore-scripts pnpm@12.15.0 && npm cache clean --force

# The console (served by core at /console/).
FROM base AS console
WORKDIR /console
COPY console/package.json console/pnpm-lock.yaml console/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY console ./
RUN pnpm build

FROM base
# QEMU and e2fsprogs run the teammate micro-VMs (Gondolin) and build their image; git keeps company and teammate
# memory; cpio and lz4 pack the image's initramfs; unzip and curl fetch the computer image's vendored tools and answer the health check.
RUN apt-get update && apt-get install -y --no-install-recommends qemu-system-x86 qemu-system-arm qemu-utils e2fsprogs cpio lz4 ca-certificates git unzip curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune

COPY assets ./assets
COPY config ./config
COPY db ./db
COPY images ./images
COPY policies ./policies
COPY skills ./skills
COPY src ./src
COPY --from=console /console/dist ./console/dist

RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production HOME=/data/home PEEBLO_DATA_DIR=/data
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s CMD curl -fsS http://127.0.0.1:7340/healthz || exit 1

ENTRYPOINT ["node", "src/bin.ts"]
CMD ["daemon"]
