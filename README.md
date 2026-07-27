# OmniArk

**AI Proxy Pool for Multiple Providers** — Load balancing, credit tracking, and unified OpenAI-compatible routing for Codex, Qoder, and BYOK accounts.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.x-000000?logo=bun)](https://bun.sh)

> **OmniArk** is a fork of the original **[priyo000/etteum-pool](https://github.com/priyo000/etteum-pool)** project. This repo re-brands and strips the codebase down to a pure Bun/TypeScript proxy pool — no Python auth bot, no browser automation, no VCC generator, and only the providers we actually use.

---

## ⚡ Quick Start

Prerequisite: [Bun](https://bun.sh) 1.x

```bash
git clone https://github.com/risunCode/OmniArk.git ~/omniark
cd ~/omniark
bun install.ts
```

Then start the server:

```bash
omniark start
```

Open the dashboard at **http://localhost:12800**.

---

## Manual install

```bash
bun install
bun run build          # build dashboard
cp .env.example .env   # edit API_KEY / ENCRYPTION_KEY
bun src/index.ts       # start backend
```

---

## What changed from the original?

Original project: **[priyo000/etteum-pool](https://github.com/priyo000/etteum-pool)**

This fork focuses on keeping the proxy pool core lean:

- **Removed**: Python dependencies, Playwright/Camoufox browser automation, the VCC generator, and the auth-bot orchestration.
- **Removed providers**: Canva, YouMind, CodeBuddy, CodeBuddy China, GitLab Duo.
- **Kept providers**: Codex, Qoder, plus BYOK (bring-your-own-key).
- **Rebrand**: all `etteum` / `Etteum` / `poolprox3` / `aiproxy` references moved to **OmniArk**.

So if you’re looking for the original full-featured version with the auth bot and extra providers, head over to **[priyo000/etteum-pool](https://github.com/priyo000/etteum-pool)**. OmniArk is the trimmed-down, no-browser-fuss variant we run ourselves.

---

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `1930` | Backend / OpenAI-compatible proxy port |
| `DASHBOARD_PORT` | `1931` | Dashboard static-server port |
| `API_KEY` | `pool-proxy-secret-key` | Bearer token for clients and dashboard |
| `DATABASE_PATH` | `./data/omniark.db` | SQLite database location |
| `ENCRYPTION_KEY` | random (installer) | 32-char hex; encrypts saved tokens |

The backend, dashboard, WebSocket endpoint, and OpenAI-compatible proxy are one service on the same `PORT`. There is no separate dashboard process or dashboard port in the deployment image. On Railway, use the public service domain without a port; Railway routes it to the service's runtime `PORT`.

Optional log-body toggles:

| Variable | Default | Purpose |
|----------|---------|---------|
| `OMNIARK_LOG_BODY_ENABLED` | `true` | Capture request/response bodies in logs |
| `OMNIARK_LOG_BODY_FULL` | `true` | Log full bodies instead of truncating |
| `OMNIARK_LOG_BODY_REDACT` | `false` | Redact sensitive fields in bodies |
| `OMNIARK_LOG_BODY_MAX_BYTES` | `65536` | Max body bytes to log |

---

## CLI commands

| Command | Description |
|---------|-------------|
| `omniark start` | Start backend + dashboard (dev) |
| `omniark run` | Alias for `bun src/index.ts` |
| `omniark build` | Build dashboard for production |
| `omniark migrate` | Run database migrations |
| `omniark status` | Check if the server is running |
| `omniark stop` | Stop the background instance |
| `omniark restart` | Stop + start |
| `omniark logs` | Tail the log file |
| `omniark doctor` | Print quick health diagnostics |
| `omniark help` | Show usage |

---

## Supported providers

- `codex`
- `qoder`
- `byok` (bring your own OpenAI-compatible key)

Add accounts through the dashboard at **http://localhost:1931**.

---

## Client integration

The dashboard **Integrations** page can generate config snippets for popular AI coding clients (Codex CLI, Windsurf, Cline, etc.). The proxy exposes a standard OpenAI-compatible `/v1/chat/completions` endpoint.

---

## Credits

- Original project: **[priyo000/etteum-pool](https://github.com/priyo000/etteum-pool)**
- Fork / rebrand: **OmniArk** — `https://github.com/risunCode/OmniArk`

## License

MIT
