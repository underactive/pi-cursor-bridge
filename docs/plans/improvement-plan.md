# Phased Improvement Plan: pi-cursor-agent

> **Context.** Derived from a comparison with [pi-cursor-sdk](https://github.com/fitchmultz/pi-cursor-sdk), which solves the same problem (Cursor models in Pi) but via `@cursor/sdk` library integration instead of an OpenAI HTTP proxy wrapping `cursor-agent` CLI. Our extension's strengths are its generic proxy, zero dependencies, and port sharing. The plan below closes UX gaps while preserving those strengths.

---

## Phase 1 — Thinking/reasoning mapping ✅

**Status:** Complete (2026-06-15) — implemented via #plan in `.rpiv/artifacts/plans/2026-06-15_09-01-14_phase1-thinking-reasoning-mapping.md`, validated in `.rpiv/artifacts/validation/2026-06-15_09-52-08_phase-1-thinking-reasoning-mapping-for-pi-cursor-agent.md`.

**Goal.** Let Pi users control Cursor model reasoning/effort via `shift+tab`, `--thinking`, and `:<thinking>` model suffixes. Currently `supportsReasoningEffort: false` is hardcoded.

**Changes.**

1. Define a per-model `reasoning` flag and `thinkingLevelMap` by inspecting `cursor-agent` capabilities output (or by maintaining a known model-to-schema table alongside the fallback list).
2. Set `compat.supportsReasoningEffort: true` in the provider config.
3. Set `compat.supportsDeveloperRole: true` — the `cursor-agent` CLI handles system messages fine, and Pi uses `developer` role for models that declare support.
4. After the model list is fetched, build `thinkingLevelMap` entries for models that advertise reasoning/effort controls.

**Success criteria.**

- `pi --list-models cursor-agent` shows some models with `thinking=yes`.
- `shift+tab` in an interactive session with a reasoning-capable model cycles through thinking levels.
- `--thinking medium` on the CLI maps to `cursor-agent`'s corresponding reasoning param.
- `:medium` model suffix works.

**Files touched.** `extensions/cursor-agent.js` — the `buildModelConfigs` function and `registerCursorProvider` call.

---

## Phase 2 — Context window per model ✅

**Status:** Complete (2026-06-15) — implemented via #plan in `.rpiv/artifacts/plans/2026-06-15_10-14-37_phase-2-context-window-per-model.md`, validated in `.rpiv/artifacts/validation/2026-06-15_13-20-51_phase-2-context-window-per-model.md`.

**Goal.** Replace the flat `contextWindow: 200000` with accurate values per model so Pi's context display, overflow checking, and compaction are correct.

**Changes.**

1. Define a `MODEL_CONTEXT_WINDOWS` map keyed by Cursor model ID → context window tokens (e.g. `"claude-opus-4-7-medium"` → `200000`, `"gpt-5.5"` → `1000000`).
2. Add a variant-suffix parser for models that expose multiple context windows (e.g. `gpt-5.5@1m`, `gpt-5.5@272k`). When the CLI returns a single ID, check the map for known variants.
3. In `buildModelConfigs`, look up `contextWindow` from the map instead of using the hardcoded constant.
4. When a model is known to have multiple context options, register separate pi model configs per variant (e.g. `cursor-agent/gpt-5.5@1m` and `cursor-agent/gpt-5.5@272k`).

**Success criteria.**

- `pi --list-models cursor-agent` shows varying `context` column values.
- Selecting a smaller-context variant shows accurate context in Pi's footer.
- Selecting a larger-context variant doesn't trigger false compaction warnings.

**Files touched.** `extensions/cursor-agent.js` — new `MODEL_CONTEXT_WINDOWS` map, variant parsing in `buildModelConfigs`, multi-entry logic.

---

## Phase 3 — Disk model cache ✅

**Status:** Complete (2026-06-15) — implemented via #plan in `.rpiv/artifacts/plans/2026-06-15_14-02-01_phase-3-disk-model-cache.md`, validated in `.rpiv/artifacts/validation/2026-06-15_15-08-50_phase-3-disk-model-cache.md`.

**Goal.** Avoid spawning `cursor-agent models` on every Pi startup. Cache the model list to disk keyed by a hash of the Cursor auth state, with a configurable TTL.

**Changes.**

1. Pick a cache path under `~/.pi/agent/cursor-agent-model-cache.json`.
2. On `getModels`, check disk cache first. If valid (within TTL), return it instead of spawning the CLI.
3. On successful CLI fetch, write the result to the cache file.
4. Honor `PI_CURSOR_MODEL_CACHE_TTL_MS` env var (default `86400000` — 24h) and `PI_CURSOR_DISABLE_MODEL_CACHE=1` to bypass.
5. Keep the in-memory cache as a hot-path front; disk cache is the cold-start fallback.
6. Peer-attach path falls back to disk cache when `fetchPeerModels()` fails.
7. Startup log shows cache origin: disk, cli-cached, stale-disk, or fallback.

**Success criteria.**

- Cold Pi startup: spawns `cursor-agent models`, writes cache.
- Second startup within TTL: reads cache, no subprocess.
- `PI_CURSOR_DISABLE_MODEL_CACHE=1`: ignores disk cache every time.
- Warm startups complete in <100ms for model discovery.

**Files touched.** `extensions/cursor-agent.js` — new cache infrastructure (`loadModelCache`, `saveModelCache`, `getAuthHash`, etc.), modified `getModels()` with disk read/write, peer-attach fallback, startup logging.

---

## Phase 4 — `/cursor-refresh-models` command ✅

**Status:** Complete (2026-06-15) — implemented alongside session management (Phase 4½ below). Registered early in the startup sequence so the command is available on all proxy paths (new, peer-attach, disabled). Handler clears disk cache, re-fetches from CLI, rebuilds configs, and re-registers the provider with a notification.

**Goal.** Let users refresh the model catalog without restarting Pi (equivalent to pi-cursor-sdk's `/cursor-refresh-models`).

**Changes.**

1. Register a `cursor-refresh-models` command via `pi.registerCommand`.
2. Handler clears the model cache, re-runs `fetchCursorModels()`, rebuilds model configs, and calls `pi.registerProvider(PROVIDER_ID, ...)` again with the fresh list.
3. Show a notification (`ctx.ui.notify`) in TUI mode, or log in print mode, reporting the new model count.

**Success criteria.**

- `/cursor-refresh-models` in an interactive session re-discovers models and updates `/model` list.
- No restart or `/reload` needed.
- Previous model selection persists if the model still exists.

**Files touched.** `extensions/cursor-agent.js` — new `registerCommand` call near the `scheduleStartupLog` / registration section.

---

## Phase 4½ — Session management & multi-turn support

**Status:** Complete (2026-06-15) — implemented alongside `/cursor-refresh-models`. Spawns persistent cursor-agent subprocesses per session, routes via `X-Session-Id` header, accumulates token usage, and releases on idle timeout.

**Goal.** Enable multi-turn conversations through cursor-agent without re-spawning the CLI on every turn. Accumulate usage across turns. Kill idle subprocesses after a configurable timeout.

**Changes.**

1. New `extensions/cursor-session.js` module with `CursorSession`, `SessionManager`, `buildSessionPrompt` exports.
2. `activeSessionManager` initialized in `startProxyServer()`.
3. Session routing in `handleChatCompletions`: `X-Session-Id` header → `getOrCreateSession()`.
4. ~~Session-aware prompt construction: first turn sends full history, subsequent turns send only unseen messages.~~ **Correction (improvement-refactor.md):** not implemented and not needed — `handleChatCompletions` always rebuilds the prompt from the full request body via `buildPromptFromMessages` (the correct OpenAI convention, since clients send full history every turn). The `buildSessionPrompt` helper this implied is dead code; see refactor item H3.
5. Token usage accumulated across turns via `session.accumulateUsage()`.
6. `/cursor-refresh-models` command registered early — available on all startup paths.
7. Cache format version bumped to 2 to persist `contextWindow`/`maxTokens` fields.
8. `parseContextFromDisplayName()` — extracts context window from CLI display names (e.g. "1M" → 1_000_000).
9. Tool call SSE delta forwarding in streaming mode.
10. Session idle timeout with release timer (default 5 min, configurable via `PI_CURSOR_SESSION_TIMEOUT_MS`).

**Files touched.** `extensions/cursor-agent.js` — session manager import, session routing, persistent subprocess handling, tool call recording, usage accumulation, idle timeout, display name parsing, `/cursor-refresh-models` command. New `extensions/cursor-session.js` — `CursorSession`, `SessionManager`, `buildSessionPrompt`.

---

## Phase 5 — Pi-native auth flow ✅

**Status:** Complete (2026-06-16) — implemented via #plan in `.rpiv/artifacts/plans/2026-06-16_08-54-12_phase5-pi-native-auth-flow.md`, validated in `.rpiv/artifacts/validation/2026-06-16_09-30-27_phase5-pi-native-auth-flow.md` (verdict: pass). Committed in `397d32f`. `extractAuthKey()` reads the Pi-stored key from `~/.pi/agent/auth.json` at startup, both CLI spawns inject `CURSOR_API_KEY`, and `getAuthHash()` gains a `pikey:`-prefixed branch so changing the key via `/login` invalidates the model cache. Original change #1 (registering the `/login` auth provider) needed no code — Pi's generic API-key auth flow already surfaces the `cursor-agent` provider; the SDK backend also resolves the same key (`resolveSdkApiKey`).

**Goal.** Replace the external `cursor-agent login` requirement with pi-native auth via `/login` → "Use an API key" → "Cursor", so users set their key once and Pi remembers it.

**Changes.**

1. Register Cursor as an auth provider in pi's auth system so `/login` surfaces it.
2. At startup, attempt to resolve the API key: `--api-key` → stored key from `AuthStorage` → `CURSOR_API_KEY` env var.
3. When a key is present and valid, pass it to the `cursor-agent` CLI as `CURSOR_API_KEY` env or via `--api-key` CLI arg (the newer `cursor-agent` versions accept it).
4. Keep the existing `cursor-agent login` path as a fallback when no key is resolved, so existing users aren't broken.

**Success criteria.**

- `/login` → select "Use an API key" → select "Cursor" → paste key.
- Subsequent startups use the stored key; no `cursor-agent login` needed.
- `cursor-agent models` and `cursor-agent --print` work with the API key passed through.

**Files touched.** `extensions/cursor-agent.js` — auth resolution helper, modified `cursorAgentPath()` invocation to pass the key. May need a small helper module `extensions/cursor-auth.js` to keep the main file manageable.

---

## Phase 6 — Image input support ✅

**Status:** Complete (2026-06-16) — implemented via #plan in `~/.claude/plans/virtual-wondering-eich.md`, validated end-to-end in Pi (image round-trip + multi-turn recall). Landed on the **SDK backend only**: the `cursor-agent` CLI exposes no image flag (its `--help` carries only a text prompt + `--print`/`--output-format`/`--model`), so the proxy/CLI path stays text-only — which also stops Pi from routing images down a dead path, since Pi gates its uploader on `input` containing `"image"`. The SDK's `agent.send({ text, images })` accepts `SDKImage` (`{data, mimeType}`), and Pi's native `ImageContent` (`{type:"image", data, mimeType}`) maps onto it 1:1. New `collectSdkImages()` gathers user-turn images across the full history (the SDK backend uses a fresh agent per turn, so earlier images must be re-sent), `startBridgeRun` attaches them to the single `agent.send`, and `buildSdkModelConfigs` advertises `input: ["text","image"]` for models in a curated `VISION_CAPABLE_SDK_MODELS` set. The SDK catalog has no vision flag, so capability is declared, not detected; the set was reconciled against real discovered SDK ids (`claude-opus-4-6`, not the CLI's `claude-4.6-opus`) via `pi --list-models cursor-agent`. `/cursor-refresh-models` re-applies it for free.

**Goal.** Accept image parts in `/v1/chat/completions` messages and forward them to the `cursor-agent` CLI so Cursor models can see images.

**Changes.**

1. In `buildPromptFromMessages`, when processing an array-content message, include image parts (by reference or as data URIs, depending on what `cursor-agent --print` supports).
2. Advertise `input: ["text", "image"]` in model configs.
3. Update the streaming handler to emit image content blocks if the CLI returns them.

**Success criteria.**

- A request with `{ type: "image_url", image_url: { url: "data:image/..." } }` is forwarded.
- Pi's image upload in interactive mode triggers image-capable model behavior.
- No regression for text-only requests.

**Files touched.** `extensions/cursor-agent.js` — `buildPromptFromMessages` image handling, `buildModelConfigs` input type.

---

## Phase 7 (stretch) — Adopt `@cursor/sdk` as an optional backend

**Status:** v1 complete & VERIFIED IN PI (2026-06-16). Direct text+thinking streaming path, validated both in isolation (Node 24 harness) AND end-to-end through a real `pi -p` run: `cursor-agent/claude-opus-4-6@1m` — the model that previously gave NO reply — now answers reliably (`Registered 38 models with Pi via @cursor/sdk backend`). The CLI bakes effort into model IDs, forcing a lossy family-collapse/re-expand that emits invalid bare model names when a tier is missing (e.g. `claude-4.6-opus` with no `medium` tier → "Cannot use this model" → no reply). The SDK returns clean base IDs (`claude-opus-4-6`) with structured `parameters` (thinking/context/effort/fast), so effort is a `ModelSelection.params` entry and a missing tier is simply omitted — the bug class cannot occur.

**Inlined, not a separate module.** Pi loads each extension as a single symlinked `.js` file via jiti, resolving relative imports against the symlink dir — so a sibling `cursor-sdk-backend.js` is unreachable (and would be mis-loaded as its own extension). The backend is therefore inlined into `cursor-agent.js`, matching how `cursor-session.js` was folded in.

**Ripgrep.** The SDK's workspace ignore-scan shells out to `rg` and auto-locates it relative to `process.argv[1]` — which under jiti is Pi's CLI, not us — so it failed and leaked an async rejection on cold start. Fixed by resolving the binary from `@cursor/sdk-<platform>-<arch>/bin/rg` and setting `CURSOR_RIPGREP_PATH`. A scoped `unhandledRejection` guard swallows any remaining SDK-internal leaks (reload-safe, only `@cursor/sdk`-stack rejections).

**Dev-setup requirement (symlinked extensions).** When the extension is symlinked into `~/.pi/agent/extensions/` (dev install), jiti resolves bare imports like `@cursor/sdk` from the symlink dir, NOT the repo — so `@cursor/sdk` must be reachable there. Fix: `ln -s <repo>/node_modules ~/.pi/agent/extensions/node_modules` (after `npm install @cursor/sdk` in the repo). For a normally-installed package this is automatic (deps live in the package's own `node_modules`). Without it the backend silently falls back to the CLI/proxy path — no error, just no SDK.

**Goal.** Offer a second backend path that uses `@cursor/sdk` directly for Pi-native provider sessions, while the HTTP proxy path remains for non-Pi clients.

**Changes (as implemented).**

1. Added `@cursor/sdk` as an `optionalDependency` and `@earendil-works/pi-ai` as a `peerDependency` (needed for `createAssistantMessageEventStream`).
2. Created `extensions/cursor-sdk-backend.js` implementing `streamSimple` (`streamCursorSdk`) via `Cursor.models.list()` + `Agent.create()` + `agent.send({onDelta})` + `run.wait()`.
3. At startup `tryRegisterSdkProvider()` registers the provider with `api: "cursor-sdk"` + `streamSimple` when the SDK imports AND an API key is resolved; the `session_start` handler threads `cwd` into the backend (Pi does not pass cwd to `streamSimple`).
4. Falls back to the CLI/proxy `openai-completions` provider when the SDK is unavailable/keyless/errors. The HTTP proxy keeps running for non-Pi clients. `PI_CURSOR_SDK_DISABLE=1` forces the CLI path.

**Deviations from the original sketch (intentional).**

- Registered under the **same** provider id (`cursor-agent`) rather than a new `cursor` provider, so the model picker doesn't show duplicate Cursor entries. The SDK backend *replaces* the Pi-facing registration; the proxy still serves external OpenAI clients.
- Use **real** `turn-ended` token usage instead of the sibling's char-based estimate (the SDK reports it).
- **Runtime:** the SDK uses `@connectrpc/connect-node` + a native binary. Verified working on Node 24 AND Node 26 (pi runs under `#!/usr/bin/env node`, i.e. whatever node is on PATH). Transient transport `NetworkError`s are possible; any discovery failure falls through to the CLI path, so it degrades gracefully. (An early `NetworkError` was a one-off network blip, not a node-version issue.)

**Pi→Cursor tool bridge — DONE & verified in Pi (2026-06-16).** Pi's active tools (`context.tools`) are exposed to the Cursor agent as in-process SDK `customTools` named `pi_<tool>`, with a steering preamble so the model prefers them. When the agent calls one, a **cross-turn live run** keeps the single `agent.send()` alive across `streamSimple` calls: the bridge emits the Pi `toolCall` + `done(reason:"toolUse")` to end the turn, Pi executes the tool through its own pipeline (approval/permissions/rendering), and the next `streamSimple` resumes the run by resolving the pending `execute()` Promise with the `ToolResultMessage`. Verified: `claude-opus-4-6` called Pi's `ls`/`read` and answered correctly; when it tried `edit`/`write` outside the `--tools` allowlist, **Pi blocked them** (no files changed) — proving bridged calls are governed by Pi, not Cursor. No MCP server / extra dependency needed (simpler than the reference's MCP bridge). Verified the SDK tolerates a multi-second-pending `execute` (the cross-turn gap). Tool surfacing is deferred-and-batched so a tool issued after a turn ends is re-surfaced on resume (no deadlock).

**Backlog (deferred, in priority order).**

1. Agent pooling + incremental sends (v1 creates a fresh agent per turn and sends full history — correct but not token-optimal).
2. Native tool-call display replay (render Cursor's *own* tool calls — when it bypasses the bridge — as Pi `toolCall` blocks instead of activity text).
3. Robustness: truly-parallel (cross-tick) tool calls are surfaced across turns but not co-batched into one turn; per-session single live-run only; SDK built-in tools can't be hard-disabled (bridge steering is best-effort).
4. Image input; `fast` variant exposure. (`/cursor-refresh-models` is already SDK-aware.)

**Files touched.** `extensions/cursor-agent.js` — SDK backend + tool bridge inlined (`streamCursorSdk`, `startBridgeRun`/`resumeBridgeRun`, `bridgeExecute`/`surfacePendingTools`, `registerCursorSdkProvider`, `tryRegisterSdkProvider`, ripgrep config, rejection guard, `session_start` cwd capture, startup/peer-attach/refresh wiring); `package.json` (deps). Dev-setup: `~/.pi/agent/extensions/node_modules` symlink.

---

## Summary

| Phase | Change | Effort | Impact |
|-------|--------|--------|--------|
| 1 | Thinking/reasoning mapping | Medium | High — users can control model reasoning in Pi | ✅ Complete |
| 2 | Context window per model | Low | Medium — accurate context display and compaction | ✅ Complete |
| 3 | Disk model cache | Low | Medium — faster startups | ✅ Complete |
| 4 | `/cursor-refresh-models` | Low | Medium — no reload needed for new models | ✅ Complete |
| 5 | Pi-native auth flow | Medium | High — no external CLI login step | ✅ Complete |
| 6 | Image input | Low | Medium — image support in chat | ✅ Complete |
| 7 | Optional `@cursor/sdk` backend | High | High — fixes model-routing reliability, unlocks deep integration | ✅ v1 (text+thinking) Complete |

Phases 1-4 are the highest-value-per-effort. Phase 5 is the biggest UX improvement for Pi-native feel. Phase 7 is a major re-architecture that preserves the proxy for non-Pi clients while gaining `pi-cursor-sdk`-level integration.
