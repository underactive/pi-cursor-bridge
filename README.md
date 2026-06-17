# pi-cursor-agent

`pi-cursor-agent` is a Pi extension that registers Cursor models under the `cursor-agent/...` provider namespace. It prefers the **`@cursor/sdk`** backend when installed and authenticated, and falls back to a local **OpenAI-compatible HTTP proxy** that wraps the `cursor-agent` CLI.

When Pi loads the extension, it also starts (or attaches to) a loopback proxy on `127.0.0.1:32124` for non-Pi OpenAI clients and for CLI fallback mode.

> **Note on naming.** Despite the historical `cursor-acp` name in earlier commits, this extension does **not** speak the [Agent Client Protocol](https://github.com/agentclientprotocol). It is an OpenAI Chat Completions–compatible proxy and Pi provider around Cursor's `cursor-agent` CLI and `@cursor/sdk`.

## Features

- Registers a `Cursor Agent` provider in Pi.
- **Dual backend:** `@cursor/sdk` (preferred) or CLI/proxy fallback.
- Exposes `GET /v1/models`, `POST /v1/chat/completions`, and `GET /health` on the local proxy.
- Also accepts `/models` and `/chat/completions` without the `/v1` prefix.
- Supports streaming and non-streaming chat completions.
- Discovers models via SDK catalog or `cursor-agent models --trust`, with disk and in-memory caching.
- Supports Pi **`reasoning_effort`** / thinking levels via per-model `thinkingLevelMap`.
- Registers context-window variants in the model picker (e.g. `cursor-agent/gpt-5.5@1m`).
- Image input on vision-capable models (SDK backend).
- Multi-turn sessions via `X-Session-Id` header (CLI/proxy path).
- Pi commands: `/cursor-status`, `/cursor-refresh-models`.
- Locates `cursor-agent` automatically (see [Configuration](#configuration)).

On the CLI/proxy path, chat completions run `cursor-agent` with `--trust` and `--force` so tool calls are auto-approved. That is intentional for a headless proxy; the server binds to loopback only (`127.0.0.1:32124`).

## Requirements

- Pi with local extension support.
- Node.js 18+ available in the Pi runtime.
- A Cursor API key (recommended) or `cursor-agent` CLI login.
- **`@cursor/sdk`** (optional dependency, installed with the npm package) for the preferred SDK backend.
- **`cursor-agent` CLI** for CLI/proxy fallback and for the local HTTP proxy.

## Authentication

The extension resolves credentials in this order:

1. **`CURSOR_API_KEY`** environment variable
2. **Pi AuthStorage** — run **`/login`** in Pi and select the `cursor-agent` provider (stored in `~/.pi/agent/auth.json`)
3. **`cursor-agent login`** — CLI config at `~/.cursor/cli-config.json`

The **SDK backend requires** a Pi-stored or env API key (`/login` or `CURSOR_API_KEY`). CLI login alone is not enough for SDK mode.

For CLI spawns and SDK calls, the extension uses the resolved key automatically. After changing auth mid-session, run **`/cursor-refresh-models`** or `/reload`.

## Installation

### Via npm (recommended)

```sh
pi install npm:pi-cursor-agent
```

Pi reads the `pi.extensions` field in `package.json` and auto-loads `extensions/cursor-agent.js`. The package includes `@cursor/sdk` as an optional dependency.

### Local clone

Clone this repo and either:

- Symlink the extension into a Pi extension directory:

  ```sh
  ln -s "$PWD/extensions/cursor-agent.js" ~/.pi/agent/extensions/cursor-agent.js
  ```

- Or symlink the whole `extensions/` directory contents into a project-local Pi dir (`.pi/extensions/`).

Install dependencies so the SDK backend is available:

```sh
npm install
```

Then restart Pi or run `/reload`.

Pi auto-discovers extensions from:

- `~/.pi/agent/extensions/` — global (all projects)
- `.pi/extensions/` — project-local (per-repo)
- Any installed npm package whose `package.json` declares `pi.extensions`

After reload, open:

```text
/model
```

Select a model like `cursor-agent/auto`, `cursor-agent/composer-2.5`, or another discovered Cursor model.

Check which backend is active:

```text
/cursor-status
```

## Backends

| Backend | When used | Pi routing |
| --- | --- | --- |
| **`@cursor/sdk`** | SDK installed, API key resolved, not disabled | Direct `streamSimple` — no HTTP, clean model IDs |
| **CLI/proxy** | SDK unavailable, disabled, or no API key | OpenAI API to `127.0.0.1:32124` → `cursor-agent` subprocess |

The proxy server starts (or attaches to a peer instance) regardless of which backend Pi uses, so curl and other OpenAI clients can always hit `http://127.0.0.1:32124/v1`.

Set `PI_CURSOR_SDK_DISABLE=1` to force CLI/proxy mode even when `@cursor/sdk` is installed.

## Pi commands

- **`/cursor-status`** — active backend, model count/source, auth source, proxy ownership, Node and SDK versions.
- **`/cursor-refresh-models`** — clears caches and re-discovers models (picks up auth changes without restart).

## Model discovery and caching

Discovery order for the CLI/proxy path:

1. Disk cache at `~/.pi/agent/cursor-agent-model-cache.json` (24-hour TTL by default) — on first call per Pi session
2. In-memory cache (60 seconds between CLI refetches within a session)
3. Live `cursor-agent models --trust` fetch
4. Stale disk cache (if CLI fetch fails)
5. Built-in `FALLBACK_MODELS` list

The SDK path discovers models directly from the SDK catalog on startup.

Configure caching:

- `PI_CURSOR_MODEL_CACHE_TTL_MS` — override disk cache TTL (default: 86400000 ms / 24 h)
- `PI_CURSOR_DISABLE_MODEL_CACHE=1` — disable disk cache reads and writes

## Local proxy usage

The extension exposes an OpenAI-compatible local endpoint:

```text
http://127.0.0.1:32124/v1
```

List models:

```sh
curl http://127.0.0.1:32124/v1/models
```

Health check:

```sh
curl http://127.0.0.1:32124/health
```

Send a non-streaming chat request:

```sh
curl http://127.0.0.1:32124/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"cursor-agent/auto","messages":[{"role":"user","content":"Say hello"}]}'
```

For multi-turn CLI/proxy sessions, pass an `X-Session-Id` header with a stable UUID.

## Configuration

Environment variables (set before Pi loads the extension):

| Variable | Purpose |
| --- | --- |
| `PI_CURSOR_AGENT_DISABLE=1` | Disable extension startup entirely |
| `PI_CURSOR_SDK_DISABLE=1` | Force CLI/proxy backend instead of `@cursor/sdk` |
| `PI_CURSOR_AGENT_PATH` | Absolute path to a custom `cursor-agent` binary |
| `CURSOR_API_KEY` | Cursor API key for SDK and CLI spawns |
| `PI_CURSOR_DISABLE_MODEL_CACHE=1` | Disable on-disk model cache |
| `PI_CURSOR_MODEL_CACHE_TTL_MS` | Disk cache TTL in milliseconds (default: 24 h) |
| `PI_CURSOR_SESSION_TIMEOUT_MS` | CLI/proxy session idle timeout (default: 300000 ms / 5 min) |

If `PI_CURSOR_AGENT_PATH` is unset, the extension searches for `cursor-agent` in order:

1. `~/.local/bin/cursor-agent`
2. `~/.cursor/bin/cursor-agent`
3. `/usr/local/bin/cursor-agent`
4. `/opt/homebrew/bin/cursor-agent`
5. `cursor-agent` on `PATH`

The proxy binds to `127.0.0.1:32124`.

## Development

See [AGENTS.md](AGENTS.md) for repository conventions and contributor notes.

Validate syntax:

```sh
node --check extensions/cursor-agent.js
```

Run unit tests:

```sh
npm test
```

Check Cursor CLI access:

```sh
cursor-agent models --trust
```

Smoke-check the running proxy:

```sh
curl http://127.0.0.1:32124/health
curl http://127.0.0.1:32124/v1/models
```

In Pi, run `/reload` after editing the extension. For streaming or response formatting changes, test both streaming and non-streaming `/v1/chat/completions` requests.

## Troubleshooting

- **`/cursor-status` shows SDK inactive** — run `/login` with a Cursor API key, or set `CURSOR_API_KEY`. Ensure `npm install` pulled in `@cursor/sdk`.
- **`Authentication failed`** — run `/login` or `cursor-agent login`, or set `CURSOR_API_KEY`.
- **`Rate limited` or `Quota exceeded`** — check the active Cursor account and subscription limits.
- **`Model not found`** — run `/cursor-refresh-models` or `cursor-agent models --trust` and pick a listed model ID.
- **No models in Pi** — run `/reload`, then `/cursor-status`. Check `http://127.0.0.1:32124/v1/models`.
- **Blank replies on thinking models (CLI path)** — ensure `reasoning_effort` is set appropriately; the proxy resolves thinking variants from the request body.
- **Force CLI mode for debugging** — set `PI_CURSOR_SDK_DISABLE=1` and `/reload`.
