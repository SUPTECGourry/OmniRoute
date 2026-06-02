# ── Common base with runtime deps ──────────────────────────────────────────
FROM node:24-trixie-slim AS base
WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=shared \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=shared \
  apt-get update \
  && apt-get install -y --no-install-recommends libsecret-1-0 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ── Builder ────────────────────────────────────────────────────────────────
FROM base AS builder

# Build tools for native module compilation
# apt-get update needed here because base's rm -rf clears the shared cache
RUN --mount=type=cache,target=/var/cache/apt,sharing=shared \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=shared \
  apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY scripts/build/postinstall.mjs ./scripts/build/postinstall.mjs
COPY scripts/build/postinstallSupport.mjs ./scripts/build/postinstallSupport.mjs
COPY scripts/build/native-binary-compat.mjs ./scripts/build/native-binary-compat.mjs
ENV NPM_CONFIG_LEGACY_PEER_DEPS=true
# --ignore-scripts blocks broad dependency install/postinstall hooks, closing
# the supply-chain attack surface where a transitive dep can run arbitrary code
# at install time. better-sqlite3 still needs a native binding for the target
# platform, so rebuild and smoke-test only that known runtime dependency below.
#
# We REQUIRE a committed package-lock.json so resolved dependency versions
# are reproducible.
RUN test -f package-lock.json \
  || (echo "package-lock.json is required for reproducible Docker builds" >&2 && exit 1)
RUN --mount=type=cache,target=/root/.npm \
  npm ci --no-audit --no-fund --legacy-peer-deps --ignore-scripts \
  && npm rebuild better-sqlite3 \
  && node -e "require('better-sqlite3')(':memory:').close()"

# Force-install all Linux platform packages for sqlite-vec (declared as
# optionalDependencies of "sqlite-vec"). `npm ci --ignore-scripts` can cause
# the platform-specific package (e.g. sqlite-vec-linux-x64) to be omitted in
# some BuildKit / cross-platform buildx scenarios. Explicit install guarantees
# the directories exist so the unconditional COPY steps below in runner-base
# never produce "not found" during multi-arch (amd64+arm64) builds.
npm install --no-save --ignore-scripts --legacy-peer-deps \
  sqlite-vec-linux-x64@^0.1.9 \
  sqlite-vec-linux-arm64@^0.1.9 \
  || true

# Use Turbopack for significant build speedup
ENV OMNIROUTE_USE_TURBOPACK=1

COPY . ./
RUN --mount=type=cache,target=/app/.next/cache \
  mkdir -p /app/data && npm run build

# ── Runner base ────────────────────────────────────────────────────────────
FROM base AS runner-base

LABEL org.opencontainers.image.title="omniroute" \
  org.opencontainers.image.description="Unified AI proxy — route any LLM through one endpoint" \
  org.opencontainers.image.url="https://omniroute.online" \
  org.opencontainers.image.source="https://github.com/diegosouzapw/OmniRoute" \
  org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV OMNIROUTE_MEMORY_MB=1024
ENV NODE_OPTIONS="--max-old-space-size=${OMNIROUTE_MEMORY_MB}"
# Raise the chatCore heap pressure guard well above baseline usage in the
# full-featured image (many providers, i18n, etc.). The guard in chatCore.ts
# will also adapt using OMNIROUTE_MEMORY_MB if this is not set.
ENV HEAP_PRESSURE_THRESHOLD_MB=850

# Data directory inside Docker — must match the volume mount in docker-compose.yml
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data

# The standalone build + syncStandaloneExtraModules bundles all runtime files
# (.next, node_modules, migrations, scripts, docs, etc.) into .next/standalone/.
# Explicit overrides below cover modules that NFT tracing may miss.
COPY --from=builder /app/.next/standalone ./
# Explicitly copy @swc/helpers — not always traced by standalone output but needed at runtime
COPY --from=builder /app/node_modules/@swc/helpers ./node_modules/@swc/helpers
# Explicitly copy better-sqlite3 — native bindings are not reliably traced by
# Next.js standalone output, but bootstrap-env requires SQLite before startup.
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
# Explicitly copy sqlite-vec (+ linux-*-x64/arm64 optional native .so) for vector
# memory search. The package uses dynamic platform require + loadExtension;
# standalone + Turbopack tracing frequently misses the optional deps.
# We copy *both* linux variants so multi-arch builds (which only install the
# matching optional for the target platform) still succeed at COPY time.
COPY --from=builder /app/node_modules/sqlite-vec ./node_modules/sqlite-vec
COPY --from=builder /app/node_modules/sqlite-vec-linux-x64 ./node_modules/sqlite-vec-linux-x64
COPY --from=builder /app/node_modules/sqlite-vec-linux-arm64 ./node_modules/sqlite-vec-linux-arm64

# sql.js WASM fallback (used by DB init when better-sqlite3 load fails or in fallback paths).
# Build isolation + Turbopack sometimes results in code referencing the WASM under a /ROOT/ path.
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js
RUN mkdir -p /ROOT/node_modules/sql.js/dist && \
    cp /app/node_modules/sql.js/dist/sql-wasm.wasm /ROOT/node_modules/sql.js/dist/sql-wasm.wasm 2>/dev/null || true && \
    chown -R node:node /ROOT 2>/dev/null || true
# Explicitly copy pino transport dependencies — pino spawns a worker that requires
# pino-abstract-transport at runtime; Next.js standalone trace does not capture it (#449)
COPY --from=builder /app/node_modules/pino-abstract-transport ./node_modules/pino-abstract-transport
COPY --from=builder /app/node_modules/pino-pretty ./node_modules/pino-pretty
COPY --from=builder /app/node_modules/split2 ./node_modules/split2
# Migration SQL files are read via fs.readFileSync at runtime and are NOT
# traced by Next.js standalone output — copy them explicitly.
COPY --from=builder /app/src/lib/db/migrations ./migrations
ENV OMNIROUTE_MIGRATIONS_DIR=/app/migrations

# Hand /app over to the baked-in `node` non-root user (UID/GID 1000) so the
# runtime process never holds root privileges. The chown happens after all
# COPYs so it covers files originally owned by root in the builder stage.
RUN chown -R node:node /app

EXPOSE 20128

# Drop to non-root before ENTRYPOINT/CMD so every derived stage (runner-cli,
# runner-web) also runs as a non-root user unless they explicitly switch back.
USER node

# Warns if the mounted data volume has wrong ownership
COPY --chmod=755 scripts/check-permissions.sh /tmp/check-permissions.sh
ENTRYPOINT ["/tmp/check-permissions.sh"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "healthcheck.mjs"]

CMD ["node", "dev/run-standalone.mjs"]

# ── Runner Web (web-cookie providers: Gemini Web, Claude Turnstile) ───────────
#
#  Two image flavors:
#    runner-base  →  omniroute:VERSION        Lean base (~500 MB). No browsers.
#    runner-web   →  omniroute:VERSION-web    +Chromium/Playwright (~800 MB).
#
#  Use runner-web when you need web-cookie providers (gemini-web, claude-web,
#  claude-turnstile). For all other providers runner-base is sufficient.
#
#  Build:
#    docker build --target runner-web -t omniroute:web .
#  Compose:
#    build:
#      context: .
#      target: runner-web
FROM runner-base AS runner-web

USER root

# Install Playwright browser binaries + OS dependencies under root, then hand
# ownership of the browsers cache to the node user.
# PLAYWRIGHT_BROWSERS_PATH overrides the default ~/.cache/ms-playwright so the
# browsers land under /home/node which persists across image layers and is
# accessible to the non-root runtime user.
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && npx playwright install chromium --with-deps \
  && chown -R node:node /home/node/.cache \
  && rm -rf /var/lib/apt/lists/*

USER node

FROM runner-base AS runner-cli

# Drop back to root briefly so we can install system + global npm packages,
# then return to the `node` non-root user before the CMD inherited from
# runner-base runs.
USER root

# Install system dependencies required by openclaw (git+ssh references).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates docker.io docker-compose \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system url."https://github.com/".insteadOf "ssh://git@github.com/"

# Install CLI tools globally. Separate layer from apt for better cache reuse.
RUN --mount=type=cache,target=/root/.npm \
  npm install -g --no-audit --no-fund @openai/codex @anthropic-ai/claude-code droid openclaw@latest

USER node
