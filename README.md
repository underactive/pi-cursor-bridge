# pi-cursor-agent

`pi-cursor-agent` is a Pi extension that exposes Cursor's `cursor-agent` through a local OpenAI-compatible HTTP proxy. When Pi loads the extension, it starts a proxy on `127.0.0.1:32124`, discovers Cursor models, and registers them under the `cursor-agent/...` provider namespace.

> **Note on naming.** Despite the historical `cursor-acp` name in earlier commits, this extension does **not** speak the [Agent Client Protocol](https://github.com/agentclientprotocol). It is an OpenAI Chat Completions–compatible HTTP proxy that wraps the `cursor-agent` CLI.

## Features

- Registers a `Cursor Agent` provider in Pi.
- Exposes `GET /v1/models`, `POST /v1/chat/completions`, and `GET /health`.
- Also accepts `/models` and `/chat/completions` without the `/v1` prefix.
- Supports streaming and non-streaming chat completions.
- Discovers models via `cursor-agent models --trust`, caches results for 60 seconds, and uses a built-in fallback list only when discovery fails and no cache exists yet.
- Locates `cursor-agent` automatically (see [Configuration](#configuration)).
- Requires no npm dependencies; the extension uses Node.js built-ins.

Chat completions run `cursor-agent` with `--trust` and `--force` so tool calls (shell, file ops, etc.) are auto-approved. That is intentional for a headless proxy; the server binds to loopback only (`127.0.0.1:32124`).

## Requirements

- Pi with local extension support.
- Node.js available in the Pi runtime.
- Cursor's `cursor-agent` CLI installed and authenticated.

Authenticate Cursor before using the extension:

```sh
cursor-agent login
```

## Installation

### Via npm (recommended)

```sh
pi install npm:pi-cursor-agent
```

Pi reads the `pi.extensions` field in `package.json` and auto-loads `extensions/cursor-agent.js`.

### Local clone

Clone this repo and either:

- Symlink the file into a Pi extension directory:

  ```sh
  ln -s "$PWD/extensions/cursor-agent.js" ~/.pi/agent/extensions/cursor-agent.js
  ```

- Or symlink the whole `extensions/` directory contents into a project-local Pi dir (`.pi/extensions/`).

Then restart Pi or run `/reload`.

Pi auto-discovers extensions from:

- `~/.pi/agent/extensions/` — global (all projects)
- `.pi/extensions/` — project-local (per-repo)
- Any installed npm package whose `package.json` declares `pi.extensions`

After reload, open:

```text
/model
```

Select a model named like `cursor-agent/auto`, `cursor-agent/composer-2`, or another discovered Cursor model.

## Local Proxy Usage

The extension also exposes an OpenAI-compatible local endpoint:

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

## Configuration

Environment variables (set before Pi loads the extension):

- `PI_CURSOR_AGENT_PATH` — absolute path to a custom `cursor-agent` binary (overrides auto-discovery).
- `PI_CURSOR_AGENT_DISABLE=1` — disables extension startup.

If `PI_CURSOR_AGENT_PATH` is unset, the extension searches in order:

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

Check Cursor CLI access:

```sh
cursor-agent models --trust
```

Smoke-check the running proxy:

```sh
curl http://127.0.0.1:32124/health
curl http://127.0.0.1:32124/v1/models
```

There is no automated test suite yet. For changes to response formatting or streaming behavior, manually test both streaming and non-streaming chat completion requests.

## Troubleshooting

- `Authentication failed` — run `cursor-agent login`.
- `Rate limited` or `Quota exceeded` — check the active Cursor account and subscription limits.
- `Model not found` — run `cursor-agent models --trust` and select one of the returned model IDs.
- No models in Pi — run `/reload`, then check `http://127.0.0.1:32124/v1/models`.
