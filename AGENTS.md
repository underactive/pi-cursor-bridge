# Repository Guidelines

## Project Structure & Module Organization

This repository is a publishable Pi extension package:

- `extensions/cursor-bridge.js` — main extension: SDK backend (preferred), CLI/proxy fallback, local HTTP server on `127.0.0.1:32124`, model discovery/caching, Pi provider registration, and `/cursor-status` / `/cursor-refresh-models` commands.
- `lib/cursor-helpers.js` — pure, dependency-free helpers for SDK image collection, error sanitization, and rejection detection. Lives outside `extensions/` so Pi does not auto-discover it as a separate extension.
- `test/*.test.js` — unit tests for `lib/cursor-helpers.js` (run via `npm test` / `node --test`).
- `package.json` — declares `pi.extensions: ["./extensions"]` so Pi auto-discovers the module when installed via npm. Lists `@cursor/sdk` as an optional dependency.
- `LICENSE` — MIT.
- `README.md` / `AGENTS.md` — user docs and contributor notes.

Keep new code close to the existing layout unless `extensions/cursor-bridge.js` becomes difficult to maintain. Split helpers into `lib/` when they are pure and unit-testable; keep Pi entry points under `extensions/` for auto-discovery.

Despite the historical `cursor-acp` name in early commits, this extension does **not** speak the Agent Client Protocol. Pi chat goes through `@cursor/sdk` (preferred) or an OpenAI Chat Completions–compatible HTTP proxy in front of the `cursor-agent` CLI.

## Build, Test, and Development Commands

- `node --check extensions/cursor-bridge.js` — validates JavaScript syntax without running the extension.
- `npm test` — runs unit tests under `test/` (`node --test`).
- `/login` in Pi (cursor-bridge provider) or `CURSOR_API_KEY` — authenticates the SDK backend.
- `cursor-agent login` — authenticates the CLI for proxy fallback.
- `cursor-agent models --trust` — confirms the CLI can list models used by the proxy path.
- In Pi, run `/reload` after editing the extension so Pi re-registers the provider.
- `/cursor-status` — shows active backend (SDK vs CLI/proxy), auth source, and model count.
- `curl http://127.0.0.1:32124/health` — smoke-checks the local proxy after Pi loads the extension.
- `curl http://127.0.0.1:32124/v1/models` — verifies model discovery and fallback behavior.

## Coding Style & Naming Conventions

Use modern JavaScript ES modules. Match the current style: two-space indentation, semicolons, double quotes, `const` by default, and `camelCase` for functions and variables. Constants such as `PORT`, `HOST`, and `FALLBACK_MODELS` use uppercase names. Prefer small pure helpers for parsing, normalization, and formatting, and keep HTTP response shapes OpenAI-compatible.

New `PI_CURSOR_*` env vars follow the existing pattern: default-off boolean toggles use `=== "1"` checks; default-on toggles are opt-out via `!== "0"` (e.g. `PI_CURSOR_STRIP_SYSTEM_PROMPT`); multi-word names use snake_case (e.g. `PI_CURSOR_MODEL_CACHE_TTL_MS`).

## Testing Guidelines

Unit tests cover pure helpers in `lib/cursor-helpers.js`. For every change:

1. Run `node --check extensions/cursor-bridge.js`.
2. Run `npm test`.
3. Perform a Pi `/reload` smoke test and check `/cursor-status`.

When touching streaming or response formatting, test both streaming and non-streaming `/v1/chat/completions` requests because the code paths are separate. When changing SDK helpers, add or update tests under `test/` named after the behavior (e.g. `test/sanitize-sdk-error.test.js`).

## Commit & Pull Request Guidelines

Use concise imperative commit messages such as `Handle cursor-bridge spawn failures`. Pull requests should describe the behavior change, list manual verification commands, and call out any effects on environment variables, ports, backend selection (SDK vs CLI), or OpenAI API compatibility. Include screenshots only when Pi UI behavior changes.

## Security & Configuration Tips

Do not commit credentials or local Cursor paths. Use `PI_CURSOR_AGENT_PATH` for a custom CLI location, `PI_CURSOR_SDK_DISABLE=1` to force CLI/proxy mode, and `PI_CURSOR_AGENT_DISABLE=1` to disable startup during troubleshooting. The proxy binds to `127.0.0.1:32124`; keep it local unless there is a deliberate security review.
