# syntax=docker/dockerfile:1
# Base image pinned by digest, so a rebuild gets the same bytes.
FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS base
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
# Fonts: the ID cards and faces are drawn from SVG, and text needs a font (DejaVu stands in for Helvetica/Arial).
RUN apt-get update && apt-get install -y --no-install-recommends qemu-system-x86 qemu-system-arm qemu-utils e2fsprogs cpio lz4 ca-certificates git unzip curl \
    fontconfig fonts-dejavu-core \
 && fc-cache -f && rm -rf /var/lib/apt/lists/*

# The Docker CLI (pinned, static) builds the large computer image; only `./peeblo image large` lends it the host's
# Docker socket, for that one command. Core itself never has the socket.
RUN arch="$(uname -m)" && curl -fsSL "https://download.docker.com/linux/static/stable/${arch}/docker-27.3.1.tgz" | tar -xz --strip-components=1 -C /usr/local/bin docker/docker

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
