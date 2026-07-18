/**
 * pi-cursor-bridge Pi Extension
 *
 * Starts an OpenAI-compatible HTTP proxy server on port 32124 that wraps
 * Cursor's `cursor-agent` CLI. This lets Pi (and any OpenAI-compatible
 * client) access Cursor Pro models through the same API the
 * opencode-cursor bridge uses.
 *
 * Usage:
 *   1. Restart Pi or run /reload
 *   2. Open /model and select a cursor-bridge/... model
 *   3. Start chatting!
 *
 * Requires `cursor-agent` to be logged in:
 *   cursor-agent login
 */

import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// Pure, dependency-free helpers (unit-tested via `node --test`). They live in
// ../lib/cursor-helpers.js — OUTSIDE ./extensions so Pi doesn't auto-discover the
// file as its own extension. Pi loads this extension through a symlink and
// resolves relative specifiers against the symlink directory (not the repo), so
// a STATIC `import "../lib/..."` fails at load. loadSdkHelpers() instead follows
// this file's realpath back to the repo and dynamic-imports the module. The
// bindings are populated by loadSdkHelpers() before any request is served.
let collectSdkImages, isSdkRejection, makeSdkDeferred, sanitizeSdkError, estimateConversationTokens, rebaseSdkUsageFields;
let enhanceBridgeInputSchema, enhanceBridgeToolDescription, bridgeToolSteeringHints, normalizeBridgeToolArgs, isBridgeToolAbortResult;
let parseModelId, buildModelFamilies, resolveModelVariant, stripContextSuffix, extractContextSuffix;

let CursorSession, SessionManager, getSessionTimeout, DEFAULT_SESSION_TIMEOUT_MS;
let DISABLE_MODEL_CACHE, getCacheTTL, getCacheFilePath, getAuthHash, loadModelCache, saveModelCache;
let ModelCatalog;
let handleChatCompletions, fetchLocalJson, detectExistingProxy, startProxyServer;
let forceMode, homeDir, resolveCursorAgent, cursorAgentPath, cursorAgentEnv, fetchCursorModels,
  buildPromptFromMessages, normalizeModel, formatCursorError;
let FALLBACK_MODELS, FALLBACK_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, VISION_CAPABLE_SDK_MODELS,
  MODEL_CONTEXT_WINDOWS, MAX_TOKENS_MAP, contextWindowToSuffix, parseContextFromDisplayName;

/**
 * Dynamic-import a module from ../lib/ following this file's realpath
 * (symlink-safe — see the comment above the binding declarations).
 * @param {string} relName — file name inside ../lib/ (e.g. "sessions.js")
 */
async function importLib(relName) {
  const selfReal = fs.realpathSync(fileURLToPath(import.meta.url));
  const libPath = path.join(path.dirname(selfReal), "..", "lib", relName);
  return import(pathToFileURL(libPath).href);
}

async function loadSdkHelpers() {
  const helpers = await importLib("cursor-helpers.js");
  ({ collectSdkImages, isSdkRejection, makeSdkDeferred, sanitizeSdkError, estimateConversationTokens, rebaseSdkUsageFields,
    enhanceBridgeInputSchema, enhanceBridgeToolDescription, bridgeToolSteeringHints, normalizeBridgeToolArgs, isBridgeToolAbortResult,
    parseModelId, buildModelFamilies, resolveModelVariant, stripContextSuffix, extractContextSuffix } = helpers);

  ({ CursorSession, SessionManager, getSessionTimeout, DEFAULT_SESSION_TIMEOUT_MS } = await importLib("sessions.js"));

  ({ FALLBACK_MODELS, FALLBACK_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, VISION_CAPABLE_SDK_MODELS,
    MODEL_CONTEXT_WINDOWS, MAX_TOKENS_MAP, contextWindowToSuffix, parseContextFromDisplayName } = await importLib("model-data.js"));

  ({ forceMode, homeDir, resolveCursorAgent, cursorAgentPath, cursorAgentEnv, fetchCursorModels,
    buildPromptFromMessages, normalizeModel, formatCursorError } = await importLib("cursor-cli.js"));

  ({ DISABLE_MODEL_CACHE, getCacheTTL, getCacheFilePath, getAuthHash, loadModelCache, saveModelCache } = await importLib("model-cache.js"));

  ({ ModelCatalog } = await importLib("model-catalog.js"));

  ({ handleChatCompletions, fetchLocalJson, detectExistingProxy, startProxyServer } = await importLib("proxy.js"));
}

/**
 * Active model catalog (family variant map). Instantiated by the default
 * export before the proxy serves requests; replaced content-wise by
 * adoptModels()/clear() (see the L5 note in lib/model-catalog.js).
 * @type {import("../lib/model-catalog.js").ModelCatalog|null}
 */
let modelCatalog = null;

// ─── Config ───────────────────────────────────────────────────────────

const PORT = 32124;
const HOST = "127.0.0.1";
const PROVIDER_ID = "cursor-bridge";
const HEALTH_SERVICE_ID = "cursor-bridge";

// ─── Cache Infrastructure ────────────────────────────────────────────────

/**
 * Cached API key from ~/.pi/agent/auth.json.
 * Populated once at startup by extractAuthKey().
 * @type {string|null}
 */
let cachedAuthKey = null;

/**
 * Read the stored API key from ~/.pi/agent/auth.json (Pi's AuthStorage file)
 * and cache it in the module-level cachedAuthKey variable.
 *
 * Called once at extension startup. Silently returns null if the file doesn't
 * exist or if cursor-agent isn't configured there — the auth hash and spawn
 * callers use null to mean "no Pi-stored key" (rely on cursor-agent login).
 *
 * The auth.json structure is:
 *   { "cursor-bridge": { type: "api_key", key: "ck-..." } }
 *
 * @returns {string|null}
 */
function extractAuthKey() {
  try {
    const authPath = path.join(homeDir(), ".pi", "agent", "auth.json");
    const data = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const entry = data[PROVIDER_ID];
    if (entry && entry.type === "api_key" && entry.key) {
      cachedAuthKey = entry.key;
      return cachedAuthKey;
    }
  } catch {
    // ENOENT (no auth file yet), corrupt JSON, or missing entry — fall through
  }
  cachedAuthKey = null;
  return null;
}

// ─── Model Family Detection ─────────────────────────────────────────────

// parseModelId, buildModelFamilies, and resolveModelVariant now live in
// ../lib/cursor-helpers.js (pure, unit-tested) and are bound by loadSdkHelpers().

// ─── Extension entry point ────────────────────────────────────────────

/** @type {{ lines: string[] } | { error: string } | null} */
let startupLog = null;

function scheduleStartupLog(pi) {
  // Use globalThis so the guard survives jiti module re-evaluation on /reload.
  // Without this, each /reload resets the module-level flag and registers a
  // duplicate session_start handler, causing the startup notification to appear
  // N+1 times after N reloads.
  if (globalThis.__piCursorBridgeStartupLogRegistered) return;
  globalThis.__piCursorBridgeStartupLogRegistered = true;

  // Pi's default custom-message renderer inserts a blank line between the
  // [cursor-bridge] header and the content. Render it ourselves so the content
  // appears on the line immediately following the header.
  pi.registerMessageRenderer("cursor-bridge", (message, _options, theme) => {
    const label = theme.fg(
      "customMessageLabel",
      `\x1b[1m[${message.customType}]\x1b[22m`,
    );
    const text =
      typeof message.content === "string"
        ? message.content
        : (message.content || [])
            .filter((c) => c && c.type === "text")
            .map((c) => c.text)
            .join("\n");

    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(label, 0, 0));
    box.addChild(
      new Markdown(text, 0, 0, getMarkdownTheme(), {
        color: (t) => theme.fg("customMessageText", t),
      }),
    );
    return box;
  });

  pi.on("session_start", (event, ctx) => {
    // Capture cwd for the SDK backend — Pi does not pass cwd into streamSimple,
    // so the backend reads it from here. Runs on every session_start.
    if (ctx && ctx.cwd) setCursorSdkCwd(ctx.cwd);

    if (event.reason !== "startup" && event.reason !== "reload") return;
    const payload = startupLog;
    if (!payload) return;

    // session_start runs before Pi renders [Context]/[Skills]/[Extensions];
    // defer to the next macrotask so messages appear after that header.
    setTimeout(() => {
      if ("error" in payload) {
        if (ctx.hasUI) {
          pi.sendMessage({ customType: "cursor-bridge", content: `Failed to start: ${payload.error}`, display: true });
        } else {
          console.error(`[cursor-bridge] Failed to start: ${payload.error}`);
        }
        return;
      }
      // Send all startup lines as a single message so consecutive lines render
      // under one [cursor-bridge] header instead of each line getting its own.
      if (payload.lines.length === 0) return;
      if (ctx.hasUI) {
        pi.sendMessage({
          customType: "cursor-bridge",
          content: payload.lines.join("\n"),
          display: true,
        });
      } else {
        for (const line of payload.lines) {
          console.log(`[cursor-bridge] ${line}`);
        }
      }
    }, 0);
  });
}

/**
 * Fetch the OpenAI-style model list from a sibling proxy already
 * running on the local port. Used in client-only mode so we don't
 * spawn a second `cursor-agent models` process when another Pi
 * instance has already populated its cache.
 */
async function fetchPeerModels() {
  const payload = await fetchLocalJson("/v1/models", { host: HOST, port: PORT, timeoutMs: 2000 });
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error("peer /v1/models returned no data");
  }
  return payload.data;
}

function buildModelConfigs(models) {
  const { variantMap, standaloneModels } = buildModelFamilies(models);

  /**
   * Build a thinkingLevelMap for a family.
   * Maps Pi thinking levels to effort tokens that resolveModelVariant understands.
   */
  function buildThinkingLevelMap(familyEntry) {
    const vKeys = Object.keys(familyEntry.variants);
    const tvKeys = Object.keys(familyEntry.thinkingVariants);

    const map = emptyThinkingLevelMap(); // L6: shared base shape

    // Map non-thinking variants: Pi level → effort token
    if (vKeys.includes("low")) map.low = "low";
    if (vKeys.includes("medium")) map.medium = "medium";
    if (vKeys.includes("high")) map.high = "high";
    if (vKeys.includes("xhigh")) map.xhigh = "xhigh";
    // Map extra-high → Pi's xhigh
    if (vKeys.includes("extra-high")) map.xhigh = "extra-high";
    if (vKeys.includes("max")) map.xhigh = "max";
    if (vKeys.includes("none")) map.off = "none";

    // Map thinking variants: if a thinking variant exists at a level,
    // override the non-thinking mapping (thinking wins for active thinking)
    if (tvKeys.includes("low")) map.low = "low";
    if (tvKeys.includes("medium")) map.medium = "medium";
    if (tvKeys.includes("high")) map.high = "high";
    if (tvKeys.includes("xhigh")) map.xhigh = "xhigh";
    if (tvKeys.includes("on")) {
      // Boolean thinking: map all non-null thinking levels to "on"
      for (const level of ["low", "medium", "high", "xhigh"]) {
        if (map[level] !== null) map[level] = "on";
      }
      // If no levels mapped yet, map medium and high to "on"
      if (!Object.values(map).some(v => v === "on")) {
        map.medium = "on";
        map.high = "on";
      }
    }

    return map;
  }

  const configs = [];

  // Register collapsed families
  for (const [base, entry] of Object.entries(variantMap)) {
    const hasVariants = Object.keys(entry.variants).length > 0
                      || Object.keys(entry.thinkingVariants).length > 0;
    if (!hasVariants) continue;

    const cw = MODEL_CONTEXT_WINDOWS[base] ?? FALLBACK_CONTEXT_WINDOW;
    const mt = MAX_TOKENS_MAP[base] ?? DEFAULT_MAX_TOKENS;

    configs.push({
      id: base,
      name: base,
      reasoning: true,
      thinkingLevelMap: buildThinkingLevelMap(entry),
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: cw,
      maxTokens: mt,
    });

    // Register @ context variant for non-default context window
    if (cw !== FALLBACK_CONTEXT_WINDOW) {
      const suffix = contextWindowToSuffix(cw);
      configs.push({
        id: `${base}@${suffix}`,
        name: `${base}@${suffix}`,
        reasoning: true,
        thinkingLevelMap: buildThinkingLevelMap(entry),
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: cw,
        maxTokens: mt,
      });
    }
  }

  // Register standalone models (flat, non-reasoning entries)
  for (const id of standaloneModels) {
    // Strip -fast suffix for map key lookup (fast variants share base values)
    const mapKey = id.endsWith("-fast") ? id.slice(0, -5) : id;
    const cw = MODEL_CONTEXT_WINDOWS[mapKey] ?? FALLBACK_CONTEXT_WINDOW;
    const mt = MAX_TOKENS_MAP[mapKey] ?? DEFAULT_MAX_TOKENS;

    configs.push({
      id: id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: cw,
      maxTokens: mt,
    });

    // Register @ context variant for non-default context window
    if (cw !== FALLBACK_CONTEXT_WINDOW) {
      const suffix = contextWindowToSuffix(cw);
      configs.push({
        id: `${mapKey}@${suffix}`,
        name: `${mapKey}@${suffix}`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: cw,
        maxTokens: mt,
      });
    }
  }

  return configs;
}

// ─── @cursor/sdk backend (Phase 7, inlined) ──────────────────────────────────
//
// Optional backend that talks to Cursor via @cursor/sdk instead of the CLI/proxy.
// The CLI exposes effort/thinking ONLY as effort-baked model-ID strings; collapsing
// those into families and re-expanding by reasoning_effort is lossy — a family that
// lacks the requested tier resolves to a bare, invalid model name cursor-agent
// rejects, so the user gets no reply. The SDK returns CLEAN base IDs with a
// structured `parameters` array (thinking/context/effort/fast); effort travels as
// a ModelSelection.params entry, never the ID, and a missing tier is simply omitted.
//
// Inlined (not a separate module) because Pi loads each extension as a single
// symlinked file via jiti, and it auto-discovers every sibling .js under
// ./extensions as its own extension — so provider code stays in this one file.
// (Pure, framework-free helpers live in ../lib/cursor-helpers.js, which sits
// outside ./extensions precisely to avoid that auto-discovery.)
//
// RUNTIME: @cursor/sdk uses connect-rpc + a native binary. Transient transport
// errors (rare) surface as NetworkError; discovery failures fall back to the CLI
// path automatically. Verified working on Node 24 and 26.
// V1 SCOPE: direct text+thinking streaming, real usage, abort, sanitized errors,
// plus a Pi→Cursor MCP tool bridge so Pi-side tools are surfaced (below).

/** Provider `api` key for the SDK backend. Must match the model configs' api. */
const CURSOR_SDK_API = "cursor-sdk";
const SDK_APPROX_CHARS_PER_TOKEN = 4;
const SDK_DEFAULT_MAX_TOKENS = 32000;
const SDK_FALLBACK_CONTEXT_WINDOW = 200000;
const SDK_THINKING_TRACE_MAX_CHARS = 50000;

/** @type {Promise<any> | null} */
let sdkModulePromise = null;
/** @type {boolean | null} */
let sdkAvailable = null;

/**
 * Point @cursor/sdk at its bundled ripgrep binary via CURSOR_RIPGREP_PATH.
 *
 * The SDK's local-agent workspace scan (initializeIgnoreMapping) shells out to
 * ripgrep to read .gitignore/.cursorignore. It tries to auto-locate `rg` from
 * its platform package relative to process.argv[1] — which under jiti/Pi is
 * Pi's CLI, not us — so it fails and (when uncaught) leaks an async rejection.
 * The binary ships in `@cursor/sdk-<platform>-<arch>/bin/rg`; resolve it and set
 * the env var the SDK reads. Best-effort: if it can't be found, the SDK degrades
 * to no ignore filtering (and we already guard the leaked rejection).
 */
function configureSdkRipgrep() {
  if (process.env.CURSOR_RIPGREP_PATH) return;
  try {
    const require = createRequire(import.meta.url);
    const platformPkg = `@cursor/sdk-${process.platform}-${process.arch}`;
    const pkgJson = require.resolve(`${platformPkg}/package.json`);
    const rg = path.join(path.dirname(pkgJson), "bin", "rg");
    if (fs.existsSync(rg)) process.env.CURSOR_RIPGREP_PATH = rg;
  } catch { /* leave unset; ignore-mapping degrades gracefully */ }
}

/** Dynamically import @cursor/sdk. Cached. Returns the module or null on failure. */
async function loadCursorSdk() {
  if (sdkModulePromise === null) {
    configureSdkRipgrep();
    sdkModulePromise = import("@cursor/sdk").catch(() => null);
  }
  return sdkModulePromise;
}

/** True when @cursor/sdk can be imported. Cached after the first call. */
async function isCursorSdkAvailable() {
  if (sdkAvailable === null) {
    sdkAvailable = (await loadCursorSdk()) !== null;
  }
  return sdkAvailable;
}

/** @type {string|null} API key resolved by the host (Pi AuthStorage / env). */
let backendAuthKey = null;
/** @type {string} cwd captured from Pi's session_start. */
let backendCwd = process.cwd();

function setCursorSdkAuthKey(key) { backendAuthKey = key || null; }
function setCursorSdkCwd(cwd) { if (typeof cwd === "string" && cwd) backendCwd = cwd; }

/** Resolve the effective API key (Pi passes a placeholder through options.apiKey). */
function resolveSdkApiKey(optionApiKey) {
  const candidate = (optionApiKey || "").trim();
  if (candidate && candidate.length > 20 && !candidate.startsWith("$") && !candidate.includes("placeholder")) {
    return candidate;
  }
  return backendAuthKey || process.env.CURSOR_API_KEY || null;
}

/** @type {Record<string, object>} Pi model id → selection metadata. */
let sdkMetadata = {};

/**
 * Default SDK model-discovery timeout (15 s).
 * The SDK's models.list() has no built-in timeout, so a slow or unreachable
 * Cursor API can hang the async extension factory indefinitely. This prevents
 * that from freezing Pi startup or /reload. Configurable via env var.
 */
const SDK_DISCOVERY_TIMEOUT_MS = 15_000;

function getSdkDiscoveryTimeout() {
  const env = process.env.PI_CURSOR_SDK_DISCOVERY_TIMEOUT_MS;
  if (env) {
    const n = parseInt(env, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return SDK_DISCOVERY_TIMEOUT_MS;
}

/** Fetch the raw model catalog from the SDK. */
async function discoverSdkModels(apiKey) {
  const sdk = await loadCursorSdk();
  if (!sdk) throw new Error("@cursor/sdk not available");
  const timeoutMs = getSdkDiscoveryTimeout();
  const result = await Promise.race([
    sdk.Cursor.models.list({ apiKey }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`SDK model discovery timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
  return result;
}

function sdkContextValueToTokens(value) {
  const m = String(value || "").match(/^(\d+(?:\.\d+)?)([km])$/i);
  if (!m) return SDK_FALLBACK_CONTEXT_WINDOW;
  const num = parseFloat(m[1]);
  return m[2].toLowerCase() === "m" ? Math.round(num * 1_000_000) : Math.round(num * 1_000);
}

/**
 * The empty Pi thinking-level map: all six levels unsupported (null). Shared
 * base for buildThinkingLevelMap (CLI families) and buildSdkThinkingLevelMap
 * (SDK params) so the Pi level set can't drift between the two. (L6)
 */
function emptyThinkingLevelMap() {
  return { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null };
}

/**
 * Build a Pi thinkingLevelMap from a model's parameter set. Values are the
 * concrete param value per Pi level; null marks a level unsupported. Returns
 * null when the model exposes no reasoning controls. Precedence effort > reasoning.
 */
function buildSdkThinkingLevelMap(paramById) {
  const pick = (param, wanted) => {
    if (!param) return null;
    const values = param.values.map((v) => v.value);
    for (const w of wanted) if (values.includes(w)) return w;
    return null;
  };
  const effort = paramById.effort;
  const reasoning = paramById.reasoning;
  const thinking = paramById.thinking;
  if (effort) {
    const low = pick(effort, ["low", "minimal"]);
    return { ...emptyThinkingLevelMap(), minimal: low, low, medium: pick(effort, ["medium"]), high: pick(effort, ["high"]), xhigh: pick(effort, ["max", "extra-high", "xhigh", "high"]) };
  }
  if (reasoning) {
    const low = pick(reasoning, ["low", "minimal"]);
    return { ...emptyThinkingLevelMap(), minimal: low, low, medium: pick(reasoning, ["medium"]), high: pick(reasoning, ["high"]), xhigh: pick(reasoning, ["high", "medium"]) };
  }
  if (thinking) {
    return { ...emptyThinkingLevelMap(), minimal: "true", low: "true", medium: "true", high: "true", xhigh: "true" };
  }
  return null;
}

/**
 * Transform the SDK catalog into Pi ProviderModelConfig[] and populate the
 * selection metadata. One Pi entry per (model × context value); effort/thinking
 * stay request-time params. `fast` is deferred.
 */
function buildSdkModelConfigs(models) {
  const configs = [];
  const metadata = {};
  for (const model of models) {
    if (!model || !model.id || model.id === "default") continue;
    const params = Array.isArray(model.parameters) ? model.parameters : [];
    const paramById = {};
    for (const p of params) paramById[p.id] = p;

    const thinkingLevelMap = buildSdkThinkingLevelMap(paramById);
    const reasoning = thinkingLevelMap !== null;

    const variants = Array.isArray(model.variants) ? model.variants : [];
    const defaultVariant = variants.find((v) => v.isDefault) || variants[0] || { params: [] };
    const defaultParams = Array.isArray(defaultVariant.params) ? defaultVariant.params : [];

    const paramIds = {
      effort: Boolean(paramById.effort),
      reasoning: Boolean(paramById.reasoning),
      thinking: Boolean(paramById.thinking),
      context: Boolean(paramById.context),
      fast: Boolean(paramById.fast),
    };

    const supportsImage = VISION_CAPABLE_SDK_MODELS.has(model.id);
    const contextValues = paramById.context ? paramById.context.values.map((v) => v.value) : [null];
    for (const ctx of contextValues) {
      const piId = ctx ? `${model.id}@${ctx}` : model.id;
      const contextWindow = ctx ? sdkContextValueToTokens(ctx) : SDK_FALLBACK_CONTEXT_WINDOW;
      configs.push({
        id: piId,
        name: ctx ? `${model.displayName || model.id} (${ctx})` : (model.displayName || model.id),
        api: CURSOR_SDK_API,
        reasoning,
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        input: supportsImage ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: SDK_DEFAULT_MAX_TOKENS,
      });
      metadata[piId] = { baseId: model.id, defaultParams, paramIds, contextValue: ctx, thinkingLevelMap: thinkingLevelMap || {} };
    }
  }
  sdkMetadata = metadata;
  return { configs, count: configs.length };
}

/**
 * Build the SDK ModelSelection { id, params } for a Pi model id + thinking level.
 * Effort/thinking applied as params, context from the @ suffix. A level the model
 * lacks is omitted — never a broken id.
 */
function buildCursorModelSelection(piModelId, thinkingLevel) {
  const meta = sdkMetadata[piModelId];
  if (!meta) {
    const base = piModelId.replace(/@[a-z0-9.]+$/i, "");
    return { id: base };
  }
  const params = new Map(meta.defaultParams.map((p) => [p.id, p.value]));
  if (meta.contextValue && meta.paramIds.context) params.set("context", meta.contextValue);

  const level = thinkingLevel || "off";
  const mapped = meta.thinkingLevelMap[level];
  if (mapped !== undefined && mapped !== null) {
    if (meta.paramIds.effort) {
      if (meta.paramIds.thinking) params.set("thinking", "true");
      params.set("effort", mapped);
    } else if (meta.paramIds.reasoning) {
      params.set("reasoning", mapped);
    } else if (meta.paramIds.thinking) {
      params.set("thinking", mapped);
    }
  } else if (meta.paramIds.thinking && level === "off") {
    params.set("thinking", "false");
  }
  const paramList = [...params.entries()].map(([id, value]) => ({ id, value }));
  return paramList.length > 0 ? { id: meta.baseId, params: paramList } : { id: meta.baseId };
}

/** Build the zeroed initial AssistantMessage Pi accumulates into. */
function makeSdkInitialMessage(model) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * Emits Pi text/thinking content events while maintaining partial.content +
 * contentIndex bookkeeping (text/thinking are mutually-exclusive blocks).
 */
class SdkPartialEmitter {
  constructor(stream, partial) {
    this.stream = stream;
    this.partial = partial;
    this.thinkingIndex = -1;
    this.textIndex = -1;
    this.thinkingChars = 0;
    this.thinkingTruncated = false;
  }
  closeThinking() {
    if (this.thinkingIndex < 0) return;
    const block = this.partial.content[this.thinkingIndex];
    if (block && block.type === "thinking") {
      this.stream.push({ type: "thinking_end", contentIndex: this.thinkingIndex, content: block.thinking, partial: this.partial });
    }
    this.thinkingIndex = -1;
  }
  closeText() {
    if (this.textIndex < 0) return "";
    const i = this.textIndex;
    const block = this.partial.content[i];
    this.textIndex = -1;
    if (!block || block.type !== "text") return "";
    this.stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: this.partial });
    return block.text;
  }
  appendThinking(delta) {
    this.closeText();
    if (this.thinkingTruncated || !delta) return;
    let text = delta;
    if (this.thinkingChars + text.length > SDK_THINKING_TRACE_MAX_CHARS) {
      const remaining = Math.max(SDK_THINKING_TRACE_MAX_CHARS - this.thinkingChars, 0);
      text = `${text.slice(0, remaining)}\n[Cursor activity trace truncated]\n`;
      this.thinkingTruncated = true;
    }
    if (!text) return;
    if (this.thinkingIndex < 0) {
      this.thinkingIndex = this.partial.content.length;
      this.partial.content.push({ type: "thinking", thinking: "" });
      this.stream.push({ type: "thinking_start", contentIndex: this.thinkingIndex, partial: this.partial });
    }
    const block = this.partial.content[this.thinkingIndex];
    if (!block || block.type !== "thinking") return;
    block.thinking += text;
    this.thinkingChars += text.length;
    this.stream.push({ type: "thinking_delta", contentIndex: this.thinkingIndex, delta: text, partial: this.partial });
  }
  appendText(delta) {
    this.closeThinking();
    if (!delta) return;
    if (this.textIndex < 0) {
      this.textIndex = this.partial.content.length;
      this.partial.content.push({ type: "text", text: "" });
      this.stream.push({ type: "text_start", contentIndex: this.textIndex, partial: this.partial });
    }
    const block = this.partial.content[this.textIndex];
    if (!block || block.type !== "text") return;
    block.text += delta;
    this.stream.push({ type: "text_delta", contentIndex: this.textIndex, delta, partial: this.partial });
  }
  currentText() {
    if (this.textIndex < 0) return "";
    const block = this.partial.content[this.textIndex];
    return block && block.type === "text" ? block.text : "";
  }
  /** Emit a Pi toolCall content block (used by the tool bridge). */
  emitToolCall(id, name, args) {
    this.closeThinking();
    this.closeText();
    const contentIndex = this.partial.content.length;
    const toolCall = { type: "toolCall", id, name, arguments: args || {} };
    this.partial.content.push(toolCall);
    this.stream.push({ type: "toolcall_start", contentIndex, partial: this.partial });
    this.stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(args || {}), partial: this.partial });
    this.stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: this.partial });
  }
}

function estimateSdkTokens(text) {
  return Math.max(0, Math.ceil((text || "").length / SDK_APPROX_CHARS_PER_TOKEN));
}

/**
 * Build a minimal context preamble that replaces Pi's full system prompt when
 * STRIP_SYSTEM_PROMPT is active (the default — see PI_CURSOR_STRIP_SYSTEM_PROMPT).
 * Keeps only essential context (environment identity + date + cwd) without Pi's
 * tool definitions that overlap with Cursor's SDK system prompt.
 */
function buildMinimalPreamble() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `You are running inside Pi (a coding agent).\nCurrent date: ${y}-${m}-${d}\nCurrent working directory: ${backendCwd}`;
}

/** Flatten Pi's Context into a single prompt string for one SDK agent send. */
function buildSdkPrompt(context) {
  const parts = [];
  if (context.systemPrompt) {
    if (STRIP_SYSTEM_PROMPT) {
      parts.push(buildMinimalPreamble());
    } else {
      parts.push(context.systemPrompt);
    }
  }
  for (const msg of context.messages || []) {
    if (msg.role === "user") {
      parts.push(`User: ${extractSdkText(msg.content)}`);
    } else if (msg.role === "assistant") {
      const text = extractSdkText(msg.content);
      if (text) parts.push(`Assistant: ${text}`);
    } else if (msg.role === "toolResult") {
      const body = typeof msg.content === "string" ? msg.content : extractSdkText(msg.content);
      parts.push(`[Tool result${msg.toolName ? ` from ${msg.toolName}` : ""}]: ${body}`);
    }
  }
  return parts.join("\n\n");
}

function extractSdkText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => {
    if (typeof b === "string") return b;
    if (b && b.type === "text") return b.text;
    return "";
  }).filter(Boolean).join("");
}

// ─── Pi → Cursor tool bridge (cross-turn live run) ───────────────────────────
//
// Pi's tool protocol is cross-turn: the provider emits toolCall blocks + a
// done(reason:"toolUse") to END a turn, Pi runs the tool (with approval/UI),
// then re-invokes streamSimple with a ToolResultMessage. But the SDK agent runs
// its whole loop INSIDE one agent.send(), surfacing tools via customTool.execute
// callbacks that must return inline. We reconcile the two by keeping a single
// agent.send() ALIVE across multiple streamSimple calls (a "live run"): when the
// agent calls a bridged tool, execute() returns a Promise that stays pending; we
// emit the Pi toolCall, end the current stream with done(toolUse), and resolve
// that Promise on the NEXT streamSimple call once Pi delivers the toolResult.
// (Verified: agent.send tolerates a multi-second-pending execute.)
//
// Scope/limits (v1): parallel tool calls are batched only within one microtask
// tick; the SDK's built-in tools can't be disabled, so we steer the model to the
// pi_* tools via prompt (best-effort, like the reference project); one pending
// tool-set per session.

/** @type {Map<string, object>} sessionKey → live run state */
// A module-scoped handle to the Pi runtime, captured at extension load so code
// far from the default export (e.g. the bridge's abort handler) can surface a
// user-facing notification. Rendered as a boxed [cursor-bridge] message by the
// renderer registered in scheduleStartupLog; no-ops safely in headless runs.
let activePi = null;
function notifyCursor(content) {
  try { activePi && activePi.sendMessage({ customType: "cursor-bridge", content, display: true }); } catch {}
}

const cursorLiveRuns = new Map();

// Idle TTL for a parked live run awaiting Pi's tool results. Mirrors the 5-min
// session timeout so an abandoned bridged turn can't leak its agent, and a
// stale run can't linger under the shared default key. (H1)
const BRIDGE_IDLE_TTL_MS = DEFAULT_SESSION_TIMEOUT_MS;

function bridgeSessionKey(options) {
  return (options && options.sessionId) || "__cursor_sdk_default__";
}

/** Steering text so the model prefers the bridged Pi tools over built-ins. */
function bridgeSteeringPreamble(toolNames) {
  const hints = bridgeToolSteeringHints(toolNames);
  return [
    "## Environment",
    "You are running inside Pi. The following tools execute in the user's actual",
    "environment through Pi, with the user's approval:",
    toolNames.map((n) => `  - ${n}`).join("\n"),
    "ALWAYS use these tools for file reads/writes/edits, shell commands, and code",
    "search. Do NOT use any built-in equivalents — only the tools listed above act",
    "on the real workspace.",
    ...(hints.length ? ["", "## Tool requirements", ...hints] : []),
    "",
  ].join("\n");
}

/** Collect the trailing contiguous block of toolResult messages from context. */
function getTrailingToolResults(context) {
  const out = [];
  const msgs = (context && context.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "toolResult") out.unshift(msgs[i]);
    else if (out.length) break;
  }
  return out;
}

function toolResultToString(msg) {
  if (typeof msg.content === "string") return msg.content;
  return extractSdkText(msg.content);
}

/** Build SDK customTools from Pi's active tools; each routes through Pi. */
function buildBridgeCustomTools(liveRun, tools) {
  const customTools = {};
  for (const tool of tools) {
    if (!tool || !tool.name) continue;
    const customName = `pi_${tool.name}`;
    liveRun.toolNameMap.set(customName, tool.name);
    customTools[customName] = {
      description: enhanceBridgeToolDescription(tool.name, tool.description || `Pi tool: ${tool.name}`),
      inputSchema: enhanceBridgeInputSchema(tool.name, tool.parameters),
      execute: (args, ctx) => bridgeExecute(liveRun, tool.name, args, ctx),
    };
  }
  return customTools;
}

/**
 * Called by the SDK agent when it invokes a bridged tool. Registers the call and
 * schedules it to be surfaced to Pi; returns a Promise that resolves once Pi
 * delivers the tool result on a later streamSimple call.
 */
function bridgeExecute(liveRun, piToolName, args, ctx) {
  if (liveRun.aborted || liveRun.settled) return Promise.reject(makeSdkAbort());
  const toolCallId = (ctx && ctx.toolCallId) || `bridge-${liveRun.callSeq++}`;
  const normalizedArgs = normalizeBridgeToolArgs(piToolName, args);
  const d = makeSdkDeferred();
  liveRun.pendingTools.set(toolCallId, { d, piToolName, args: normalizedArgs, surfaced: false });
  scheduleSurface(liveRun);
  return d.promise;
}

/** Surface pending tools to Pi on the next microtask (batches same-tick calls). */
function scheduleSurface(liveRun) {
  if (liveRun.flushScheduled) return;
  liveRun.flushScheduled = true;
  queueMicrotask(() => {
    liveRun.flushScheduled = false;
    surfacePendingTools(liveRun);
  });
}

/**
 * Emit a Pi toolCall for every not-yet-surfaced pending tool and end the current
 * turn with done(toolUse). No-op when there's no active turn — those tools stay
 * pending and are surfaced by the next resume (so a tool issued after a turn
 * already ended is never stranded, which would otherwise deadlock the agent).
 */
function surfacePendingTools(liveRun) {
  if (liveRun.settled || !liveRun.resolveTurn) return;
  let surfacedAny = false;
  for (const [id, p] of liveRun.pendingTools) {
    if (!p.surfaced) {
      liveRun.emitter.emitToolCall(id, p.piToolName, p.args);
      p.surfaced = true;
      surfacedAny = true;
    }
  }
  if (!surfacedAny) return;
  liveRun.partial.stopReason = "toolUse";
  liveRun.stream.push({ type: "done", reason: "toolUse", message: liveRun.partial });
  const resolveTurn = liveRun.resolveTurn;
  liveRun.resolveTurn = null;
  resolveTurn();
}

function handleBridgeDelta(liveRun, update) {
  if (liveRun.aborted || liveRun.settled) return;
  switch (update.type) {
    case "text-delta": liveRun.emitter.appendText(update.text); updateLiveSdkUsage(liveRun); break;
    case "thinking-delta": liveRun.emitter.appendThinking(update.text); updateLiveSdkUsage(liveRun); break;
    case "thinking-completed": liveRun.emitter.closeThinking(); break;
    case "turn-ended": if (update.usage) liveRun.lastUsage = update.usage; break;
    default: break; // tool-call-* deltas are emitted by bridgeExecute, not here
  }
}

/**
 * Throttled live context-usage estimate, applied to the in-flight partial
 * message while the SDK agent streams. Without this, `partial.usage` stays
 * all-zero until finalizeBridge() runs applySdkUsage(), so any live context
 * gauge (Pi's own, or a subagent progress widget) sits at 0% for the whole
 * run. Uses the same Pi-side estimates as finalize (prompt via buildSdkPrompt
 * + streamed output blocks), so the final applySdkUsage() values land on the
 * same scale. Prompt estimate is cached per context snapshot; recomputed at
 * most every 500ms.
 */
function updateLiveSdkUsage(liveRun) {
  const now = Date.now();
  if (liveRun.liveUsageAt && now - liveRun.liveUsageAt < 500) return;
  liveRun.liveUsageAt = now;
  if (liveRun.livePromptText == null || liveRun.livePromptContext !== liveRun.lastContext) {
    liveRun.livePromptContext = liveRun.lastContext;
    try {
      liveRun.livePromptText = liveRun.lastContext ? buildSdkPrompt(liveRun.lastContext) : "";
    } catch {
      liveRun.livePromptText = "";
    }
  }
  const u = liveRun.partial && liveRun.partial.usage;
  if (!u) return;
  u.input = estimateSdkTokens(liveRun.livePromptText);
  u.totalTokens = estimateConversationTokens(liveRun.livePromptText, liveRun.partial.content, SDK_APPROX_CHARS_PER_TOKEN);
}

/** Clear a parked run's idle-eviction timer. (H1) */
function clearBridgeIdle(liveRun) {
  if (liveRun.idleTimer) { clearTimeout(liveRun.idleTimer); liveRun.idleTimer = null; }
}

/** Arm the idle-eviction timer for a run parked awaiting Pi's tool results. If
 *  Pi never resumes, finalize the run so its agent + pending Promise are freed
 *  (and it can't be mis-resumed later). unref() so it never holds Pi open. (H1) */
function armBridgeIdle(liveRun) {
  clearBridgeIdle(liveRun);
  if (liveRun.settled) return;
  liveRun.idleTimer = setTimeout(() => {
    if (liveRun.settled) return;
    console.log("[cursor-bridge] bridge run idle-timeout — finalizing stale live run");
    finalizeBridge(liveRun, liveRun.sessionKey, null, makeSdkAbort(), liveRun.apiKey);
  }, BRIDGE_IDLE_TTL_MS);
  if (liveRun.idleTimer.unref) liveRun.idleTimer.unref();
}

/** True if any trailing toolResult id matches a tool still pending on this run.
 *  Guards the resume branch so a stale run under the shared default session key
 *  is NOT resumed into an unrelated new conversation. (H1) */
function resumeMatches(liveRun, context) {
  for (const tr of getTrailingToolResults(context)) {
    if (tr.toolCallId && liveRun.pendingTools.has(tr.toolCallId)) return true;
  }
  return false;
}

function hasTrailingBridgeToolAbort(context) {
  return getTrailingToolResults(context).some((tr) => isBridgeToolAbortResult(tr));
}

function abortBridgeRun(liveRun, notify = true) {
  if (liveRun.settled) return;
  liveRun.aborted = true;
  if (notify) notifyCursor("Cursor run cancelled.");
  if (liveRun.run) { try { liveRun.run.cancel().catch(() => {}); } catch {} }
  finalizeBridge(liveRun, liveRun.sessionKey, null, makeSdkAbort(), liveRun.apiKey);
}

/** (Re)bind the abort handler to the CURRENT turn's AbortSignal. Pi delivers a
 *  fresh signal each turn, so without rebinding, an abort after turn 1 is
 *  silently ignored and the run is leaked + uncancellable. (H2) */
function bindBridgeAbort(liveRun, signal) {
  if (liveRun.abortSignal && liveRun.onAbort) {
    try { liveRun.abortSignal.removeEventListener("abort", liveRun.onAbort); } catch {}
  }
  liveRun.abortSignal = signal || null;
  if (!signal) return;
  if (signal.aborted) { liveRun.onAbort(); return; }
  signal.addEventListener("abort", liveRun.onAbort, { once: true });
}

/** Finalize the whole live run (agent.send settled) onto the current stream. */
function finalizeBridge(liveRun, sessionKey, result, error, apiKey) {
  if (liveRun.settled) return;
  liveRun.settled = true;
  clearBridgeIdle(liveRun);
  cursorLiveRuns.delete(sessionKey);
  for (const [, p] of liveRun.pendingTools) { try { p.d.reject(makeSdkAbort()); } catch {} }
  liveRun.pendingTools.clear();
  if (liveRun.agent) { try { liveRun.agent.close(); } catch { /* best effort */ } }

  const { stream, emitter, partial } = liveRun;
  // Wrapped: an idle/stale finalize targets a stream Pi already consumed and
  // ended, so emitting onto it is a harmless no-op rather than a throw.
  try {
    if (liveRun.aborted || (result && result.status === "cancelled")) {
      finalizeSdkAbort(stream, emitter, partial);
    } else if (error || (result && result.status === "error")) {
      emitter.closeThinking();
      emitter.closeText();
      partial.stopReason = "error";
      partial.errorMessage = sanitizeSdkError(error || new Error((result && result.error) || "Cursor SDK run failed"), apiKey);
      stream.push({ type: "error", reason: "error", error: partial });
    } else {
      const streamed = emitter.currentText();
      const finalText = (result && result.result) || "";
      if (finalText && finalText.length > streamed.length && finalText.startsWith(streamed)) {
        emitter.appendText(finalText.slice(streamed.length));
      } else if (finalText && !streamed) {
        emitter.appendText(finalText);
      }
      emitter.closeThinking();
      emitter.closeText();
      applySdkUsage(partial, liveRun.lastUsage, estimatePiUsage(liveRun));
      partial.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: partial });
    }
  } catch { /* stream already ended (idle/stale finalize) — nothing to emit */ }
  const rt = liveRun.resolveTurn;
  liveRun.resolveTurn = null;
  if (rt) rt();
}

/** Start a fresh live run: create the agent and kick off agent.send(). */
async function startBridgeRun(sessionKey, stream, model, context, options) {
  const partial = makeSdkInitialMessage(model);
  stream.push({ type: "start", partial });
  const emitter = new SdkPartialEmitter(stream, partial);

  const apiKey = resolveSdkApiKey(options && options.apiKey);
  if (!apiKey) {
    partial.stopReason = "error";
    partial.errorMessage = "No Cursor API key. Run /login or set CURSOR_API_KEY.";
    stream.push({ type: "error", reason: "error", error: partial });
    return;
  }
  const sdk = await loadCursorSdk();
  if (!sdk) {
    partial.stopReason = "error";
    partial.errorMessage = "@cursor/sdk is not installed.";
    stream.push({ type: "error", reason: "error", error: partial });
    return;
  }

  const turn = makeSdkDeferred();
  const liveRun = {
    agent: null, run: null, sendPromise: null,
    stream, partial, emitter, resolveTurn: turn.resolve,
    pendingTools: new Map(), toolNameMap: new Map(),
    flushScheduled: false, callSeq: 0, lastUsage: null,
    settled: false, aborted: false,
    // Latest Pi context for this run, refreshed each turn (start + resume). Used
    // by estimatePiUsage() at finalize to size the gauge AND the overflow check
    // off Pi's own conversation rather than Cursor's internal accounting.
    lastContext: context,
    // H1/H2: stored so the idle timer and abort handler are self-contained.
    sessionKey, apiKey, idleTimer: null, onAbort: null, abortSignal: null,
  };
  cursorLiveRuns.set(sessionKey, liveRun);

  const tools = (context && context.tools) || [];
  const customTools = buildBridgeCustomTools(liveRun, tools);
  const customNames = Object.keys(customTools);
  const hasTools = customNames.length > 0;

  const selection = buildCursorModelSelection(model.id, options && options.reasoning);
  const prompt = hasTools
    ? `${bridgeSteeringPreamble(customNames)}\n${buildSdkPrompt(context)}`
    : buildSdkPrompt(context);
  // M4: only attach images to vision-capable models; otherwise skip + log so a
  // manually-routed image to a text-only model can't be sent with undefined
  // behavior (Pi's UI normally gates this, but the code path must be safe).
  const visionCapable = VISION_CAPABLE_SDK_MODELS.has(model.id);
  const images = collectSdkImages(context, visionCapable);
  if (!visionCapable) {
    const dropped = collectSdkImages(context, true).length;
    if (dropped) notifyCursor(`${dropped} image${dropped === 1 ? "" : "s"} not sent — model ${model.id} doesn't support image input.`);
  }

  // H2: define the abort handler once (it closes over the stable liveRun) and
  // (re)bind it to each turn's signal via bindBridgeAbort. On abort it cancels
  // the SDK run and finalizes — rejecting pending tools — on the current turn.
  liveRun.onAbort = () => abortBridgeRun(liveRun);
  bindBridgeAbort(liveRun, options && options.signal);

  if (liveRun.aborted) { await turn.promise; return; }

  try {
    liveRun.agent = await sdk.Agent.create({
      apiKey,
      model: selection,
      // "plan" is Cursor's native read-only mode — no local file edits or
      // shell. Forced via PI_CURSOR_FORCE_MODE for planning-only embeddings.
      mode: forceMode() ? "plan" : "agent",
      local: hasTools ? { cwd: backendCwd, customTools } : { cwd: backendCwd },
    });
    // H3: an abort can land while Agent.create() is awaited above. onAbort has
    // already finalized the Pi turn but had no Run handle to cancel (and the
    // signal fires once), so don't dispatch a send we'd only have to cancel —
    // release the agent and bail before the SDK ever starts a run.
    if (liveRun.aborted) { try { liveRun.agent.close(); } catch {} return; }
    liveRun.sendPromise = liveRun.agent.send(
      images.length ? { text: prompt, images } : { text: prompt },
      { onDelta: ({ update }) => handleBridgeDelta(liveRun, update) },
    );
    // The whole agentic loop (spanning tool turns) completes here.
    liveRun.sendPromise
      .then(async (run) => {
        liveRun.run = run;
        // H3: cancel the race where the abort fired after send() dispatched but
        // before its Run resolved. onAbort ran with liveRun.run still null, so it
        // could only finalize the Pi turn — agent.close() merely releases the
        // executor lease, it does NOT stop the in-flight run. Now that we hold the
        // handle, Run.cancel() aborts the executor so Cursor actually stops
        // instead of running its loop to completion.
        if (liveRun.aborted) { try { await run.cancel(); } catch {} return; }
        const result = await run.wait();
        finalizeBridge(liveRun, sessionKey, result, null, apiKey);
      })
      .catch((err) => finalizeBridge(liveRun, sessionKey, null, err, apiKey));
  } catch (err) {
    finalizeBridge(liveRun, sessionKey, null, err, apiKey);
  }

  await turn.promise;
  // Turn yielded back to Pi. If the run is parked awaiting tool results (not
  // settled), arm the idle timer so an abandoned turn can't leak. (H1)
  if (!liveRun.settled) armBridgeIdle(liveRun);
}

/** Resume an in-flight live run: deliver tool results, continue streaming. */
async function resumeBridgeRun(liveRun, stream, context, model, options) {
  clearBridgeIdle(liveRun); // Pi resumed in time — cancel the idle eviction. (H1)
  const partial = makeSdkInitialMessage(model);
  stream.push({ type: "start", partial });
  const emitter = new SdkPartialEmitter(stream, partial);

  const turn = makeSdkDeferred();
  liveRun.stream = stream;
  liveRun.partial = partial;
  liveRun.emitter = emitter;
  liveRun.resolveTurn = turn.resolve;
  liveRun.flushScheduled = false;
  // Refresh the context snapshot — by now it carries the tool results Pi just
  // produced, so the finalize-time gauge estimate reflects the grown conversation.
  liveRun.lastContext = context;

  // H2: rebind the abort handler to THIS turn's signal so an abort on a resumed
  // turn actually cancels the run and rejects pending tools.
  bindBridgeAbort(liveRun, options && options.signal);
  if (liveRun.aborted || liveRun.settled) { await turn.promise; return; }

  // Deliver the tool results Pi just produced to the waiting agent. If the user
  // cancelled while Pi was executing a bridged tool, Pi resumes us with an error
  // toolResult such as "Operation aborted". Do NOT feed that back to Cursor as a
  // normal tool failure, or the parked SDK run will continue working after Esc.
  const results = getTrailingToolResults(context);
  if (results.some((tr) => tr.toolCallId && liveRun.pendingTools.has(tr.toolCallId) && isBridgeToolAbortResult(tr))) {
    abortBridgeRun(liveRun);
    await turn.promise;
    return;
  }
  for (const tr of results) {
    const p = liveRun.pendingTools.get(tr.toolCallId);
    if (p) { liveRun.pendingTools.delete(tr.toolCallId); p.d.resolve(toolResultToString(tr)); }
  }

  // If tools issued after the previous turn ended are still un-surfaced, surface
  // them now (prevents the agent deadlocking on a tool Pi never saw). The
  // microtask gives the agent a chance to issue follow-up tools first.
  queueMicrotask(() => surfacePendingTools(liveRun));

  await turn.promise;
  // Parked again awaiting more tool results? Re-arm the idle timer. (H1)
  if (!liveRun.settled) armBridgeIdle(liveRun);
}

/**
 * Pi streamSimple entry point for the SDK backend. Dispatches to a fresh run or
 * resumes an in-flight live run (when the agent is awaiting tool results).
 */
function streamCursorSdk(model, context, options) {
  const stream = createAssistantMessageEventStream();
  const sessionKey = bridgeSessionKey(options);

  (async () => {
    const existing = cursorLiveRuns.get(sessionKey);
    if (existing && !existing.settled && existing.pendingTools.size > 0 && resumeMatches(existing, context)) {
      await resumeBridgeRun(existing, stream, context, model, options);
    } else if (hasTrailingBridgeToolAbort(context)) {
      if (existing && !existing.settled) abortBridgeRun(existing, false);
      const partial = makeSdkInitialMessage(model);
      finalizeSdkAbort(stream, new SdkPartialEmitter(stream, partial), partial);
    } else {
      // H1: a non-matching live run under this key (e.g. the shared default key
      // after an abandoned turn) is stale — finalize it before starting fresh so
      // its pending tool calls aren't re-surfaced into this new conversation.
      if (existing && !existing.settled) {
        finalizeBridge(existing, existing.sessionKey, null, makeSdkAbort(), existing.apiKey);
      }
      await startBridgeRun(sessionKey, stream, model, context, options);
    }
  })().catch((error) => {
    const partial = makeSdkInitialMessage(model);
    partial.stopReason = "error";
    partial.errorMessage = sanitizeSdkError(error, resolveSdkApiKey(options && options.apiKey) || "");
    try { stream.push({ type: "error", reason: "error", error: partial }); } catch {}
  }).finally(() => {
    stream.end();
  });

  return stream;
}

/**
 * Apply usage to the Pi assistant message.
 *
 * On the SDK backend Cursor reports usage for its OWN server-side agent context
 * (a large system prompt + built-in tool schemas + the full internal tool-loop
 * transcript) plus a CUMULATIVE, unbounded cacheRead — none of which is the
 * conversation Pi holds, forwards, or can compact. Pi reads this usage for THREE
 * things, and all three must be sized off Pi's conversation, not Cursor's:
 *   1. context-fill gauge + threshold compaction → calculateContextTokens(usage)
 *      = usage.totalTokens || sum(fields)
 *   2. footer token/cost stats (↑input ↓output …) → the per-field counts
 *   3. SILENT context-overflow detection → isContextOverflow() flags a successful
 *      turn when usage.input + usage.cacheRead > model.contextWindow
 * Forwarding Cursor's raw numbers leaves (3) tripping on EVERY successful turn —
 * its input+cacheRead routinely dwarfs the model's window (cacheRead alone is
 * cumulative) — which fires overflow-recovery compaction and then the
 * "Cannot continue from message role: assistant" retry failure (the transcript
 * ends on the assistant turn with nothing queued to continue from).
 *
 * So we report Pi's OWN forwarded conversation across every field Pi compares to
 * the window: input = the forwarded-prompt estimate, cacheRead/cacheWrite = 0,
 * totalTokens = the prompt+output estimate (see estimatePiUsage). Only output
 * stays Cursor's real model output — it is accurate, always small, and never
 * part of the overflow comparison. This keeps the gauge, the footer, and overflow
 * detection all tracking the compactable conversation in lockstep.
 *
 * @param {object} partial — the Pi AssistantMessage being finalized
 * @param {object|null} usage — Cursor's turn-ended usage (only outputTokens is used)
 * @param {{input: number, total: number}} [estimate] — Pi-side forwarded-conversation estimate
 */
function applySdkUsage(partial, usage, estimate) {
  let outputTokens;
  if (usage) {
    outputTokens = usage.outputTokens ?? 0;
  } else {
    let outChars = 0;
    for (const block of partial.content) {
      if (block.type === "text") outChars += block.text.length;
      else if (block.type === "thinking") outChars += block.thinking.length;
    }
    outputTokens = Math.max(0, Math.ceil(outChars / SDK_APPROX_CHARS_PER_TOKEN));
  }
  const fields = rebaseSdkUsageFields(outputTokens, estimate);
  partial.usage.input = fields.input;
  partial.usage.output = fields.output;
  partial.usage.cacheRead = fields.cacheRead;
  partial.usage.cacheWrite = fields.cacheWrite;
  partial.usage.totalTokens = fields.totalTokens;
}

/**
 * Estimate Pi's OWN forwarded conversation for this turn, sized for every Pi
 * mechanism that reads usage (gauge, threshold compaction, AND silent-overflow
 * detection — see applySdkUsage). Returns:
 *   - input: the forwarded prompt only (system/preamble + messages + tool
 *     results, via buildSdkPrompt) — the value Pi adds to cacheRead (now 0) for
 *     its overflow check, so it must stay below the model's context window.
 *   - total: input + this turn's assistant output blocks (text + thinking +
 *     toolCall name/args), counted exactly as Pi's estimateTokens() counts an
 *     assistant message — drives the context-fill gauge and threshold compaction.
 *
 * Uses the same chars/4 heuristic Pi's own estimateTokens() uses, so the values
 * stay stable when Pi later re-estimates this message as a "trailing" message.
 *
 * Deliberately EXCLUDES Cursor's opaque server-side baseline (its system prompt +
 * built-in tool schemas + internal tool-loop transcript + cumulative cacheRead):
 * Pi can neither see, control, nor compact those tokens, so counting them would
 * only mislead the gauge and mis-fire compaction/overflow. When STRIP_SYSTEM_PROMPT
 * is on (the default), buildSdkPrompt already reflects the minimal preamble, so
 * the estimate naturally tracks the smaller forwarded payload.
 */
function estimatePiUsage(liveRun) {
  const promptText = liveRun.lastContext ? buildSdkPrompt(liveRun.lastContext) : "";
  return {
    input: estimateSdkTokens(promptText),
    total: estimateConversationTokens(promptText, liveRun.partial.content, SDK_APPROX_CHARS_PER_TOKEN),
  };
}

function finalizeSdkAbort(stream, emitter, partial) {
  emitter.closeThinking();
  emitter.closeText();
  partial.stopReason = "aborted";
  partial.errorMessage = "Cancelled.";
  stream.push({ type: "error", reason: "aborted", error: partial });
}

function makeSdkAbort() {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

function isSdkAbort(error) {
  return error && (error.name === "AbortError" || /abort/i.test(String(error.message || "")));
}

// ─── Provider registration ────────────────────────────────────────────────────

/**
 * Shared provider config for both backends. The SDK variant overrides `api`
 * and adds `streamSimple`; there baseUrl/apiKey are inert placeholders (Pi
 * requires them even for a custom streamSimple provider).
 */
function baseProviderConfig(modelConfigs) {
  return {
    name: "Cursor Bridge",
    baseUrl: `http://${HOST}:${PORT}/v1`,
    apiKey: "$PI_CURSOR_AGENT_API_KEY",
    api: "openai-completions",
    authHeader: false,
    models: modelConfigs,
    compat: {
      supportsDeveloperRole: true,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      supportsUsageInStreaming: true,
    },
  };
}

function registerCursorProvider(pi, modelConfigs) {
  pi.registerProvider(PROVIDER_ID, baseProviderConfig(modelConfigs));
}

/**
 * Set to "1" to force the CLI/proxy backend even when @cursor/sdk is installed.
 * Use if the SDK path misbehaves (e.g. wrong Node version).
 */
const DISABLE_SDK_BACKEND = process.env.PI_CURSOR_SDK_DISABLE === "1";

/**
 * Strip Pi's system prompt from the SDK agent prompt, relying on Cursor's own
 * SDK system prompt for agent behavior instructions instead. Pi tool bridging
 * (the bridgeSteeringPreamble) is unaffected and still tells the model which Pi
 * tools to use.
 *
 * When active, buildSdkPrompt replaces Pi's full system prompt with a minimal
 * ~150-char context preamble (environment identity + date + cwd). This avoids
 * sending Pi's entire system prompt (with its tool docs) to Cursor on top of
 * Cursor's own system prompt + tool schemas — duplicated context that inflates
 * every SDK turn's input tokens.
 *
 * DEFAULT: ON. Stripping is the right behavior for the SDK backend (Cursor runs
 * its own agent with its own prompt), so it's opt-OUT, not opt-in. Set
 * PI_CURSOR_STRIP_SYSTEM_PROMPT=0 to forward Pi's full system prompt instead.
 */
const STRIP_SYSTEM_PROMPT = process.env.PI_CURSOR_STRIP_SYSTEM_PROMPT !== "0";

/**
 * Register the provider against the @cursor/sdk backend (Phase 7).
 *
 * Unlike the proxy provider, this routes Pi turns through `streamCursorSdk`
 * directly — no HTTP, no effort-baked model IDs, so the family-collapse routing
 * bug cannot occur. Pi requires `baseUrl` and `apiKey` even for a custom
 * `streamSimple` provider, so we pass inert placeholders; the real key is
 * resolved inside the stream function via setCursorSdkAuthKey()/CURSOR_API_KEY.
 */
function registerCursorSdkProvider(pi, modelConfigs) {
  pi.registerProvider(PROVIDER_ID, {
    ...baseProviderConfig(modelConfigs), // baseUrl/apiKey inert: SDK path bypasses HTTP
    api: CURSOR_SDK_API,
    streamSimple: streamCursorSdk,
  });
}

/**
 * Try to register the SDK-backed provider. Returns the model count on success,
 * or null when the SDK is disabled/unavailable/keyless or discovery fails (in
 * which case the caller falls back to the CLI/proxy provider — no regression).
 */
/**
 * Live status, surfaced by /cursor-status and the startup log. The backend
 * selection is otherwise silent (SDK → CLI fallback has several causes), so
 * tracking the chosen backend + WHY is the high-value diagnostic.
 */
const cursorStatus = {
  backend: "unknown",   // "@cursor/sdk" | "CLI/proxy" | "disabled"
  reason: "not initialized",
  modelCount: 0,
  modelSource: "",      // "SDK discovery" | "cursor-agent CLI" | "disk cache" | ...
  proxy: "",            // "http://host:port (owned|peer)" | "disabled"
};

/**
 * Resolve the installed @cursor/sdk version (best-effort), or null.
 * The package blocks `@cursor/sdk/package.json` via its `exports` map, so we
 * resolve the main entry and walk up to the package root instead.
 */
function getSdkVersion() {
  try {
    let dir = path.dirname(createRequire(import.meta.url).resolve("@cursor/sdk"));
    for (let i = 0; i < 6; i++) {
      const pj = path.join(dir, "package.json");
      if (fs.existsSync(pj)) {
        const pkg = JSON.parse(fs.readFileSync(pj, "utf8"));
        if (pkg.name === "@cursor/sdk") return pkg.version || null;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* not resolvable */ }
  return null;
}

/** Human-readable auth-source label shared by /cursor-status and the startup log. */
function resolveAuthSourceLabel() {
  return cachedAuthKey
    ? "Pi AuthStorage (cursor-bridge)"
    : (process.env.CURSOR_API_KEY ? "CURSOR_API_KEY env" : "none");
}

/** Render the current status as display lines (used by command + startup log). */
function getCursorStatusLines() {
  const authSource = resolveAuthSourceLabel();
  const sdkVersion = getSdkVersion();
  const rg = process.env.CURSOR_RIPGREP_PATH;
  return [
    `Backend:   ${cursorStatus.backend}`,
    ...(forceMode() ? [`Mode:      forced ${forceMode()} (PI_CURSOR_FORCE_MODE — read-only runs)`] : []),
    `Detail:    ${cursorStatus.reason}`,
    `Models:    ${cursorStatus.modelCount}${cursorStatus.modelSource ? ` (${cursorStatus.modelSource})` : ""}`,
    `Auth:      ${authSource}`,
    `Proxy:     ${cursorStatus.proxy || "n/a"}`,
    `Runtime:   Node ${process.version} | @cursor/sdk ${sdkVersion || "not installed"}`,
    `Ripgrep:   ${rg || "not configured"}`,
    `cwd:       ${backendCwd}`,
    `Live runs: ${cursorLiveRuns.size} active`,
  ];
}

/** Compact backend summary for the one-time startup log. */
function buildStartupLogLines() {
  const authSource = resolveAuthSourceLabel();
  const sdkVersion = getSdkVersion();
  const lines = [
    `Backend: ${cursorStatus.backend} (${cursorStatus.modelCount} models${cursorStatus.modelSource ? `, ${cursorStatus.modelSource}` : ""})`,
  ];
  // When NOT on the SDK backend, say why — that's the actionable bit.
  if (cursorStatus.backend !== "@cursor/sdk") {
    lines.push(`SDK inactive: ${cursorStatus.reason}`);
  }
  lines.push(`Auth: ${authSource} | Node ${process.version} | @cursor/sdk ${sdkVersion || "not installed"}`);
  if (cursorStatus.proxy) lines.push(`Proxy: ${cursorStatus.proxy}`);
  lines.push(`Run /cursor-status for details`);
  return lines;
}

/**
 * Try to register the SDK-backed provider. Returns the model count on success,
 * else null (caller falls back to CLI/proxy). Records the reason into
 * cursorStatus either way so /cursor-status can explain the choice.
 */
async function tryRegisterSdkProvider(pi) {
  if (DISABLE_SDK_BACKEND) { cursorStatus.reason = "SDK disabled via PI_CURSOR_SDK_DISABLE=1"; return null; }
  if (!cachedAuthKey) { cursorStatus.reason = "no Cursor API key resolved (run /login)"; return null; }
  try {
    if (!(await isCursorSdkAvailable())) {
      cursorStatus.reason = "@cursor/sdk not importable (run npm install / check the extensions node_modules)";
      return null;
    }
    setCursorSdkAuthKey(cachedAuthKey);
    const sdkModels = await discoverSdkModels(cachedAuthKey);
    const { configs, count } = buildSdkModelConfigs(sdkModels);
    if (count === 0) { cursorStatus.reason = "SDK returned 0 models"; return null; }
    registerCursorSdkProvider(pi, configs);
    cursorStatus.backend = "@cursor/sdk";
    cursorStatus.reason = "SDK active";
    cursorStatus.modelCount = count;
    cursorStatus.modelSource = "SDK discovery";
    return { count };
  } catch (e) {
    cursorStatus.reason = `SDK discovery failed: ${(e && e.message) || e}`;
    return null; // fall through to CLI/proxy backend
  }
}

// ─── Model service ────────────────────────────────────────────────────

/**
 * Create the model service: owns the in-memory model cache (list, timestamp,
 * origin) and the operations that populate it — getModels (disk cache → CLI →
 * stale disk → fallback), adoptModels, peer attach, and the
 * /cursor-refresh-models refresh flow.
 *
 * A module-level factory (not nested in the default export) so the export
 * body stays a readable straight-line startup sequence. Module-level
 * collaborators (cursorStatus, cachedAuthKey, buildModelConfigs,
 * registerCursorProvider, tryRegisterSdkProvider, startupLog, …) are
 * referenced directly; only `pi` is injected.
 *
 * @param {object} pi — the Pi extension API
 */
function createModelService(pi) {
  let modelsCache = [];
  let modelsCacheTime = 0;
  let modelsCacheOrigin = null; // "disk" | "cli" | "stale-disk" | "fallback"
  // L4: in-memory de-dupe window for repeated getModels() calls within one Pi
  // session. Distinct from the on-disk DEFAULT_CACHE_TTL_MS (24 h) — renamed so
  // the two TTLs can't be confused.
  const MODEL_REFRESH_TTL_MS = 60_000;

  /**
   * Adopt a model list as the active set: update the in-memory cache, rebuild
   * the catalog's variant map, and record the cache timestamp + origin.
   *
   * @param {Array} models — model objects to adopt
   * @param {string} origin — "disk" | "cli" | "stale-disk" | "fallback"
   * @param {number} [cachedAt] — cache timestamp; defaults to now. Pass 0 to
   *   leave the in-memory TTL expired (fallback adoption retries the CLI).
   */
  function adoptModels(models, origin, cachedAt) {
    modelsCache = models;
    modelCatalog.adopt(modelsCache);
    modelsCacheTime = cachedAt ?? Date.now();
    modelsCacheOrigin = origin;
  }

  async function getModels() {
    // Disk cache read: only on first call per extension lifecycle
    if (modelsCache.length === 0 && !DISABLE_MODEL_CACHE) {
      const diskEntry = loadModelCache({}, cachedAuthKey);
      if (diskEntry) {
        // cachedAt defaults to now so the in-memory 60s TTL protects this session
        adoptModels(
          diskEntry.models.map(m => ({ ...m, created: Math.floor(Date.now() / 1000) })),
          "disk",
        );
        return modelsCache;
      }
    }

    if (modelsCache.length > 0 && Date.now() - modelsCacheTime < MODEL_REFRESH_TTL_MS) {
      return modelsCache;
    }
    try {
      adoptModels(await fetchCursorModels(cachedAuthKey), "cli");
      // Fire-and-forget: cache to disk after successful CLI fetch
      if (!DISABLE_MODEL_CACHE) {
        saveModelCache(modelsCache, undefined, cachedAuthKey).catch(() => {});
      }
    } catch (err) {
      console.error("[cursor-bridge] Failed to fetch models:", err.message);
      if (modelsCache.length === 0) {
        // Try stale disk cache before falling back to FALLBACK_MODELS
        if (!DISABLE_MODEL_CACHE) {
          const staleEntry = loadModelCache({ allowStale: true }, cachedAuthKey);
          if (staleEntry) {
            adoptModels(
              staleEntry.models.map(m => ({ ...m, created: Math.floor(Date.now() / 1000) })),
              "stale-disk",
              staleEntry.cachedAt,
            );
            return modelsCache;
          }
        }
        const fallback = FALLBACK_MODELS.map((id) => ({
          id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "cursor",
        }));
        // cachedAt 0 keeps the in-memory TTL expired so the next call retries the CLI
        adoptModels(fallback, "fallback", 0);
      }
    }
    return modelsCache;
  }

  /**
   * Register against an already-running sibling proxy without binding
   * the port ourselves. Lets multiple Pi instances share one proxy
   * so the second/third instance still gets cursor-bridge models in
   * /model instead of failing with EADDRINUSE.
   */
  async function attachToExistingProxy(reason) {
    // The SDK backend is per-process and port-independent, so prefer it even
    // when another instance owns the proxy port.
    cursorStatus.proxy = `http://${HOST}:${PORT}/v1 (peer)`;
    const sdkResult = await tryRegisterSdkProvider(pi);
    if (sdkResult) {
      startupLog = { lines: buildStartupLogLines() };
      return true;
    }
    try {
      const peerModels = await fetchPeerModels();
      const modelConfigs = buildModelConfigs(peerModels);
      registerCursorProvider(pi, modelConfigs);
      cursorStatus.backend = "CLI/proxy (peer)";
      cursorStatus.modelCount = modelConfigs.length;
      cursorStatus.modelSource = "peer proxy";
      startupLog = { lines: buildStartupLogLines() };
      return true;
    } catch (err) {
      // Try disk cache as fallback when peer models unavailable
      if (!DISABLE_MODEL_CACHE) {
        const diskEntry = loadModelCache({ allowStale: true }, cachedAuthKey);
        if (diskEntry) {
          const models = diskEntry.models.map(m => ({
            ...m,
            created: Math.floor(Date.now() / 1000),
          }));
          const modelConfigs = buildModelConfigs(models);
          registerCursorProvider(pi, modelConfigs);
          cursorStatus.backend = "CLI/proxy (peer)";
          cursorStatus.modelCount = modelConfigs.length;
          cursorStatus.modelSource = "disk cache (peer unavailable)";
          startupLog = { lines: buildStartupLogLines() };
          return true;
        }
      }
      startupLog = { error: `Detected proxy on ${HOST}:${PORT} but failed to query it: ${err.message}` };
      return false;
    }
  }

  /**
   * /cursor-refresh-models: re-read auth, clear the disk + in-memory caches,
   * and re-register the provider (SDK preferred, CLI otherwise).
   * @param {{ hasUI: boolean }} ctx — Pi command context
   */
  async function refresh(ctx) {
    // M3: a mid-session /login changes the stored key — re-read it (a cheap
    // file read) so the CLI spawns and the SDK backend pick up the new key
    // without a Pi restart.
    extractAuthKey();
    setCursorSdkAuthKey(cachedAuthKey);

    // 1. Clear disk cache
    try { fs.unlinkSync(getCacheFilePath()); } catch {}

    // 2. Reset in-memory state
    modelsCache = [];
    modelsCacheTime = 0;
    modelsCacheOrigin = null;
    modelCatalog.clear();

    // 3. Re-register. Prefer the SDK backend (re-discovers its catalog);
    //    otherwise re-fetch from the CLI (disk cache cleared → hits CLI).
    try {
      const sdkResult = await tryRegisterSdkProvider(pi);
      let count;
      let via;
      if (sdkResult) {
        count = sdkResult.count;
        via = "@cursor/sdk";
      } else {
        const freshModels = await getModels();
        const modelConfigs = buildModelConfigs(freshModels);
        registerCursorProvider(pi, modelConfigs);
        count = modelConfigs.length;
        via = "cursor-agent CLI";
        cursorStatus.backend = "CLI/proxy";
        cursorStatus.modelCount = count;
        cursorStatus.modelSource = "cursor-agent CLI";
      }

      // L5: discovering zero models is a failure to surface, not a "success".
      if (count === 0) {
        const warn = `No models discovered via ${via} — check auth (/login) and connectivity, then retry.`;
        if (ctx.hasUI) {
          pi.sendMessage({ customType: "cursor-bridge", content: warn, display: true });
        } else {
          console.warn(`[cursor-bridge] ${warn}`);
        }
      } else if (ctx.hasUI) {
        pi.sendMessage({
          customType: "cursor-bridge",
          content: `Refreshed ${count} models via ${via}`,
          display: true,
        });
      } else {
        console.log(`[cursor-bridge] Refreshed ${count} models via ${via}`);
      }
    } catch (err) {
      const msg = `Failed to refresh models: ${err.message}`;
      if (ctx.hasUI) {
        pi.sendMessage({
          customType: "cursor-bridge",
          content: msg,
          display: true,
        });
      } else {
        console.error(`[cursor-bridge] ${msg}`);
      }
    }
  }

  return {
    getModels,
    adoptModels,
    attachToExistingProxy,
    refresh,
    /** Current model-list origin: "disk" | "cli" | "stale-disk" | "fallback" | null */
    get origin() { return modelsCacheOrigin; },
  };
}

export default async function (pi) {
  // Load the pure helpers (see loadSdkHelpers) before anything uses them — the
  // unhandledRejection guard below (isSdkRejection) and all request handling.
  // A failure here is fatal and surfaces clearly at load, rather than as a
  // confusing "undefined is not a function" on the first request.
  await loadSdkHelpers();
  activePi = pi; // capture for notifyCursor (used by the bridge abort handler)

  // The local @cursor/sdk leaks internal async rejections during agent
  // init/cancel (e.g. initializeIgnoreMapping's RxJS pipeline). Without a
  // handler these can crash the host or print scary stacks. Swallow ONLY
  // SDK-originated rejections; re-surface anything else so real bugs aren't
  // hidden. Registered once (reload-safe) to avoid accumulating handlers.
  if (!globalThis.__piCursorBridgeSdkRejectionGuard) {
    globalThis.__piCursorBridgeSdkRejectionGuard = true;
    // PROCESS-GLOBAL side effect: this listener suppresses Node's default
    // crash-on-unhandled-rejection for the WHOLE Pi process. We keep it
    // deliberately — crashing all of Pi over one stray cross-turn SDK leak is
    // worse than a log — but it now only swallows rejections whose TOP stack
    // frame is inside @cursor/sdk (isSdkRejection). Everything else is logged so
    // real application bugs stay visible rather than being silently dropped. (M5)
    process.on("unhandledRejection", (reason) => {
      if (isSdkRejection(reason)) return; // benign cross-turn SDK leak
      console.error("[cursor-bridge] unhandled rejection:", reason);
    });
  }
  scheduleStartupLog(pi);

  if (process.env.PI_CURSOR_AGENT_DISABLE === "1") {
    cursorStatus.backend = "disabled";
    cursorStatus.reason = "PI_CURSOR_AGENT_DISABLE=1";
    cursorStatus.proxy = "disabled";
    startupLog = { lines: ["Disabled via PI_CURSOR_AGENT_DISABLE=1"] };
    return;
  }

  // Close any server from a previous load so /reload re-binds the port with
  // the latest handler code instead of silently reusing the stale server.
  const PREV = globalThis.__piCursorBridgeServer;
  if (PREV) {
    try { PREV.close(); } catch {}
    globalThis.__piCursorBridgeServer = null;
  }

  modelCatalog = new ModelCatalog(); // populated alongside models by service.adoptModels()
  const service = createModelService(pi);

  // Register /cursor-refresh-models command early so it's available on all
  // startup paths (new proxy, peer-attach, and disabled).
  pi.registerCommand("cursor-refresh-models", {
    description: "Refresh the Cursor model list (re-discovers via the active SDK or CLI backend)",
    handler: async (_args, ctx) => service.refresh(ctx),
  });

  // Report the active backend (SDK vs CLI/proxy), why, model source, auth,
  // proxy, runtime, and in-flight tool-bridge runs. Backend selection is
  // otherwise silent, so this is the go-to diagnostic.
  pi.registerCommand("cursor-status", {
    description: "Show Cursor backend status (SDK vs CLI, models, auth, proxy)",
    handler: async (_args, ctx) => {
      const content = `Cursor Bridge — status\n${getCursorStatusLines().map((l) => `  ${l}`).join("\n")}`;
      if (ctx.hasUI) {
        pi.sendMessage({ customType: "cursor-bridge", content, display: true });
      } else {
        console.log(`[cursor-bridge]\n${content}`);
      }
    },
  });

  // Read stored API key from Pi's AuthStorage at startup
  extractAuthKey();

  // Fast path: if another Pi instance already runs the proxy, attach to it
  // instead of trying to bind the port (which would EADDRINUSE).
  if (await detectExistingProxy({ host: HOST, port: PORT, serviceId: HEALTH_SERVICE_ID })) {
    await service.attachToExistingProxy("another Pi instance owns the port");
    return;
  }

  try {
    const server = startProxyServer({
      modelsFn: service.getModels,
      catalog: modelCatalog,
      getAuthKey: () => cachedAuthKey,
      host: HOST,
      healthServiceId: HEALTH_SERVICE_ID,
      getLiveRunsCount: () => cursorLiveRuns.size,
    });

    await new Promise((resolve, reject) => {
      const onListening = () => {
        server.removeListener("error", onError);
        globalThis.__piCursorBridgeServer = server;
        resolve();
      };
      const onError = (err) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      server.once("listening", onListening);
      server.once("error", onError);
      server.listen(PORT, HOST);
    });

    cursorStatus.proxy = `http://${HOST}:${PORT}/v1 (owned)`;

    // Prefer the @cursor/sdk backend for Pi (reliable structured model routing).
    // The proxy server above keeps running for non-Pi OpenAI clients regardless.
    const sdkResult = await tryRegisterSdkProvider(pi);

    if (!sdkResult) {
      const models = await service.getModels();
      const modelConfigs = buildModelConfigs(models);
      registerCursorProvider(pi, modelConfigs);
      cursorStatus.backend = "CLI/proxy";
      cursorStatus.modelCount = modelConfigs.length;
      cursorStatus.modelSource =
        service.origin === "disk" ? "disk cache"
        : service.origin === "cli" ? "cursor-agent CLI"
        : service.origin === "stale-disk" ? "stale disk cache"
        : service.origin === "fallback" ? "built-in fallback"
        : "cursor-agent CLI";
    }
    startupLog = { lines: buildStartupLogLines() };
  } catch (err) {
    // Race: another Pi instance bound the port between our probe and
    // our listen(). Fall back to client-only mode so the user still
    // gets cursor-bridge models instead of a hard failure.
    if (err && err.code === "EADDRINUSE" && (await detectExistingProxy({ host: HOST, port: PORT, serviceId: HEALTH_SERVICE_ID }))) {
      await service.attachToExistingProxy("port became busy during startup");
      return;
    }
    startupLog = { error: err.message };
  }
}
