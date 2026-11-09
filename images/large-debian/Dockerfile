# The large computer on Debian 13 (glibc): built with Docker, then Gondolin turns it into a VM image
# (`peeblo image large`). Without Docker or Podman, the large computer stays on Alpine (images/large-*.json).
# Same tools as the Alpine large image, plus bun and Playwright MCP. Every download is pinned by sha256 in
# fetch.sh; the base image is pinned by digest.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# What Gondolin's init uses (kmod, ip, udhcpc, rngd, mkfs), then the same tool set as Alpine large.
RUN apt-get update && apt-get install -y --no-install-recommends \
      kmod iproute2 udhcpc rng-tools5 e2fsprogs fuse3 ca-certificates \
      bash curl git openssh-client ripgrep fd-find jq sqlite3 bat git-delta tokei hyperfine xh tree-sitter-cli \
      python3 python3-pip python3-pypdf python3-openpyxl python3-lxml python3-typing-extensions python3-pil \
      python3-xlsxwriter python3-docx python3-pandas python3-numpy python3-matplotlib \
      poppler-utils qpdf file unzip zip 7zip xz-utils tar tmux imagemagick graphviz pandoc \
      tesseract-ocr tesseract-ocr-eng ffmpeg libvips-tools \
      chromium libnss3-tools fonts-dejavu-core fonts-noto-core fonts-noto-color-emoji fonts-liberation fonts-noto-cjk \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
 && ln -sf /usr/bin/fdfind /usr/local/bin/fd && ln -sf /usr/bin/batcat /usr/local/bin/bat \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Pinned binaries Debian doesn't package (or packages too old): Node 24, bun, uv, typst, ruff, ast-grep,
# difftastic, duckdb, yq (mikefarah), agent-browser, and two Python wheels.
COPY fetch.sh /tmp/fetch.sh
RUN sh /tmp/fetch.sh "${TARGETARCH:-$(dpkg --print-architecture)}" && rm /tmp/fetch.sh

# npm globals at exact versions. Playwright MCP drives the system Chromium (no browser download).
RUN npm install -g --no-audit --no-fund pnpm@12.18.0 @playwright/mcp@0.0.84 && npm cache clean --force \
 && mkdir -p /etc/playwright-mcp \
 && printf '%s\n' '{"browser":{"browserName":"chromium","launchOptions":{"executablePath":"/usr/bin/chromium","headless":true,"args":["--no-sandbox"]}}}' > /etc/playwright-mcp/config.json

RUN echo "peeblo-large-debian" > /etc/peeblo-image
