---
title: "🐳 Docker Guide — OmniRoute"
version: 3.8.2
lastUpdated: 2026-05-13
---

# 🐳 Docker Guide — OmniRoute

> Complete Docker deployment reference. For a quick start, see the [README Docker section](../README.md#-docker).

## Table of Contents

- [Quick Run](#quick-run)
- [With Environment File](#with-environment-file)
- [Docker Compose](#docker-compose)
- [Available Profiles](#available-profiles)
- [Redis Sidecar](#redis-sidecar)
- [Production Compose](#production-compose)
- [Dockerfile Stages](#dockerfile-stages)
- [Critical Environment Variables](#critical-environment-variables)
- [Docker Compose with Caddy (HTTPS)](#docker-compose-with-caddy-https-auto-tls)
- [Cloudflare Quick Tunnel](#cloudflare-quick-tunnel)
- [Image Tags](#image-tags)
- [Important Notes](#important-notes)

---

## Quick Run

```bash
docker run -d \
  --name omniroute \
  --restart unless-stopped \
  --stop-timeout 40 \
  -p 20128:20128 \
  -v omniroute-data:/app/data \
  diegosouzapw/omniroute:latest
```

## With Environment File

```bash
# Copy and edit .env first
cp .env.example .env

docker run -d \
  --name omniroute \
  --restart unless-stopped \
  --stop-timeout 40 \
  --env-file .env \
  -p 20128:20128 \
  -v omniroute-data:/app/data \
  diegosouzapw/omniroute:latest
```

## Docker Compose

```bash
# Base profile (no CLI tools)
docker compose --profile base up -d

# CLI profile (Claude Code, Codex, OpenClaw built-in)
docker compose --profile cli up -d

# Host profile (Linux-first; mounts host CLI binaries read-only)
docker compose --profile host up -d

# Combine CLI + CLIProxyAPI sidecar
docker compose --profile cli --profile cliproxyapi up -d
```

## Available Profiles

OmniRoute ships four Compose profiles. Pick the one that matches your environment.

| Profile          | Service          | When to use                                                                                                                       | Command                                      |
| ---------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `base` (default) | `omniroute-base` | Headless server / minimal runtime, no provider CLIs bundled                                                                       | `docker compose --profile base up -d`        |
| `cli`            | `omniroute-cli`  | Agentic workflows that call `omniroute providers/setup/doctor` and bundled CLIs (Codex, Claude Code, Droid, OpenClaw)             | `docker compose --profile cli up -d`         |
| `host`           | `omniroute-host` | Linux hosts that want `network_mode`-like access to host CLIs by mounting `~/.local/bin`, `~/.codex`, `~/.claude`, etc. read-only | `docker compose --profile host up -d`        |
| `cliproxyapi`    | `cliproxyapi`    | Run the [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) sidecar on port `8317` for upstream CLI proxying              | `docker compose --profile cliproxyapi up -d` |

> Multiple profiles can be combined: `docker compose --profile cli --profile cliproxyapi up -d`.

## Redis Sidecar

OmniRoute relies on Redis to back the distributed rate limiter and shared cache. The `redis` service is **always defined** in `docker-compose.yml` (it has no profile gate) and starts alongside any other profile.

| Detail               | Value                             |
| -------------------- | --------------------------------- |
| Image                | `redis:7-alpine`                  |
| Container name       | `omniroute-redis`                 |
| Internal port        | `6379`                            |
| Host port (override) | `REDIS_PORT` (defaults to `6379`) |
| Volume               | `omniroute-redis-data` → `/data`  |
| Healthcheck          | `redis-cli ping` (10s interval)   |

Related environment variables:

- `REDIS_URL` — connection string injected into the app (`redis://redis:6379` by default).
- `REDIS_PORT` — host-side port mapping for the Redis container.

**Disabling Redis** is not recommended (rate limiter will degrade to in-memory fallback). If you must, either remove/comment the `redis:` service block in `docker-compose.yml` or scale it to zero:

```bash
docker compose up -d --scale redis=0
```

## Production Compose

For an isolated production snapshot running alongside dev, use `docker-compose.prod.yml`.

| Detail                 | Value                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------- |
| File                   | `docker-compose.prod.yml`                                                          |
| Default dashboard port | `PROD_DASHBOARD_PORT=20130` (mapped to internal `${DASHBOARD_PORT:-20128}`)        |
| Default API port       | `PROD_API_PORT=20131`                                                              |
| Image                  | `omniroute:prod` (built from `runner-cli` target)                                  |
| Redis container        | `omniroute-redis-prod` (`redis:8.6.2`, dedicated `redis-prod-data` volume)         |
| Data volume            | `omniroute-prod-data` (named, persisted across rebuilds)                           |
| Healthchecks           | `node healthcheck.mjs` + `redis-cli ping`, with `depends_on` gated on Redis health |

How to use:

```bash
# Build & start the production stack
docker compose -f docker-compose.prod.yml up -d --build

# Stream logs
docker compose -f docker-compose.prod.yml logs -f

# Tear down (keep volumes)
docker compose -f docker-compose.prod.yml down
```

The prod stack runs in parallel with the dev compose (different container names, ports, and volumes), so you can keep iterating locally while production stays up.

## Dockerfile Stages

The repository ships a multi-stage Dockerfile (`Dockerfile`). Three stages are exposed; pick the right `target` for your use case.

| Stage         | Base image                 | Purpose                                                                                                                                                            |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `builder`     | `node:24.15.0-trixie-slim` | Installs deps (`npm ci --legacy-peer-deps`) and runs `npm run build -- --webpack`                                                                                  |
| `runner-base` | `node:24.15.0-trixie-slim` | Production runtime with the Next.js standalone output. **No provider CLIs bundled.**                                                                               |
| `runner-cli`  | `runner-base`              | Adds `git`, `docker.io`, `docker-compose` and global CLIs: `@openai/codex`, `@anthropic-ai/claude-code`, `droid`, `openclaw`. **Pick this for agentic workflows.** |

Build a specific target manually:

```bash
docker build --target runner-base -t omniroute:base .
docker build --target runner-cli  -t omniroute:cli  .
```

Defaults exported by `runner-base`: `PORT=20128`, `HOSTNAME=0.0.0.0`, `NODE_OPTIONS=--max-old-space-size=512`, `DATA_DIR=/app/data`, `OMNIROUTE_MIGRATIONS_DIR=/app/migrations`.

Memory behavior in Docker:

- `NODE_OPTIONS=--max-old-space-size=512` is baked into the image as a fallback.
- The actual server process is started by the standalone launcher, which reads `OMNIROUTE_MEMORY_MB` and appends `--max-old-space-size=<OMNIROUTE_MEMORY_MB>`.
- Node uses the last repeated `--max-old-space-size` value, so setting `OMNIROUTE_MEMORY_MB` controls the effective Docker heap limit.
- If `OMNIROUTE_MEMORY_MB` is unset, the launcher uses `512`.

## Critical Environment Variables

Beyond the defaults documented in [ENVIRONMENT.md](../reference/ENVIRONMENT.md), the following variables matter most when running under Docker:

| Variable                      | Purpose                                                                                             | Default                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------ |
| `OMNIROUTE_WS_BRIDGE_SECRET`  | Shared secret for the WebSocket bridge. **Required in production** — set to a strong random string. | unset (must be provided) |
| `REDIS_URL`                   | Connection string for the rate limiter / cache backend                                              | `redis://redis:6379`     |
| `REDIS_PORT`                  | Host-side port for the bundled Redis container                                                      | `6379`                   |
| `AUTO_UPDATE_HOST_REPO_DIR`   | Host path mounted into `cli` profile at `/workspace/omniroute` for self-update workflows            | `.` (current directory)  |
| `OMNIROUTE_MEMORY_MB`         | Runtime Node heap ceiling for the Docker standalone server; overrides the image fallback above      | `512`                    |
| `DASHBOARD_PORT` / `API_PORT` | Override exposed ports for dashboard (20128) and API (20129)                                        | `20128` / `20129`        |
| `PROD_DASHBOARD_PORT`         | Host-side dashboard port for `docker-compose.prod.yml`                                              | `20130`                  |
| `CLIPROXYAPI_PORT`            | Host-side port for the `cliproxyapi` sidecar                                                        | `8317`                   |

## Docker Compose with Caddy (HTTPS Auto-TLS)

OmniRoute can be securely exposed using Caddy's automatic SSL provisioning. Ensure your domain's DNS A record points to your server's IP.

```yaml
services:
  omniroute:
    image: diegosouzapw/omniroute:latest
    container_name: omniroute
    restart: unless-stopped
    volumes:
      - omniroute-data:/app/data
    environment:
      - PORT=20128
      - NEXT_PUBLIC_BASE_URL=https://your-domain.com

  caddy:
    image: caddy:latest
    container_name: caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    command: caddy reverse-proxy --from https://your-domain.com --to http://omniroute:20128

volumes:
  omniroute-data:
```

## Cloudflare Quick Tunnel

Dashboard support for Docker deployments includes a one-click **Cloudflare Quick Tunnel** on `Dashboard → Endpoints`. The first enable downloads `cloudflared` only when needed, starts a temporary tunnel to your current `/v1` endpoint, and shows the generated `https://*.trycloudflare.com/v1` URL directly below your normal public URL.

Endpoint tunnel panels (Cloudflare, Tailscale, ngrok) can be shown or hidden from `Settings → Appearance` without changing active tunnel state.

### Tunnel Notes

- Quick Tunnel URLs are temporary and change after every restart.
- Quick Tunnels are not auto-restored after an OmniRoute or container restart. Re-enable them from the dashboard when needed.
- Managed install currently supports Linux, macOS, and Windows on `x64` / `arm64`.
- Managed Quick Tunnels default to HTTP/2 transport to avoid noisy QUIC UDP buffer warnings in constrained container environments. Set `CLOUDFLARED_PROTOCOL=quic` or `auto` if you want a different transport.
- Docker images bundle system CA roots and pass them to managed `cloudflared`, which avoids TLS trust failures when the tunnel bootstraps inside the container.
- Set `CLOUDFLARED_BIN=/absolute/path/to/cloudflared` if you want OmniRoute to use an existing binary instead of downloading one.

## Remote OAuth Callback (xAI Grok / X Premium+ and Codex) — SSH Tunnel + --network host

xAI OAuth (the "xAI Grok OAuth (SuperGrok / X Premium+)" provider) and Codex use a **fixed loopback callback port** that the IdP strictly validates:

- xAI: `http://127.0.0.1:56121/callback` (the public client allowlist at xAI requires exactly this)
- Codex: `http://localhost:1455/auth/callback`

On a **remote server** (e.g. ampereserver02) accessed from your laptop browser, the redirect from accounts.x.ai (or OpenAI for Codex) will target `127.0.0.1` on *the laptop*. To make the authentication "reach the server":

1. **Run the container with host networking** so the on-demand callback listener (a Node `http.Server` started at runtime by `/api/oauth/.../start-callback-server`) is visible on the host's loopback:

   ```bash
   # Podman (common on servers)
   podman run -d \
     --name omniroute \
     --restart unless-stopped \
     --network host \
     -v omniroute-data:/app/data:U \
     --userns=keep-id \
     -e JWT_SECRET=... \
     -e API_KEY_SECRET=... \
     -e INITIAL_PASSWORD=... \
     -e REQUIRE_API_KEY=false \
     -e HEAP_PRESSURE_THRESHOLD_MB=850 \
     ghcr.io/suptecgourry/omniroute:latest   # or your built tag; note lowercase (use tr to lower in CI)

   # Docker equivalent (Linux)
   docker run -d \
     --name omniroute \
     --restart unless-stopped \
     --network host \
     -v omniroute-data:/app/data \
     -e ... \
     yourimage:tag
   ```

   - `--network host` is required for the dynamic 56121 (or 1455) listener. Plain `-p 56121:56121` is usually not sufficient in rootless/passt modes because the server is started *after* the container is up.
   - The main UI is still on 20128 (no need to publish it separately with host net).
   - Use `:U` (podman) or correct uid/gid mapping so the node user inside can write to the volume.

2. **From your laptop**, establish a local port forward (keep the ssh session alive):

   ```bash
   ssh -L 56121:127.0.0.1:56121 user@ampereserver02 -N
   # For Codex use 1455 instead of 56121
   ```

3. In the browser on the laptop, open the remote dashboard (`http://ampereserver02:20128` or your host/IP). The UI detects it is not `localhost`/`127.0.0.1` and shows the manual paste flow + a dedicated **"Start listener on server + wait for capture (via tunnel)"** button for xAI/Codex.

4. Click that button (it calls the start-callback-server API on the remote, which spins up the listener inside your container and returns a fresh auth URL + verifier). Finish the xAI login in the tab that opens.

5. Because the ssh -L is active and the container has `--network host`, the post-login redirect from x.ai lands on the remote listener. The server captures the code and the poll loop (or your paste of the full `http://127.0.0.1:56121/callback?code=...`) completes the token exchange.

If you only want the paste flow (no tunnel), the plain "paste the callback URL from your browser address bar" still works after the x.ai redirect (you may see a connection error on the laptop's 127 — that's expected; the URL in the bar contains the `code` you need).

**Important: OmniRoute API key is still required for client calls**

The xAI OAuth only authenticates *upstream* to api.x.ai. To call OmniRoute's `/v1/chat/completions` (or other endpoints) you still need a valid OmniRoute client API key:

- Log into the dashboard with `INITIAL_PASSWORD`.
- Go to "API Keys" (or the Keys tab) and create a new key (you can scope it to specific providers/combos if desired).
- Use that key as the `api_key` / `Authorization: Bearer <omni-key>` when calling your server's `http://...:20128/v1/...` (or the public URL).
- Set `REQUIRE_API_KEY=false` only if you fully trust the network / reverse proxy and want unauthenticated access to the LLM proxy.

Example curl (after creating an OmniRoute key and having an xai-oauth account active via combo or default routing):

```bash
curl http://ampereserver02:20128/v1/chat/completions \
  -H "Authorization: Bearer <your-omniroute-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"grok-4.3","messages":[{"role":"user","content":"hi via xai oauth"}]}'
```

Without a valid OmniRoute API key you will see exactly `{"error":{"message":"Invalid API key"}}` (AUTH_002) even if the upstream xai-oauth connection is perfect.

See also the in-UI hints in the xAI provider card and the OAuth modal.

## Image Tags

| Image                    | Tag      | Size   | Description           |
| ------------------------ | -------- | ------ | --------------------- |
| `diegosouzapw/omniroute` | `latest` | ~250MB | Latest stable release |
| `diegosouzapw/omniroute` | `3.8.0`  | ~250MB | Current version       |

Multi-platform manifest: `linux/amd64` + `linux/arm64` native (Apple Silicon, AWS Graviton, Raspberry Pi). Docker selects the matching architecture automatically; pass `--platform linux/amd64` if you need to force AMD64 emulation on ARM hosts. (Your fork build-fork.yml builds native arm64 on ubuntu-24.04-arm runners for ampereserver02-class hardware.)

## Important Notes

- **SQLite WAL Mode:** `docker stop` should be allowed to finish so OmniRoute can checkpoint the latest changes back into `storage.sqlite`. The bundled Compose files already set a 40s stop grace period. If you run the image directly, keep `--stop-timeout 40`.
- **`DISABLE_SQLITE_AUTO_BACKUP`:** Set to `true` if backups are managed externally.
- **Data Persistence:** Always mount a volume to `/app/data` to persist your database, keys, and configurations across container restarts.
- **Port Configuration:** Override `PORT` environment variable to change the default `20128` port.

## See Also

- [VM Deployment Guide](../ops/VM_DEPLOYMENT_GUIDE.md) — VM + nginx + Cloudflare setup
- [Fly.io Deployment Guide](../ops/FLY_IO_DEPLOYMENT_GUIDE.md) — Deploy to Fly.io
- [Environment Config](../reference/ENVIRONMENT.md) — Complete `.env` reference
