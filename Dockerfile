# syntax=docker/dockerfile:1
# Base image pinned by digest (supply-chain habit; see docs/ARCHITECTURE.md).
FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

RUN npm install -g --ignore-scripts pnpm@12.15.0 && npm cache clean --force
# QEMU and e2fsprogs run the teammate micro-VMs (Gondolin) and build their image.
RUN apt-get update && apt-get install -y --no-install-recommends qemu-system-x86 qemu-system-arm e2fsprogs ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune

COPY db ./db
COPY images ./images
COPY src ./src

RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production HOME=/data/home PEEBLO_DATA_DIR=/data
VOLUME ["/data"]

ENTRYPOINT ["node", "src/bin.ts"]
CMD ["daemon"]
