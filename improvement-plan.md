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

## Phase 4 — `/cursor-refresh-models` command

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

## Phase 5 — Pi-native auth flow

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

## Phase 6 — Image input support

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

**Goal.** Offer a second backend path that uses `@cursor/sdk` directly for Pi-native provider sessions, while the HTTP proxy path remains for non-Pi clients. This is the big re-architecture.

**Changes.**

1. Add `@cursor/sdk` as an optional dependency (or peer dependency).
2. Create `extensions/cursor-sdk-backend.js` that implements `streamSimple` using `Cursor.Agent.create()` / `.send()`.
3. Detect at startup whether the SDK is importable. If yes, register a `cursor` provider (in addition to or replacing `cursor-agent`) with `api: "cursor-sdk"` and the SDK-backed stream function.
4. If the SDK is not installed, fall back to the existing CLI proxy path. No regression.

**Success criteria.**

- When `@cursor/sdk` is present, Pi uses the SDK-backed provider with native thinking mapping, tool replay, and structured model metadata.
- When `@cursor/sdk` is absent, the existing proxy path works exactly as before.
- The HTTP proxy stays running in both modes so non-Pi clients keep working.

**Files touched.** New `extensions/cursor-sdk-backend.js`, modified `extensions/cursor-agent.js` to conditionally use it. `package.json` — add `@cursor/sdk` as optional dependency.

---

## Summary

| Phase | Change | Effort | Impact |
|-------|--------|--------|--------|
| 1 | Thinking/reasoning mapping | Medium | High — users can control model reasoning in Pi | ✅ Complete |
| 2 | Context window per model | Low | Medium — accurate context display and compaction | ✅ Complete |
| 3 | Disk model cache | Low | Medium — faster startups | ✅ Complete |
| 4 | `/cursor-refresh-models` | Low | Medium — no reload needed for new models |
| 5 | Pi-native auth flow | Medium | High — no external CLI login step |
| 6 | Image input | Low | Medium — image support in chat |
| 7 | Optional `@cursor/sdk` backend | High | High — unlocks native tool replay and deep integration |

Phases 1-4 are the highest-value-per-effort. Phase 5 is the biggest UX improvement for Pi-native feel. Phase 7 is a major re-architecture that preserves the proxy for non-Pi clients while gaining `pi-cursor-sdk`-level integration.
