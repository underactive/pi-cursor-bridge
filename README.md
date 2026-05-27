# cursor-acp

`cursor-acp` is a Pi extension that exposes Cursor's `cursor-agent` through a local OpenAI-compatible HTTP proxy. When Pi loads the extension, it starts a proxy on `127.0.0.1:32124`, discovers Cursor models, and registers them under the `cursor-acp/...` provider namespace.

## Features

- Registers a `Cursor ACP` provider in Pi.
- Exposes `GET /v1/models` and `POST /v1/chat/completions`.
- Supports streaming and non-streaming chat completions.
- Uses `cursor-agent models --trust` for model discovery, with a built-in fallback list.
- Requires no npm dependencies; the extension uses Node.js built-ins.

## Requirements

- Pi with local extension support.
- Node.js available in the Pi runtime.
- Cursor's `cursor-agent` CLI installed and authenticated.

Authenticate Cursor before using the extension:

```sh
cursor-agent login
```

## Installation

Place `cursor-acp.js` where Pi loads local extensions from, then restart Pi or run:

```text
/reload
```

After reload, open:

```text
/model
```

Select a model named like `cursor-acp/auto`, `cursor-acp/composer-2`, or another discovered Cursor model.

## Local Proxy Usage

The extension also exposes an OpenAI-compatible local endpoint:

```text
http://127.0.0.1:32124/v1
```

List models:

```sh
curl http://127.0.0.1:32124/v1/models
```

Send a non-streaming chat request:

```sh
curl http://127.0.0.1:32124/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"cursor-acp/auto","messages":[{"role":"user","content":"Say hello"}]}'
```

## Configuration

Set these environment variables before Pi loads the extension:

- `CURSOR_ACP_CURSOR_AGENT_PATH` - absolute path to a custom `cursor-agent` binary.
- `CURSOR_ACP_DISABLE=1` - disables extension startup.

The proxy currently binds to `127.0.0.1:32124`.

## Development

Validate syntax:

```sh
node --check cursor-acp.js
```

Check Cursor CLI access:

```sh
cursor-agent models --trust
```

Smoke-check the running proxy:

```sh
curl http://127.0.0.1:32124/health
```

There is no automated test suite yet. For changes to response formatting or streaming behavior, manually test both streaming and non-streaming chat completion requests.

## Troubleshooting

- `Authentication failed` - run `cursor-agent login`.
- `Rate limited` or `Quota exceeded` - check the active Cursor account and subscription limits.
- `Model not found` - run `cursor-agent models --trust` and select one of the returned model IDs.
- No models in Pi - run `/reload`, then check `http://127.0.0.1:32124/v1/models`.
