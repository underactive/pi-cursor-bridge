# Improvement Refactor: pi-cursor-agent

> **Purpose.** A cross-phase verification review of [`improvement-plan.md`](./improvement-plan.md).
> Each of its 8 phases (1–7 plus 4½) was independently checked against the actual
> code in `extensions/cursor-agent.js` and `extensions/cursor-session.js`, judged
> against a performance-engineer + senior-architect bar, and — where it fell short —
> distilled into the prioritized follow-ups below.
>
> **Severity calibration.** This is a **single-user, localhost (`127.0.0.1`) tool**.
> Severities reflect real blast radius at that scale, not SaaS production framing.
> User-visible correctness bugs on the **primary Pi path (the `@cursor/sdk` backend)**
> stay high; "exhaustion under concurrent load" framings are downgraded or discarded
> (see [Discarded findings](#discarded-findings)).
>
> **Status of items.** Each item below is *proposed*. A principal engineer reviews,
> revises if necessary, and checks its box in the [Green-light table](#green-light-table)
> before it is implemented. No source code was changed by this review.

---

## Verdict by phase

| Phase | Area | Verdict | Follow-ups |
|------|------|---------|-----------|
| 1 | Thinking/reasoning mapping | ✅ PASS | L6 (map drift) |
| 2 | Context window per model | ✅ PASS | L6 (map drift) |
| 3 | Disk model cache | ✅ PASS (nits) | L4 |
| 4 | `/cursor-refresh-models` | ✅ PASS (nits) | L5 |
| 4½ | Session mgmt & multi-turn | ✅ **RESOLVED** (was NEEDS WORK) | H3, M1, M2 ✅ |
| 5 | Pi-native auth flow | ✅ PASS (nit) | M3 ✅ |
| 6 | Image input (SDK only) | ✅ PASS (nits) | M4 ✅ |
| 7 | `@cursor/sdk` backend + tool bridge | ✅ **RESOLVED** (was NEEDS WORK) | H1, H2, M5, L1, L2 ✅ |

**Plan-text correction (applied):** `improvement-plan.md` Phase 4½ claimed
"subsequent turns send only unseen messages." This is **false** —
`handleChatCompletions` (`cursor-agent.js:946`) always rebuilds the prompt from
the full request body via `buildPromptFromMessages`, which is the correct OpenAI
convention. The optimization was never implemented and never needed;
`buildSessionPrompt` is dead code (see H3). That sentence in the plan has been
corrected.

---

## HIGH — user-visible correctness on the primary (SDK/Pi) path

### H1 — Phase 7: stale live-run mis-resume on the default session key
- **Severity:** High · **Where:** `cursor-agent.js:1919` (`bridgeSessionKey` →
  `"__cursor_sdk_default__"`), dispatch `:2179-2185`, condition `:2181`.
- **Confirmed problem.** When the SDK agent calls a bridged tool, the turn ends
  with `done(toolUse)` but `liveRun` stays in `cursorLiveRuns` with
  `settled:false` and `pendingTools.size > 0`, waiting for Pi to resume. Two
  failure modes follow:
  1. **Leak.** If Pi never resumes (the user abandons the turn), the `liveRun`,
     its `Agent`, and the pending `execute()` Promise are never freed. There is
     **no TTL** on `cursorLiveRuns` — `finalizeBridge` only runs when `agent.send`
     settles or an abort fires, neither of which happens here.
  2. **Mis-resume (worse).** `streamCursorSdk` resumes when
     `existing && !existing.settled && existing.pendingTools.size > 0`. Because
     `bridgeSessionKey` falls back to a single shared `"__cursor_sdk_default__"`
     when Pi passes no `sessionId`, the **next** conversation under that key takes
     the *resume* branch and re-surfaces the stale tool call into a brand-new
     conversation — a visible wrong-output bug on the path Pi actually uses.
- **Proposed fix.**
  - (a) Give each `liveRun` an idle TTL that calls `finalizeBridge(... timeout)`
    and evicts it after N seconds without a resume (mirror the existing 5-min
    session timer; `unref()` it).
  - (b) In `resumeBridgeRun`, only resume if the context's trailing `toolResult`s
    actually match ids in `pendingTools`; if none match, treat it as a fresh
    `startBridgeRun` instead of resuming a stale run.
  - (c) Thread a real per-conversation id into `options` and only fall back to
    the default key when one is genuinely absent.
- **Verification.** (see [harness](#verification-harness--preconditions))
  - *Static* — `node --check`; confirm an idle-TTL timer is wired at `liveRun`
    creation (`setTimeout(…).unref()` → `finalizeBridge(…, "timeout")`) and that
    `streamCursorSdk`'s dispatch matches trailing `toolResult` ids against
    `pendingTools` before taking the resume branch. **Pass:** both patterns grep-present.
  - *Live — leak/TTL* — drive the tool-call fixture, then **abandon** the turn; poll
    `curl -s 127.0.0.1:32124/health | jq .liveRuns`. **Pass:** returns to `0` within
    TTL + a few seconds' grace.
  - *Live — mis-resume* — drive + abandon under the default key, then start a **fresh**
    conversation under the same key with no matching `toolResult`s. **Pass:** the fresh
    response's first event is a normal model turn, not the resurfaced stale tool call.

### H2 — Phase 7: abort not honored on resumed turns
- **Severity:** High · **Where:** `resumeBridgeRun` `:2144` (no `options`/`signal`
  parameter), abort wiring `:2104-2113` (only in `startBridgeRun`, `{once:true}`
  on turn 1's signal).
- **Confirmed problem.** `onAbort` (which cancels the run and rejects pending
  tools) is registered exactly once, on the **first** turn's `AbortSignal`.
  `resumeBridgeRun` never receives the new turn's `options`/`signal`, so aborting
  any turn after the first neither cancels the SDK `run` nor rejects pending
  tools — the agent run is leaked and uncancellable.
- **Proposed fix.** Pass `options` into `resumeBridgeRun`; re-bind `onAbort` to
  the *current* turn's signal on every turn (remove the prior listener, add the
  new one); ensure `onAbort` calls `run.cancel()`, rejects `pendingTools`, and
  runs `finalizeBridge`.
- **Verification.** (see [harness](#verification-harness--preconditions))
  - *Static* — `node --check`; confirm `resumeBridgeRun(` now accepts an `options`
    parameter and that the abort listener is removed+re-added per turn (a handler ref
    reassigned each turn, not a single `{once:true}` bind on turn 1). **Pass:** both present.
  - *Live* — drive a multi-turn bridged run and abort on **turn 2** (a resumed turn).
    **Pass:** `curl -s …/health | jq .liveRuns` → `0` and a Pi notification
    `[cursor-agent] Cursor run cancelled.` appears (via `notifyCursor`).

### H3 — Cross-cutting: dead/duplicate session code (drift trap)
- **Severity:** High (maintainability) · **Where:** `extensions/cursor-session.js`
  (entire 372-line file — never imported; the inlined copy is annotated at
  `cursor-agent.js:27` and `:1518`), `cursor-agent.js:187` `buildSessionPrompt`
  (no call site), inlined `CursorSession`/`SessionManager` `:48-185` duplicating
  the standalone file, and **write-only** `messageHistory` (pushed at `:1019`,
  `:1027`, `:1122`, `:1131`; never read).
- **Confirmed problem.** Two copies of the session subsystem exist; the
  standalone file is orphaned, inviting silent divergence if someone edits the
  "wrong" copy or later imports it. `buildSessionPrompt` and the entire
  `messageHistory` accumulation are vestigial — the prompt is always rebuilt from
  the request body — so they only add memory growth and confusion.
- **Proposed fix.** Delete `extensions/cursor-session.js` (jiti resolves a
  sibling `.js` against the symlink dir and would mis-load it as its own
  extension — per the Phase 7 notes — so importing it is not viable; deletion is
  the clean path). Remove `buildSessionPrompt`. Stop accumulating
  `messageHistory`, or document a concrete reason to keep it. `AGENTS.md` already
  documents only `cursor-agent.js`, so no doc change is needed there beyond
  removing the file from the package.
- **Verification.** Fully static — every check is agent-runnable with no runtime:
  - `test ! -f extensions/cursor-session.js` → **Pass:** file absent.
  - `grep -n buildSessionPrompt extensions/cursor-agent.js` → **Pass:** 0 matches.
  - `grep -n messageHistory extensions/cursor-agent.js` → **Pass:** 0 matches *or* a
    `// kept because…` justification comment is present.
  - `grep -rn cursor-session . --include='*.js' --include='*.json'` → **Pass:** no
    import or package references survive.
  - `node --check extensions/cursor-agent.js` → **Pass:** exit 0.

---

## MEDIUM — correctness / robustness, lower blast radius at single-user scale

### M1 — Phase 4½: proxy reports cumulative usage as per-response usage
- **Severity:** Medium · **Where:** `cursor-agent.js:1075` (streaming), `:1152`
  (non-streaming) — both read `session.tokenUsage` (a running total) into each
  response's `usage` block.
- **Confirmed problem.** `session.accumulateUsage()` sums usage across all turns,
  and each response reports that cumulative total. A client (or Pi) that sums
  per-response `usage` over a conversation over-counts tokens turn-over-turn. (The
  SDK path uses real per-turn `turn-ended` usage and is unaffected.)
- **Proposed fix.** Report **this turn's** usage in the response; keep the
  cumulative figure for status/telemetry only — or, since the proxy path serves
  stateless OpenAI clients, drop cross-turn accumulation there entirely (folds
  into H3).
- **Verification.** (see [harness](#verification-harness--preconditions))
  - *Static* — grep the streaming and non-streaming response `usage` sites no longer
    read `session.tokenUsage` / `accumulateUsage` into the payload. **Pass:** neither
    site references the cumulative field.
  - *Live* — send the **same** small prompt twice under one `X-Session-Id` and capture
    `usage.total_tokens` each turn. **Pass:** `turn2 ≈ turn1` (per-turn), **not** `≈ 2×turn1`
    (the cumulative bug).

### M2 — Phase 4½: subprocess orphaned on client disconnect
- **Severity:** Medium · **Where:** `cursor-agent.js:950-1095` (streaming) /
  `:1097-1191` (non-streaming) — no `res.on("close")` / request-aborted handler
  kills `child`.
- **Confirmed problem.** A client that drops the connection mid-stream leaves the
  `cursor-agent` subprocess running until it exits naturally or the 5-minute idle
  timer kills the session. Single-user impact is an occasional stray process, not
  exhaustion — hence Medium, not Critical.
- **Proposed fix.** After `writeHead` in both branches, add
  `res.on("close", () => { if (!child.killed) child.kill(); })`; guard `res.write`
  against post-close `EPIPE`.
- **Verification.** (see [harness](#verification-harness--preconditions))
  - *Static* — grep both proxy branches now contain `res.on("close"` with a `child.kill`
    call, plus a post-close `res.write` EPIPE guard. **Pass:** present in both branches.
  - *Live* — start a streaming request and drop the client mid-stream (`curl --max-time 1`,
    then kill); sample `pgrep -f cursor-agent | wc -l` before and after. **Pass:** child
    count returns to baseline within ~2 s (or a temp log
    `[cursor-agent] child killed on client close` appears).

### M3 — Phase 5: stale auth key after mid-session `/login`
- **Severity:** Medium · **Where:** `cursor-agent.js:2509` (`extractAuthKey()`
  called once at startup); `/cursor-refresh-models` handler `:2436-2491` does not
  re-read it.
- **Confirmed problem.** `cachedAuthKey` is populated once at startup. If a user
  runs `/login` mid-session, neither the spawns nor the SDK backend pick up the
  new key until Pi restarts.
- **Proposed fix.** Call `extractAuthKey()` (and `setCursorSdkAuthKey(cachedAuthKey)`)
  at the top of the `/cursor-refresh-models` handler — a cheap file read — so a
  key change is honored without a restart.
- **Verification.** (see [harness](#verification-harness--preconditions))
  - *Static* — grep the `/cursor-refresh-models` handler body now calls `extractAuthKey()`
    **and** `setCursorSdkAuthKey(` near its top. **Pass:** both calls present in the handler.
  - *Live (optional)* — change the key in `~/.pi/agent/auth.json`, run `/cursor-refresh-models`.
    **Pass:** a temp log shows the reloaded key hash changed, with no Pi restart.

### M4 — Phase 6: image data-format assumption + no non-vision guard
- **Severity:** Medium · **Where:** `collectSdkImages` `:1866-1877` (passes
  `part.data` raw, no `data:` prefix strip), attach sites `:2102` / `:2124`
  (attaches images regardless of the target model's vision capability).
- **Confirmed problem.** Two unverified assumptions: (1) that Pi's
  `ImageContent.data` is bare base64 — if it is a `data:<mime>;base64,…` URI, the
  SDK receives malformed data; (2) that only vision models receive images —
  `collectSdkImages` applies no capability check, so a manually-routed image to a
  non-vision model is sent with undefined behavior (Pi's UI gate normally
  prevents this, but the code path is unguarded).
- **Proposed fix.** Confirm Pi's `ImageContent.data` shape; strip a
  `data:<mime>;base64,` prefix if present; skip and `log` images when the model
  is not in `VISION_CAPABLE_SDK_MODELS`; optionally cap per-image size.
- **Verification.** (see [harness](#verification-harness--preconditions))
  - *Unit* (`node --test`) — `test/collect-sdk-images.test.js` against the extracted
    `collectSdkImages` / `normalizeImageData`: (a) bare base64 in → unchanged out;
    (b) `data:image/png;base64,AAAA` → `AAAA` with mime `image/png`; (c) a non-vision
    model → image skipped (`[]`) and logged; a vision model → image kept. **Pass:** suite green.
  - *Static* — grep a `VISION_CAPABLE_SDK_MODELS` capability gate now guards the attach
    sites. **Pass:** gate present.

### M5 — Phase 7: process-global `unhandledRejection` handler + fragile scoping
- **Severity:** Medium · **Where:** `cursor-agent.js:2401-2406`.
- **Confirmed problem.** The handler is correctly registered once
  (`globalThis.__piCursorSdkRejectionGuard`, reload-safe), but it is a
  **process-wide** listener that downgrades *every* unhandled rejection to a
  `console.error` (suppressing Node's default crash behavior for the whole Pi
  process) and decides "is this an SDK leak?" via `stack.includes("@cursor/sdk")`
  — which matches any error whose stack or message merely mentions the string.
- **Proposed fix.** Tighten the test to "top stack frame originates in
  `node_modules/@cursor/sdk/`"; document the process-global side effect; consider
  letting non-SDK rejections propagate rather than swallowing-to-log.
- **Verification.** (see [harness](#verification-harness--preconditions))
  - *Unit* (`node --test`) — `test/is-sdk-rejection.test.js` against the extracted predicate:
    (a) a reason whose stack **top frame** is in `node_modules/@cursor/sdk/` → `true`;
    (b) a reason whose *message* merely mentions `@cursor/sdk` but whose top frame is app
    code → `false` (the old `stack.includes` would wrongly return `true`). **Pass:** suite green.
  - *Static* — grep the handler uses the frame-origin test (not `stack.includes("@cursor/sdk")`)
    and carries a comment documenting the process-global side effect. **Pass:** both present.

---

## LOW — nits (batch into a single cleanup commit)

- **L1** — `sdkDeferred` (`:1821`) has no settle-once guard. Safe today (native
  Promises ignore a second settle) but fragile under refactor; add an explicit
  `settled` flag.
  - **Verify:** *Unit* — extracted `sdkDeferred`: resolve, then resolve/reject again →
    `settled` is `true` after the first settle and the second settle is a no-op (value
    unchanged). *Static* — grep `settled` in `sdkDeferred`. **Pass:** `node --test` green + flag present.
- **L2** — `sanitizeSdkError` (`:1880-1895`) scrubs the API key from `error.message`
  but not `error.stack`. Also replace the key in `error.stack`.
  - **Verify:** *Unit* — extracted `sanitizeSdkError` with an error whose `.stack` contains
    the API key → the key substring is absent from both message and stack of the output.
    *Static* — grep `sanitizeSdkError` now references/replaces in `error.stack`.
    **Pass:** `node --test` green + grep-present.
- **L3** — Non-streaming proxy buffers `stdout` unboundedly (`:1101`). Bounded by
  model output in practice; add a sanity cap if desired.
  - **Verify:** *Static* — grep the non-streaming branch bounds `stdout` accumulation
    (a length check / cap constant); `node --check`. **Pass:** cap present. (A live overflow
    trigger is impractical — static only.)
- **L4** — Phase 3: the auth-hash priority is `CURSOR_API_KEY` env *before* the
  Pi-stored `pikey:` (`:336-343`), slightly at odds with Phase 5's "Pi-native
  first" intent; the in-memory `CACHE_TTL` (`:2428`) vs the disk TTL is
  confusingly named. Reconcile/rename and comment the layered design.
  - **Verify:** *Static* — grep `getAuthHash` orders `pikey:` per the Phase-5 "Pi-native
    first" intent (or a comment documents the layering), and the in-memory 60 s `CACHE_TTL`
    is renamed unambiguously (e.g. `MODEL_REFRESH_TTL_MS`), distinct from the disk
    `DEFAULT_CACHE_TTL_MS`. **Pass:** rename + ordering/comment present.
- **L5** — Phase 4: refresh clears `__variantMap` (`:2446`) while an in-flight
  request may read it (`:896`); the fallback is graceful today, but a version
  counter would harden it. Also guard the "Refreshed 0 models" message.
  - **Verify:** *Static* — grep a version counter / snapshot guard on `__variantMap`, and a
    distinct zero-count branch so the handler no longer logs a misleading "Refreshed 0 models"
    success. **Pass:** both present.
- **L6** — Phases 1/2/6: hand-maintained `MODEL_CONTEXT_WINDOWS` (`:2740`) and
  `VISION_CAPABLE_SDK_MODELS` (`:2723`) drift as Cursor adds models — add
  sync-instruction comments; unify `buildThinkingLevelMap` (`:1389`) and
  `buildSdkThinkingLevelMap` (`:1616`) behind one helper.
  - **Verify:** *Static* — grep sync-instruction comments beside `MODEL_CONTEXT_WINDOWS` and
    `VISION_CAPABLE_SDK_MODELS`, and confirm `buildThinkingLevelMap` and
    `buildSdkThinkingLevelMap` both delegate to one shared helper. *Unit (optional)* —
    `node --test` over the unified helper's mapping if it is extracted. **Pass:** comments +
    shared helper present.

---

## Green-light table

Principal engineer: check a box to approve the item for implementation; strike
through and annotate if revising or rejecting.

Verify-tier legend — **S** = Static (`node --check` + `grep`), **U** = Unit (`node --test`),
**L** = Live (running proxy). See [Verification harness](#verification-harness--preconditions).

> **✅ Implemented & verified — 2026-06-16.** All 14 items were implemented and
> verified. **Static** (`node --check` clean + 28/28 item greps) and **Unit**
> (`node --test`, 20/20 across `test/collect-sdk-images`, `is-sdk-rejection`,
> `sdk-deferred`, `sanitize-sdk-error`) passed for every applicable item. The
> three **HIGH** items additionally passed an independent adversarial *semantic*
> review (idle-timer settled-guards, per-turn abort rebinding, model-pinning
> after `messageHistory` removal — all judged sound). **Live** tier (run after a
> Pi `/reload` loaded the new code): **M1 PASS** (same prompt twice under one
> `X-Session-Id` → `total_tokens` 8373 / 8355, per-turn not ~2× cumulative);
> **M2 PASS** (streaming request, mid-stream client disconnect → the spawned
> `cursor-agent` child went 0→1→0, reaped on `res.on("close")`). **H1/H2** Live
> drills exercise the `@cursor/sdk` tool-bridge path (Pi's provider interface,
> not the HTTP endpoint), so they remain a manual procedure driven inside Pi's
> chat while watching `…/health | jq .liveRuns`. Pure
> helpers were extracted to `lib/cursor-helpers.js`. Pi loads the extension
> through a symlink and resolves relative imports against the symlink dir, so a
> static `import "../lib/..."` fails at load; the extension instead resolves its
> own realpath (`fs.realpathSync(fileURLToPath(import.meta.url))`) and
> dynamic-imports the module via `loadSdkHelpers()` at startup — verified against
> the real `.pi/agent/extensions/cursor-agent.js` symlink.
> `extensions/cursor-session.js` was deleted.

| ID | Phase | Severity | Item | Verify tier | Green-lit |
|----|-------|----------|------|-------------|-----------|
| H1 | 7 | High | Stale live-run mis-resume / leak on default session key | S + L | [x] |
| H2 | 7 | High | Abort not honored on resumed turns | S + L | [x] |
| H3 | 4½ | High | Delete dead/duplicate session code (`cursor-session.js`, `buildSessionPrompt`, `messageHistory`) | S | [x] |
| M1 | 4½ | Medium | Report per-turn (not cumulative) usage on proxy path | S + L | [x] |
| M2 | 4½ | Medium | Kill subprocess on client disconnect | S + L | [x] |
| M3 | 5 | Medium | Re-read auth key on `/cursor-refresh-models` | S (+L opt) | [x] |
| M4 | 6 | Medium | Image data-URI handling + non-vision guard | U + S | [x] |
| M5 | 7 | Medium | Tighten/document the global `unhandledRejection` guard | U + S | [x] |
| L1 | 7 | Low | `sdkDeferred` settle-once guard | U + S | [x] |
| L2 | 7 | Low | Scrub API key from `error.stack` | U + S | [x] |
| L3 | 4½ | Low | Cap non-streaming `stdout` buffer | S | [x] |
| L4 | 3 | Low | Auth-hash priority + `CACHE_TTL` naming | S | [x] |
| L5 | 4 | Low | Version `__variantMap`; guard zero-count refresh | S | [x] |
| L6 | 1/2/6 | Low | Map-drift comments; unify thinking-map helpers | S (+U opt) | [x] |

---

## Verification harness & preconditions

Each item's **Verification** block above leans on the shared setup defined here, so the
blocks stay terse. Every item assumes the **baseline** first; *Unit* and *Live* tiers add
the harness pieces below.

**Tier vocabulary.** ***Static*** = no runtime (`node --check` + `grep`); ***Unit*** = pure
helper exercised via `node --test`; ***Live*** = scripted request against the running proxy.
Every check states an explicit **Pass:** observable so an agent can decide PASS/FAIL mechanically.

**Baseline (all items).** Per `AGENTS.md`: `node --check extensions/cursor-agent.js` must exit
0, then a Pi `/reload` smoke test. `[cursor-agent] …` console lines surface in Pi's log output;
*Static* log-string assertions grep the source, *Live* assertions grep that log stream.

**Live env (*Live* tiers).** Pi loaded with the extension; proxy on `127.0.0.1:32124`.
Smoke-check it first: `curl -s 127.0.0.1:32124/health` → `{ ok: true, … }`;
`curl -s 127.0.0.1:32124/v1/models` lists models. A *Live* check that can't reach the proxy is
**inconclusive**, not a fail.

**Unit harness (*Unit* tiers).** The small pure helpers named in M4 / M5 / L1 / L2 (and
optionally L6) are extracted into **`lib/cursor-helpers.js`** and imported by
`cursor-agent.js` via `../lib/cursor-helpers.js`. This module **must live outside
`extensions/`**: Pi auto-discovers every `.js` under `./extensions` as its own extension —
the same `jiti` trap that orphaned `cursor-session.js` (see [H3](#h3--cross-cutting-deadduplicate-session-code-drift-trap)).
Tests live in `test/<behavior>.test.js`, import the same module, and run with `node --test`
(matching `AGENTS.md`'s `test/normalize-model.test.js` convention). **Pass** = suite green.

**Diagnostic affordances (added with the item they serve).**
- `GET /health` JSON gains `liveRuns: cursorLiveRuns.size` — drives the H1 / H2 *Live* checks
  (poll until it returns to `0`).
- M2 reads child liveness via `pgrep -f cursor-agent | wc -l` before/after, or a temp
  `[cursor-agent] child killed on client close` log.
- H2 surfaces a Pi notification `[cursor-agent] Cursor run cancelled.` (via `notifyCursor`)
  on abort of a resumed turn.

**Tool-calling fixture (H1 / H2 *Live*).** A canned `/v1/chat/completions` body whose model
emits a bridged tool call (so the turn ends with a pending tool and a live `liveRun`).
"Abandon" = send the request, read until the tool call, then close the client **without**
posting the tool result. "Resume" = continue the same conversation with the tool result.

---

## Discarded findings

During independent re-verification, several subagent findings were graded against
SaaS-scale assumptions that do not apply to this single-user localhost tool and
were **dropped** (or downgraded above), so the principal sees the calibration:

- "Unbounded session-history memory growth exhausts RAM with 1000 concurrent
  sessions / 50 turns each." → Real growth, but the cause (write-only
  `messageHistory`) is folded into **H3** as dead code to delete, not a scaling
  defense.
- "Concurrent requests on the same `X-Session-Id` clobber `subprocessRef` →
  resource exhaustion." → Structurally true but not reachable at single-user
  scale (Pi serializes a session's turns); not worth a mutex. Noted, not tracked.
- "Concurrent `streamCursorSdk` for the same session key races." → Same: Pi
  serializes turns within a conversation; the dispatch is fragile but not a
  single-user defect. The reachable variant (stale-run resume) is **H1**.
- "Warm-startup `<100 ms` unverified." → Plausible (small JSON read + one SHA-256);
  not a defect.
