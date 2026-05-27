# Repository Guidelines

## Project Structure & Module Organization

This repository contains a single Pi extension module:

- `cursor-acp.js` - starts an OpenAI-compatible local HTTP proxy for Cursor's `cursor-agent`, registers the `cursor-acp` provider with Pi, and exposes `/v1/models`, `/v1/chat/completions`, and `/health`.

There are no checked-in tests, assets, package manifests, or build artifacts. Keep new code close to the existing single-module layout unless the file becomes difficult to maintain; split helpers only when there is a clear boundary such as request parsing, Cursor CLI integration, or Pi provider registration.

## Build, Test, and Development Commands

- `node --check cursor-acp.js` - validates JavaScript syntax without running the extension.
- `cursor-agent login` - authenticates the Cursor CLI before using the proxy.
- `cursor-agent models --trust` - confirms the CLI can list models used by the provider.
- In Pi, run `/reload` after editing the extension so Pi re-registers the provider.
- `curl http://127.0.0.1:32124/health` - smoke-checks the local proxy after Pi loads the extension.
- `curl http://127.0.0.1:32124/v1/models` - verifies model discovery and fallback behavior.

## Coding Style & Naming Conventions

Use modern JavaScript ES modules. Match the current style: two-space indentation, semicolons, double quotes, `const` by default, and `camelCase` for functions and variables. Constants such as `PORT`, `HOST`, and `FALLBACK_MODELS` use uppercase names. Prefer small pure helpers for parsing, normalization, and formatting, and keep HTTP response shapes OpenAI-compatible.

## Testing Guidelines

No automated test framework is currently configured. For every change, run `node --check cursor-acp.js` and perform a Pi reload smoke test. When touching streaming or response formatting, test both streaming and non-streaming `/v1/chat/completions` requests because the code paths are separate. If you add tests later, place them under `test/` and name files after the behavior, for example `test/normalize-model.test.js`.

## Commit & Pull Request Guidelines

This workspace does not include Git history, so use concise imperative commit messages such as `Handle cursor-agent spawn failures`. Pull requests should describe the behavior change, list manual verification commands, and call out any effects on environment variables, ports, or OpenAI API compatibility. Include screenshots only when Pi UI behavior changes.

## Security & Configuration Tips

Do not commit credentials or local Cursor paths. Use `CURSOR_ACP_CURSOR_AGENT_PATH` for a custom CLI location and `CURSOR_ACP_DISABLE=1` to disable startup during troubleshooting. The proxy binds to `127.0.0.1:32124`; keep it local unless there is a deliberate security review.
