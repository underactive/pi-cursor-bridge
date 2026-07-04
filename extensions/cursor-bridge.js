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
let enhanceBridgeInputSchema, enhanceBridgeToolDescription, bridgeToolSteeringHints, normalizeBridgeToolArgs;

async function loadSdkHelpers() {
  const selfReal = fs.realpathSync(fileURLToPath(import.meta.url));
  const helpersPath = path.join(path.dirname(selfReal), "..", "lib", "cursor-helpers.js");
  const helpers = await import(pathToFileURL(helpersPath).href);
  ({ collectSdkImages, isSdkRejection, makeSdkDeferred, sanitizeSdkError, estimateConversationTokens, rebaseSdkUsageFields,
    enhanceBridgeInputSchema, enhanceBridgeToolDescription, bridgeToolSteeringHints, normalizeBridgeToolArgs } = helpers);
}

// ─── Session Management ──────────────────────────────────────────────────────

/**
 * Default session idle timeout (5 minutes in ms).
 * After this period of inactivity, the session and its subprocess are
 * released. Configurable via PI_CURSOR_SESSION_TIMEOUT_MS.
 */
const DEFAULT_SESSION_TIMEOUT_MS = 300_000;

function getSessionTimeout() {
  const env = process.env.PI_CURSOR_SESSION_TIMEOUT_MS;
  if (env) {
    const n = parseInt(env, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return DEFAULT_SESSION_TIMEOUT_MS;
}

/**
 * Tracks one cursor-agent session: the pinned model id and the live subprocess
 * for an `X-Session-Id` conversation, plus idle-timeout bookkeeping. Prompt
 * text is always rebuilt from the request body (OpenAI convention), so no
 * message history or cumulative usage is retained here.
 */
class CursorSession {
  /**
   * @param {string} sessionId — UUID or caller-provided session identifier
   * @param {string} modelId — resolved cursor-agent model ID (--model arg)
   */
  constructor(sessionId, modelId) {
    this.sessionId = sessionId;
    this.modelId = modelId;
    this.subprocessRef = null;
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
  }

  touch() { this.lastActivityAt = Date.now(); }

  isExpired(timeoutMs) {
    const ttl = timeoutMs ?? getSessionTimeout();
    return Date.now() - this.lastActivityAt > ttl;
  }
}

/**
 * Manages the lifecycle of all active CursorSession instances.
 */
class SessionManager {
  constructor() {
    this._sessions = new Map();
    this._releaseTimers = new Map();
  }

  getOrCreateSession(sessionId, modelId) {
    if (!sessionId) {
      return new CursorSession("", modelId);
    }

    let session = this._sessions.get(sessionId);
    if (session) {
      const timer = this._releaseTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        this._releaseTimers.delete(sessionId);
      }
      session.touch();
      return session;
    }

    session = new CursorSession(sessionId, modelId);
    this._sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId) {
    return this._sessions.get(sessionId) ?? null;
  }

  releaseSession(sessionId, timeoutMs) {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    if (this._releaseTimers.has(sessionId)) return;

    const ttl = timeoutMs ?? getSessionTimeout();
    const timer = setTimeout(() => {
      this._cleanupSession(sessionId);
    }, ttl);

    if (timer.unref) timer.unref();
    this._releaseTimers.set(sessionId, timer);
  }

  removeSession(sessionId) {
    this._cleanupSession(sessionId);
  }

  cleanup(timeoutMs) {
    const ttl = timeoutMs ?? getSessionTimeout();
    const now = Date.now();
    for (const [id, session] of this._sessions) {
      if (now - session.lastActivityAt > ttl) {
        this._cleanupSession(id);
      }
    }
  }

  destroy() {
    for (const [id] of this._sessions) {
      this._cleanupSession(id);
    }
    for (const [id, timer] of this._releaseTimers) {
      clearTimeout(timer);
      this._releaseTimers.delete(id);
    }
  }

  _cleanupSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    const child = session.subprocessRef;
    if (child && !child.killed) {
      try { child.kill(); } catch {}
    }

    const timer = this._releaseTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this._releaseTimers.delete(sessionId);
    }

    this._sessions.delete(sessionId);
  }
}

// ─── Config ───────────────────────────────────────────────────────────

const PORT = 32124;
const HOST = "127.0.0.1";
const PROVIDER_ID = "cursor-bridge";
const HEALTH_SERVICE_ID = "cursor-bridge";
// L3: cap the buffered stdout of a non-streaming cursor-agent reply (16 MiB).
const MAX_NONSTREAM_STDOUT_BYTES = 16 * 1024 * 1024;

/**
 * Resolve the cursor-agent binary path.
 */
function resolveCursorAgent() {
  const envPath = process.env.PI_CURSOR_AGENT_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const candidates = [
    path.join(home, ".local", "bin", "cursor-agent"),
    path.join(home, ".cursor", "bin", "cursor-agent"),
    "/usr/local/bin/cursor-agent",
    "/opt/homebrew/bin/cursor-agent",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "cursor-agent";
}

function cursorAgentPath() {
  return process.env.PI_CURSOR_AGENT_PATH || resolveCursorAgent();
}

// ─── Cache Infrastructure ────────────────────────────────────────────────

/**
 * Default TTL for the disk model cache (24 hours in ms).
 */
const DEFAULT_CACHE_TTL_MS = 86_400_000;

/**
 * Cache file format version. Bump if the on-disk schema changes.
 */
const CACHE_FORMAT_VERSION = 2;

/**
 * Whether the disk model cache is disabled.
 */
const DISABLE_MODEL_CACHE = process.env.PI_CURSOR_DISABLE_MODEL_CACHE === "1";

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
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    const authPath = path.join(home, ".pi", "agent", "auth.json");
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

/**
 * Resolve the cache TTL from env var or default (24h).
 */
function getCacheTTL() {
  const env = process.env.PI_CURSOR_MODEL_CACHE_TTL_MS;
  if (env) {
    const n = parseInt(env, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return DEFAULT_CACHE_TTL_MS;
}

/**
 * Resolve the cache file path: ~/.pi/agent/cursor-bridge-model-cache.json
 */
function getCacheFilePath() {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return path.join(home, ".pi", "agent", "cursor-bridge-model-cache.json");
}

/**
 * Read Cursor auth state and return a SHA-256 hex hash.
 *
 * Sources (in priority order):
 *   1. CURSOR_API_KEY env var
 *   2. ~/.pi/agent/auth.json (Pi AuthStorage — populated by /login)
 *   3. ~/.cursor/cli-config.json (authInfo + serverConfigCache)
 *   4. Unauthenticated sentinel
 *
 * @returns {string} hex-encoded SHA-256 hash
 */
function getAuthHash() {
  // L4 — auth-source layering (intentional precedence):
  //   1. CURSOR_API_KEY env — an explicit override always wins.
  //   2. Pi-stored key from /login (`pikey:`) — the Pi-native default (Phase 5).
  //   3. ~/.cursor/cli-config.json — the cursor-agent CLI's own login.
  //   4. "unauthenticated" sentinel.
  // This hash only keys the on-disk model cache, so env-first is safe: a user
  // who sets the env var is deliberately choosing that identity for caching.
  const apiKey = process.env.CURSOR_API_KEY;
  if (apiKey) {
    return crypto.createHash("sha256").update(`apikey:${apiKey}`).digest("hex");
  }

  // Pi-stored API key (from /login)
  if (cachedAuthKey) {
    return crypto.createHash("sha256").update(`pikey:${cachedAuthKey}`).digest("hex");
  }

  try {
    const cliConfigPath = path.join(
      process.env.HOME || process.env.USERPROFILE || "/tmp",
      ".cursor",
      "cli-config.json"
    );
    const cliConfig = JSON.parse(fs.readFileSync(cliConfigPath, "utf8"));
    const authInfo = cliConfig.authInfo || {};
    const serverConfig = cliConfig.serverConfigCache || {};
    const input = JSON.stringify(authInfo) + "|" + JSON.stringify(serverConfig);
    return crypto.createHash("sha256").update(input).digest("hex");
  } catch {
    // No ~/.cursor/cli-config.json or parse error — use sentinel
    return crypto.createHash("sha256").update("unauthenticated").digest("hex");
  }
}

/**
 * Load model cache from disk.
 *
 * Reads the cache file, finds the entry for the current auth hash,
 * and returns it if valid. When allowStale is false (default), returns
 * null for expired entries (beyond TTL). When allowStale is true, returns
 * the cached entry regardless of age — useful for CLI-fallback when the
 * primary fetch fails.
 *
 * Returns null on any other failure (missing file, corrupt JSON,
 * no matching entry).
 *
 * @param {{ allowStale?: boolean }} [options]
 * @returns {{ models: Array, cachedAt: number } | null}
 */
function loadModelCache(options = {}) {
  if (DISABLE_MODEL_CACHE) return null;

  let raw;
  try {
    raw = fs.readFileSync(getCacheFilePath(), "utf8");
  } catch {
    return null; // ENOENT or permission error — no cache
  }

  let cache;
  try {
    cache = JSON.parse(raw);
  } catch {
    // Corrupt cache file — delete it to prevent repeat errors
    try { fs.unlinkSync(getCacheFilePath()); } catch {}
    return null;
  }

  if (!cache || cache.formatVersion !== CACHE_FORMAT_VERSION) return null;

  const authHash = getAuthHash();
  const entry = cache.entries?.[authHash];
  if (!entry || !Array.isArray(entry.models)) return null;

  const ttl = getCacheTTL();
  const age = Date.now() - entry.cachedAt;
  if (!options.allowStale && age > ttl) return null;

  return { models: entry.models, cachedAt: entry.cachedAt };
}

/**
 * Save model cache to disk.
 *
 * Reads existing cache, updates the entry for the current auth hash,
 * purges stale entries, and writes back. Fire-and-forget — caller
 * should not await.
 *
 * @param {Array<{ id: string, name?: string, object?: string, owned_by?: string }>} models
 * @param {string} [cliVersion] — cursor-agent CLI version string (for debugging)
 * @returns {Promise<void>}
 */
async function saveModelCache(models, cliVersion) {
  if (DISABLE_MODEL_CACHE || !Array.isArray(models) || models.length === 0) return;

  const filePath = getCacheFilePath();
  const authHash = getAuthHash();
  const ttl = getCacheTTL();

  // Read existing cache (ignore errors — we'll create from scratch)
  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    cache = { formatVersion: CACHE_FORMAT_VERSION, entries: {} };
  }

  if (!cache.entries) cache.entries = {};
  if (!cache.formatVersion) cache.formatVersion = CACHE_FORMAT_VERSION;

  // Update entry for current auth
  cache.entries[authHash] = {
    cachedAt: Date.now(),
    cliVersion: cliVersion || "",
    models: models.map(m => ({
      id: m.id,
      name: m.name || m.id,
      contextWindow: m.contextWindow ?? null,
      maxTokens: m.maxTokens ?? null,
      object: m.object || "model",
      owned_by: m.owned_by || "cursor",
    })),
  };

  // Purge entries older than 2x TTL to prevent unbounded growth
  const cutoff = Date.now() - 2 * ttl;
  for (const hash of Object.keys(cache.entries)) {
    if (cache.entries[hash].cachedAt < cutoff) {
      delete cache.entries[hash];
    }
  }

  // Ensure directory exists
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch {}

  // Write atomically via temp file
  const tmpPath = filePath + ".tmp";
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    console.error("[cursor-bridge] Failed to write model cache:", err.message);
  }
}

/**
 * Parse a context window size from a cursor-agent model display name.
 *
 * Display names include context annotations like "1M", "400K", or omit
 * them for the default 200K. Examples:
 *   "Opus 4.8 1M" → 1_000_000
 *   "GPT-5.5 1M High" → 1_050_000
 *   "Sonnet 4.6 1M" → 1_000_000
 *   "Codex 5.3 Low" → 400_000 (no annotation = ~200K default, but family has 400K)
 *
 * When the display name contains an explicit "N<unit>" token, parse it.
 * Otherwise return null so the caller can fall back to the static map.
 *
 * @param {string} displayName — the human-readable model name (second column from --list-models)
 * @returns {number|null} — context window or null if no annotation found
 */
function parseContextFromDisplayName(displayName) {
  if (!displayName) return null;
  // Match patterns like "1M", "400K" (case-insensitive) as standalone tokens
  const m = displayName.match(/(\d+)([kKmM])\b/);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit === "m") {
    return num * 1_000_000;
  }
  return num * 1_000;
}

/**
 * Run cursor-agent in "list models" mode with enhanced parsing.
 *
 * Parses context window sizes from display names where available,
 * so dynamic models get accurate context windows without manual
 * map updates.
 */
async function fetchCursorModels() {
  return new Promise((resolve, reject) => {
    const child = spawn(cursorAgentPath(), ["models", "--trust"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: cachedAuthKey
        ? { ...process.env, CURSOR_API_KEY: cachedAuthKey }
        : { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`cursor-agent models exited ${code}: ${stderr.trim()}`));
        return;
      }
      const models = [];
      for (const line of stdout.split("\n")) {
        const m = line.match(/^([a-z0-9][a-z0-9._-]+)\s+-\s+(.+?)(?:\s+\((?:current|default)\))?\s*$/i);
        if (m) {
          const id = m[1];
          const name = m[2].trim();
          const cw = parseContextFromDisplayName(name);
          models.push({
            id,
            name,
            contextWindow: cw,
            maxTokens: cw ? Math.min(cw, DEFAULT_MAX_TOKENS) : null,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "cursor",
          });
        }
      }
      resolve(models);
    });
    child.stdin.end();
  });
}

/**
 * Build a text prompt from OpenAI-format messages that cursor-agent
 * can understand.
 */
function buildPromptFromMessages(messages) {
  const parts = [];
  for (const msg of messages) {
    const role = msg.role || "user";
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    }
    if (!content) continue;
    if (role === "system") {
      parts.push(`<|im_start|>system\n${content}\n<|im_end|>`);
    } else if (role === "user") {
      parts.push(`<|im_start|>user\n${content}\n<|im_end|>`);
    } else if (role === "assistant") {
      parts.push(`<|im_start|>assistant\n${content}\n<|im_end|>`);
    } else if (role === "tool") {
      const toolName = msg.name ? ` (${msg.name})` : "";
      parts.push(`<|im_start|>tool${toolName}\n${content}\n<|im_end|>`);
    }
  }
  return parts.join("\n");
}

function normalizeModel(modelId) {
  if (!modelId) return "auto";
  return modelId.replace(/^cursor-bridge\//, "").replace(/@[a-z0-9]+$/, "");
}

// ─── Model Family Detection ─────────────────────────────────────────────

/**
 * Known effort level tokens, ordered longest-first for greedy matching.
 * These appear as suffixes in cursor-agent model IDs.
 */
const EFFORT_TOKENS = ["extra-high", "xhigh", "medium", "high", "low", "none", "max"];

/**
 * Suffix string appended to an effort-tier model to indicate a thinking variant,
 * e.g. `claude-4.6-sonnet-medium-thinking`.
 */
const THINKING_SUFFIX = "-thinking";

/**
 * Parse a raw cursor-agent model ID into its constituent parts.
 *
 * Returns `null` for models that cannot be parsed (no effort token detected),
 * UNLESS the model is a boolean-thinking variant (e.g. `claude-4.5-sonnet-thinking`)
 * where the `-thinking` suffix alone signals the thinking variant.
 *
 * @param {string} modelId — raw model ID from cursor-agent (e.g. "gpt-5.5-high")
 * @returns {{ base: string, effort: string|null, isThinking: boolean, isFast: boolean, originalModelId: string } | null}
 */
function parseModelId(modelId) {
  if (!modelId || modelId === "auto") return null;

  // 0. Strip @ context suffix (Pi model ID convention, before any parsing)
  let id = modelId;
  const contextSuffix = extractContextSuffix(id);
  if (contextSuffix) {
    id = stripContextSuffix(id);
  }

  // 1. Strip -fast suffix (orthogonal speed modifier, deferred)
  let isFast = false;
  if (id.endsWith("-fast")) {
    id = id.slice(0, -5);
    isFast = true;
  }

  // 2. Detect -thinking suffix (thinking variant appended to an effort tier)
  let hasThinkingSuffix = false;
  if (id.endsWith(THINKING_SUFFIX)) {
    hasThinkingSuffix = true;
    id = id.slice(0, -THINKING_SUFFIX.length);
  }

  // 3. Try to match an effort token from the right
  for (const token of EFFORT_TOKENS) {
    const suffix = `-${token}`;
    if (id.endsWith(suffix)) {
      const base = id.slice(0, -suffix.length);
      if (!base) continue;

      // 4. Detect thinking infix/suffix in the base.
      //    -thinking- (with trailing dash): e.g. "claude-opus-4-7-thinking-high"
      //    -thinking at end: effort was stripped after thinking infix
      let baseName = base;
      let isThinkingInfix = false;

      const thinkingInfixPattern = "-thinking-";
      const tiIdx = base.lastIndexOf(thinkingInfixPattern);
      if (tiIdx !== -1) {
        baseName = base.slice(0, tiIdx);
        isThinkingInfix = true;
      } else {
        const thinkingSuffixOnBase = "-thinking";
        if (base.endsWith(thinkingSuffixOnBase) && base.length > thinkingSuffixOnBase.length) {
          const tsIdx = base.lastIndexOf(thinkingSuffixOnBase);
          const beforeThinking = base.slice(0, tsIdx);
          if (beforeThinking && beforeThinking.length > 0 && beforeThinking.includes("-")) {
            baseName = beforeThinking;
            isThinkingInfix = true;
          }
        }
      }

      const family = isThinkingInfix ? `${baseName}-thinking` : baseName;

      return {
        base: family,
        effort: token,
        isThinking: isThinkingInfix || hasThinkingSuffix,
        originalModelId: modelId,
        isFast,
      };
    }
  }

  // 5. Boolean-thinking model: -thinking suffix, no effort token
  //    e.g. "claude-4.5-sonnet-thinking"
  if (hasThinkingSuffix && id) {
    if (id.indexOf("-") !== -1 || /^[a-z]/.test(id)) {
      return {
        base: id,
        effort: null,
        isThinking: true,
        originalModelId: modelId,
        isFast,
      };
    }
  }

  // No effort token found — standalone model
  return null;
}

/**
 * Group raw cursor-agent model objects into families and build the variant map.
 *
 * @param {Array<{ id: string }>} models — raw model objects from fetchCursorModels()
 * @returns {{ families: Map<string, object>, variantMap: object, standaloneModels: string[] }}
 */
function buildModelFamilies(models) {
  const families = new Map();
  const variantMap = {};
  const standaloneSet = new Set();
  let standaloneModels = [];

  // Phase 1: Parse each model and group into families
  for (const m of models) {
    if (!m.id || m.id.startsWith("_")) continue;
    const parsed = parseModelId(m.id);
    if (!parsed) { standaloneSet.add(m.id); continue; }

    const { base, effort, isThinking, originalModelId } = parsed;

    if (!families.has(base)) {
      families.set(base, {
        variants: {},
        thinkingVariants: {},
        booleanThinkingVariant: null,
        hasNonThinking: false,
      });
    }

    const family = families.get(base);
    if (isThinking && effort === null) {
      family.booleanThinkingVariant = originalModelId;
    } else if (isThinking) {
      family.thinkingVariants[effort] = originalModelId;
    } else {
      family.variants[effort] = originalModelId;
      family.hasNonThinking = true;
    }
  }

  // Phase 2: Build variantMap from families
  for (const [base, family] of families) {
    const entry = { variants: {}, thinkingVariants: {}, defaultVariant: null };
    Object.assign(entry.variants, family.variants);
    Object.assign(entry.thinkingVariants, family.thinkingVariants);

    if (family.booleanThinkingVariant) {
      entry.thinkingVariants.on = family.booleanThinkingVariant;
    }

    const vKeys = Object.keys(entry.variants);
    const tKeys = Object.keys(entry.thinkingVariants);

    if (entry.variants.medium) entry.defaultVariant = entry.variants.medium;
    else if (entry.variants.high) entry.defaultVariant = entry.variants.high;
    else if (vKeys.length > 0) entry.defaultVariant = entry.variants[vKeys[0]];
    else if (tKeys.length > 0) entry.defaultVariant = entry.thinkingVariants[tKeys[0]];

    if (vKeys.length > 0 || tKeys.length > 0) {
      variantMap[base] = entry;
    } else {
      standaloneSet.add(base);
    }
  }

  // Phase 3: Link standalone models that match family base names
  //          and resolve boolean-thinking linking.
  standaloneModels = [...standaloneSet];
  for (const [base, family] of families) {
    const entry = variantMap[base];
    if (!entry) continue;

    // If a standalone model shares the base name, link it into the family
    const ntIdx = standaloneModels.indexOf(base);
    if (ntIdx !== -1) {
      entry.variants.off = base;
      entry.defaultVariant = base;
      standaloneModels.splice(ntIdx, 1);
    }

    // Boolean-thinking models with no standalone base get custom linking
    if (family.booleanThinkingVariant && family.hasNonThinking === false && !entry.variants.off) {
      // No stand-alone base model — the thinking variant is the only member.
      // Keep the current default (thinking variant) but flag it as "on" only.
    }
  }

  return { families, variantMap, standaloneModels };
}

/**
 * Determine if a model has a family that supports reasoning.
 */
function supportsReasoning(modelId, familyData) {
  const parsed = parseModelId(modelId);
  if (parsed && familyData.variantMap[parsed.base]) {
    const entry = familyData.variantMap[parsed.base];
    return Object.keys(entry.variants).length >= 1 || Object.keys(entry.thinkingVariants).length >= 1;
  }
  return false;
}

/**
 * Resolve the effective cursor-agent model ID given a collapsed family ID
 * and an optional reasoning_effort value from the request body.
 *
 * @param {string} familyId — collapsed base model ID (without variant suffix)
 * @param {string|undefined} reasoningEffort — reasoning_effort from request body
 * @param {object} variantMap — from buildModelFamilies()
 * @returns {string|null} — resolved model ID, or null if no match
 */
function resolveModelVariant(familyId, reasoningEffort, variantMap) {
  const entry = variantMap[familyId];
  if (!entry) return null;

  // No reasoning_effort or "off": use default non-thinking variant
  if (!reasoningEffort || reasoningEffort === "off") {
    return entry.defaultVariant || null;
  }

  // reasoning_effort present and not "off": try thinking variant first
  if (entry.thinkingVariants[reasoningEffort]) {
    return entry.thinkingVariants[reasoningEffort];
  }

  // Fall back to non-thinking variant at this effort
  if (entry.variants[reasoningEffort]) {
    return entry.variants[reasoningEffort];
  }

  return null;
}

/**
 * Parse common cursor-agent errors into user-friendly messages.
 */
function formatCursorError(stderr) {
  const lower = stderr.toLowerCase();
  if (lower.includes("quota")) {
    return "Quota exceeded. Check your Cursor subscription at cursor.com/settings.";
  }
  if (lower.includes("auth") || lower.includes("login")) {
    return "Authentication failed. Run: cursor-agent login";
  }
  if (lower.includes("rate")) {
    return "Rate limited. Please wait and try again.";
  }
  if (lower.includes("model") && lower.includes("not found")) {
    return "Model not found. Check the model name.";
  }
  return `cursor-bridge error: ${stderr}`;
}

// ─── Chat completions handler ─────────────────────────────────────────

/**
 * Module-level session manager instance, set when the proxy server starts.
 * The handler reads the X-Session-Id header to route requests to the
 * appropriate session for multi-turn conversations.
 * @type {SessionManager|null}
 */
let activeSessionManager = null;

function handleChatCompletions(req, res) {
  let body = "";
  req.on("data", (c) => (body += c.toString()));
  req.on("end", () => {
    let requestBody;
    try {
      requestBody = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    const { messages, stream, model, reasoning_effort } = requestBody;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "messages is required" }));
      return;
    }

    // Session routing: optional X-Session-Id header enables multi-turn
    const sessionId = req.headers["x-session-id"] || "";

    let cursorModel = normalizeModel(model);

    // Always attempt model ID resolution for collapsed families.
    // cursor-agent only knows specific variant IDs (e.g. "gpt-5.5-high"),
    // not family base names (e.g. "gpt-5.5"). resolveModelVariant handles
    // both with and without reasoning_effort — when absent, it returns
    // the default variant.
    // L5: snapshot the variant map once. /cursor-refresh-models reassigns the
    // global mid-flight; capturing a stable reference here keeps this request
    // reading one consistent map instead of a half-cleared one.
    const variantMap = (typeof __variantMap !== "undefined") ? __variantMap : null;
    if (variantMap) {
      const resolved = resolveModelVariant(cursorModel, reasoning_effort, variantMap);
      if (resolved) {
        cursorModel = resolved;
      }
    }

    // Resolve or create session. For sessionless requests, cursorModel is
    // re-resolved each time and no subprocess is persisted.
    const session = activeSessionManager
      ? activeSessionManager.getOrCreateSession(sessionId, cursorModel)
      : null;

    // Model is pinned at session creation (getOrCreateSession sets modelId and
    // never overwrites it on reuse), so subsequent turns reuse the first turn's
    // resolved id for cross-turn consistency.
    const effectiveModel = (session && session.modelId) ? session.modelId : cursorModel;

    const id = `cursor-bridge-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    // Always spawn a fresh subprocess per request. cursor-agent reads stdin
    // until EOF, so we must close stdin after writing the prompt to signal
    // that input is complete. The subprocess exits after processing.
    const args = [
      "--output-format", "stream-json",
      "--model", effectiveModel, "--trust", "--force",
    ];
    if (stream) {
      args.push("--stream-partial-output");
    }

    const child = spawn(cursorAgentPath(), args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: cachedAuthKey
        ? { ...process.env, CURSOR_API_KEY: cachedAuthKey }
        : { ...process.env },
    });

    if (session) {
      session.subprocessRef = child;
    }

    // Build prompt from the request body messages (OpenAI API convention sends
    // the full conversation history on every request).
    const prompt = buildPromptFromMessages(messages);
    child.stdin.write(prompt);
    child.stdin.end();

    if (stream) {
      // ── Streaming ──
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // M2: if the client drops the connection mid-stream, kill the subprocess
      // instead of leaking it until the idle timer. writableFinished distinguishes
      // the normal-completion close (res.end already ran) from a real disconnect.
      res.on("close", () => {
        if (res.writableFinished) return;
        if (child && !child.killed) {
          child.kill();
          console.log("[cursor-bridge] child killed on client close");
        }
      });

      // With --stream-partial-output, assistant events are usually incremental
      // deltas; the stream may end with one cumulative snapshot. Track assembled
      // text so we only forward the new suffix and skip duplicate finals.
      let assembledText = "";
      let usage = null;
      child.stderr.on("data", () => { /* errors surfaced via [DONE] for now */ });

      const writeChunk = (content) => {
        if (!content || res.writableEnded) return; // M2: guard post-close EPIPE
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: cursorModel, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
      };

      const forwardAssistantText = (text) => {
        if (!text) return;
        let delta;
        if (text.startsWith(assembledText)) {
          delta = text.slice(assembledText.length);
          assembledText = text;
        } else {
          delta = text;
          assembledText += text;
        }
        writeChunk(delta);
      };

      const handleStreamEvent = (event) => {
        if (event.type === "thinking") {
          // Forward thinking content as reasoning_content delta
          const content = event.content || event.text || "";
          if (content) {
            res.write(`data: ${JSON.stringify({
              id, object: "chat.completion.chunk", created, model: cursorModel,
              choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }]
            })}\n\n`);
          }
          return;
        }

        if (event.type === "tool_call") {
          // Forward tool call as SSE tool_calls delta
          const toolCallPayload = {
            id, object: "chat.completion.chunk", created, model: cursorModel,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: event.id || event.toolCallId || `call_${Date.now()}`,
                  type: "function",
                  function: {
                    name: event.name || event.function?.name || "",
                    arguments: event.arguments || event.function?.arguments || JSON.stringify(event.input || {}),
                  },
                }],
              },
              finish_reason: null,
            }],
          };
          res.write(`data: ${JSON.stringify(toolCallPayload)}\n\n`);
          return;
        }

        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type !== "text" || !block.text) continue;
            forwardAssistantText(block.text);
          }
        }

        if (event.type === "result") {
          usage = event.usage || null;
        }
      };

      const lineBuffer = [];
      child.stdout.on("data", (d) => {
        const lines = (lineBuffer.join("") + d.toString()).split("\n");
        lineBuffer.length = 0;

        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            handleStreamEvent(JSON.parse(line));
          } catch { /* skip unparseable lines */ }
        }

        if (lines.length > 0) {
          const last = lines[lines.length - 1];
          if (last.trim()) lineBuffer.push(last);
        }
      });

      child.on("close", () => {
        // Clear subprocess ref so the next request spawns a fresh subprocess
        if (session) { session.subprocessRef = null; }

        for (const line of lineBuffer) {
          if (!line.trim()) continue;
          try {
            handleStreamEvent(JSON.parse(line.trim()));
          } catch {}
        }

        // Report THIS turn's usage. The proxy serves stateless OpenAI clients
        // that sum per-response usage, so a cumulative total would over-count.
        const finalUsage = usage || {};
        // M2: the client may have disconnected — only write if the response is open.
        if (!res.writableEnded) {
          if (finalUsage.inputTokens !== undefined || finalUsage.outputTokens !== undefined) {
            res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: cursorModel, choices: [], usage: { prompt_tokens: finalUsage.inputTokens ?? 0, completion_tokens: finalUsage.outputTokens ?? 0, total_tokens: (finalUsage.inputTokens ?? 0) + (finalUsage.outputTokens ?? 0), cache_read_tokens: finalUsage.cacheReadTokens ?? 0, cache_write_tokens: finalUsage.cacheWriteTokens ?? 0 } })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: cursorModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }

        // Start idle timeout for session release
        if (session && sessionId) {
          activeSessionManager?.releaseSession(sessionId);
        }
      });

      child.on("error", (err) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: cursorModel, choices: [{ index: 0, delta: { content: `cursor-bridge error: ${err.message}` }, finish_reason: "error" }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }
      });

    } else {
      // ── Non-streaming ──
      // M2: the whole reply is buffered until child close, so an early client
      // drop would otherwise leak the subprocess — kill it on disconnect.
      // writableFinished excludes the normal-completion close.
      res.on("close", () => {
        if (res.writableFinished) return;
        if (child && !child.killed) {
          child.kill();
          console.log("[cursor-bridge] child killed on client close");
        }
      });

      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      // L3: bound the buffered stdout. Model output is small in practice, but an
      // unbounded `+=` would let a pathological response grow memory without limit.
      child.stdout.on("data", (d) => {
        if (stdout.length >= MAX_NONSTREAM_STDOUT_BYTES) { stdoutTruncated = true; return; }
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => (stderr += d.toString()));

      child.on("close", (code) => {
        // Clear subprocess ref so the next request spawns a fresh subprocess
        if (session) { session.subprocessRef = null; }

        let assistantText = "";
        let thinkingText = "";
        let errorText = "";
        let usage = null;

        for (const line of stdout.trim().split("\n")) {
          try {
            const event = JSON.parse(line.trim());
            if (event.type === "thinking") {
              thinkingText += (event.content || event.text || "");
            }
            if (event.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === "text") assistantText = block.text;
              }
            }
            if (event.type === "result") {
              usage = event.usage || null;
              if (event.subtype === "rate_limited") {
                errorText = "Rate limited. Check your Cursor subscription.";
              }
            }
          } catch {}
        }

        if ((code !== 0 || !assistantText) && stderr.trim()) {
          errorText = formatCursorError(stderr.trim());
        }
        if (stdoutTruncated) {
          console.log(`[cursor-bridge] non-streaming stdout truncated at ${MAX_NONSTREAM_STDOUT_BYTES} bytes`);
        }

        // Report THIS turn's usage. The proxy serves stateless OpenAI clients
        // that sum per-response usage, so a cumulative total would over-count.
        const finalUsage = usage || {};

        const responseMessage = {
          role: "assistant",
          content: errorText || assistantText || "No response",
        };
        if (thinkingText) {
          responseMessage.reasoning_text = thinkingText;
        }

        const responsePayload = {
          id,
          object: "chat.completion",
          created,
          model: cursorModel,
          choices: [{ index: 0, message: responseMessage, finish_reason: errorText ? "error" : "stop" }],
        };
        if (finalUsage.inputTokens !== undefined || finalUsage.outputTokens !== undefined) {
          responsePayload.usage = {
            prompt_tokens: finalUsage.inputTokens ?? 0,
            completion_tokens: finalUsage.outputTokens ?? 0,
            total_tokens: (finalUsage.inputTokens ?? 0) + (finalUsage.outputTokens ?? 0),
            cache_read_tokens: finalUsage.cacheReadTokens ?? 0,
            cache_write_tokens: finalUsage.cacheWriteTokens ?? 0,
          };
        }
        // M2: skip the response write if the client already disconnected.
        if (!res.writableEnded) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(responsePayload));
        }

        // Start idle timeout for session release
        if (session && sessionId) {
          activeSessionManager?.releaseSession(sessionId);
        }
      });

      child.on("error", (err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Failed to spawn cursor-agent CLI: ${err.message}`, type: "server_error" } }));
      });
    }
  });
}

// ─── Peer discovery ───────────────────────────────────────────────────

/**
 * GET a small JSON document from the local proxy. Resolves to the parsed
 * body, or `null` if the request fails for any reason (no server, wrong
 * service, timeout, etc.). Used to detect a sibling Pi instance that
 * already owns the proxy port so we can run in client-only mode.
 */
function fetchLocalJson(pathname, timeoutMs = 750) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: HOST, port: PORT, path: pathname, method: "GET", timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try { resolve(JSON.parse(body)); }
          catch { resolve(null); }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * Probe http://127.0.0.1:32124/health and confirm a pi-cursor-bridge proxy
 * is already running there (vs. some unrelated service squatting on
 * the port). Returns true only when the running server identifies
 * itself as cursor-bridge.
 */
async function detectExistingProxy() {
  const health = await fetchLocalJson("/health");
  return !!(health && health.ok === true && health.service === HEALTH_SERVICE_ID);
}

// ─── HTTP Server ──────────────────────────────────────────────────────

function startProxyServer(modelsFn) {
  // Initialize the shared session manager for multi-turn conversations
  activeSessionManager = new SessionManager();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || HOST}`);

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if ((url.pathname === "/v1/models" || url.pathname === "/models") && req.method === "GET") {
        const models = await modelsFn();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: models }));
        return;
      }

      if ((url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") && req.method === "POST") {
        return handleChatCompletions(req, res);
      }

      if (url.pathname === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        // liveRuns drives the H1/H2 diagnostics: poll until it returns to 0.
        res.end(JSON.stringify({ ok: true, service: HEALTH_SERVICE_ID, liveRuns: cursorLiveRuns.size }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Not found: ${url.pathname}` }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  // Wrap server.close to destroy sessions before releasing the port
  const origClose_ = server.close.bind(server);
  server.close = (...args) => {
    if (activeSessionManager) activeSessionManager.destroy();
    return origClose_(...args);
  };

  return server;
}

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
  const payload = await fetchLocalJson("/v1/models", 2000);
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

/** Fetch the raw model catalog from the SDK. */
async function discoverSdkModels(apiKey) {
  const sdk = await loadCursorSdk();
  if (!sdk) throw new Error("@cursor/sdk not available");
  return sdk.Cursor.models.list({ apiKey });
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
  switch (update.type) {
    case "text-delta": liveRun.emitter.appendText(update.text); break;
    case "thinking-delta": liveRun.emitter.appendThinking(update.text); break;
    case "thinking-completed": liveRun.emitter.closeThinking(); break;
    case "turn-ended": if (update.usage) liveRun.lastUsage = update.usage; break;
    default: break; // tool-call-* deltas are emitted by bridgeExecute, not here
  }
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
  liveRun.onAbort = () => {
    if (liveRun.settled) return;
    liveRun.aborted = true;
    notifyCursor("Cursor run cancelled.");
    if (liveRun.run) { try { liveRun.run.cancel().catch(() => {}); } catch {} }
    finalizeBridge(liveRun, liveRun.sessionKey, null, makeSdkAbort(), liveRun.apiKey);
  };
  bindBridgeAbort(liveRun, options && options.signal);

  if (liveRun.aborted) { await turn.promise; return; }

  try {
    liveRun.agent = await sdk.Agent.create({
      apiKey,
      model: selection,
      mode: "agent",
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

  // Deliver the tool results Pi just produced to the waiting agent.
  const results = getTrailingToolResults(context);
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
    outputTokens = estimateSdkTokens(" ".repeat(outChars));
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

function registerCursorProvider(pi, modelConfigs) {
  pi.registerProvider(PROVIDER_ID, {
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
  });
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
    name: "Cursor Bridge",
    baseUrl: `http://${HOST}:${PORT}/v1`, // inert: SDK path bypasses HTTP
    apiKey: "$PI_CURSOR_AGENT_API_KEY",
    api: CURSOR_SDK_API,
    authHeader: false,
    streamSimple: streamCursorSdk,
    models: modelConfigs,
    compat: {
      supportsDeveloperRole: true,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      supportsUsageInStreaming: true,
    },
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

/** Render the current status as display lines (used by command + startup log). */
function getCursorStatusLines() {
  const authSource = cachedAuthKey
    ? "Pi AuthStorage (cursor-bridge)"
    : (process.env.CURSOR_API_KEY ? "CURSOR_API_KEY env" : "none");
  const sdkVersion = getSdkVersion();
  const rg = process.env.CURSOR_RIPGREP_PATH;
  return [
    `Backend:   ${cursorStatus.backend}`,
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
  const authSource = cachedAuthKey
    ? "Pi AuthStorage (cursor-bridge)"
    : (process.env.CURSOR_API_KEY ? "CURSOR_API_KEY env" : "none");
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

  let modelsCache = [];
  let modelsCacheTime = 0;
  let modelsCacheOrigin = null; // "disk" | "cli" | "stale-disk" | "fallback"
  // L4: in-memory de-dupe window for repeated getModels() calls within one Pi
  // session. Distinct from the on-disk DEFAULT_CACHE_TTL_MS (24 h) — renamed so
  // the two TTLs can't be confused.
  const MODEL_REFRESH_TTL_MS = 60_000;
  globalThis.__variantMap = {};          // populated alongside models
  globalThis.__modelContextWindows = {};  // cached per-model context windows

  // Register /cursor-refresh-models command early so it's available on all
  // startup paths (new proxy, peer-attach, and disabled). The handler
  // references getModels(), buildModelConfigs(), and registerCursorProvider()
  // which are all defined later in this closure but accessible at call time.
  pi.registerCommand("cursor-refresh-models", {
    description: "Refresh the Cursor model list (re-discovers via the active SDK or CLI backend)",
    handler: async (_args, ctx) => {
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
      globalThis.__variantMap = {};
      globalThis.__modelContextWindows = {};

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
    },
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

  async function getModels() {
    // Disk cache read: only on first call per extension lifecycle
    if (modelsCache.length === 0 && !DISABLE_MODEL_CACHE) {
      const diskEntry = loadModelCache();
      if (diskEntry) {
        modelsCache = diskEntry.models.map(m => ({
          ...m,
          created: Math.floor(Date.now() / 1000),
        }));
        const { variantMap: vm } = buildModelFamilies(modelsCache);
        globalThis.__variantMap = vm;
        globalThis.__modelContextWindows = buildModelContextWindows(modelsCache);
        modelsCacheTime = Date.now(); // reset so in-memory 60s TTL protects this session
        modelsCacheOrigin = "disk";
        return modelsCache;
      }
    }

    if (modelsCache.length > 0 && Date.now() - modelsCacheTime < MODEL_REFRESH_TTL_MS) {
      return modelsCache;
    }
    try {
      modelsCache = await fetchCursorModels();
      const { variantMap: vm } = buildModelFamilies(modelsCache);
      globalThis.__variantMap = vm;
      globalThis.__modelContextWindows = buildModelContextWindows(modelsCache);
      modelsCacheTime = Date.now();
      // Fire-and-forget: cache to disk after successful CLI fetch
      if (!DISABLE_MODEL_CACHE) {
        modelsCacheOrigin = "cli";
        saveModelCache(modelsCache).catch(() => {});
      }
    } catch (err) {
      console.error("[cursor-bridge] Failed to fetch models:", err.message);
      if (modelsCache.length === 0) {
        // Try stale disk cache before falling back to FALLBACK_MODELS
        if (!DISABLE_MODEL_CACHE) {
          const staleEntry = loadModelCache({ allowStale: true });
          if (staleEntry) {
            modelsCache = staleEntry.models.map(m => ({
              ...m,
              created: Math.floor(Date.now() / 1000),
            }));
            const { variantMap: vm } = buildModelFamilies(modelsCache);
            globalThis.__variantMap = vm;
            globalThis.__modelContextWindows = buildModelContextWindows(modelsCache);
            modelsCacheTime = staleEntry.cachedAt;
            modelsCacheOrigin = "stale-disk";
            return modelsCache;
          }
        }
        const fallback = FALLBACK_MODELS.map((id) => ({
          id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "cursor",
        }));
        modelsCache = fallback;
        const { variantMap: vm } = buildModelFamilies(fallback);
        globalThis.__variantMap = vm;
        globalThis.__modelContextWindows = buildModelContextWindows(fallback);
        modelsCacheOrigin = "fallback";
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
        const diskEntry = loadModelCache({ allowStale: true });
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

  // Fast path: if another Pi instance already runs the proxy, attach to it
  // instead of trying to bind the port (which would EADDRINUSE).
  if (await detectExistingProxy()) {
    await attachToExistingProxy("another Pi instance owns the port");
    return;
  }

  try {
    const server = startProxyServer(getModels);

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
      const models = await getModels();
      const modelConfigs = buildModelConfigs(models);
      registerCursorProvider(pi, modelConfigs);
      cursorStatus.backend = "CLI/proxy";
      cursorStatus.modelCount = modelConfigs.length;
      cursorStatus.modelSource =
        modelsCacheOrigin === "disk" ? "disk cache"
        : modelsCacheOrigin === "cli" ? "cursor-agent CLI"
        : modelsCacheOrigin === "stale-disk" ? "stale disk cache"
        : modelsCacheOrigin === "fallback" ? "built-in fallback"
        : "cursor-agent CLI";
    }
    startupLog = { lines: buildStartupLogLines() };
  } catch (err) {
    // Race: another Pi instance bound the port between our probe and
    // our listen(). Fall back to client-only mode so the user still
    // gets cursor-bridge models instead of a hard failure.
    if (err && err.code === "EADDRINUSE" && (await detectExistingProxy())) {
      await attachToExistingProxy("port became busy during startup");
      return;
    }
    startupLog = { error: err.message };
  }
}

// ─── Fallback model list ──────────────────────────────────────────────

const FALLBACK_MODELS = [
  "auto", "composer-2-fast", "composer-2", "composer-2.5", "composer-2.5-fast",
  "claude-opus-4-7-medium", "claude-opus-4-7-high", "claude-opus-4-7-xhigh",
  "claude-opus-4-7-thinking-high", "claude-opus-4-7-thinking-xhigh",
  "claude-4.6-opus-high", "claude-4.6-opus-high-thinking",
  "claude-4.6-sonnet-medium", "claude-4.6-sonnet-medium-thinking",
  "claude-4.5-sonnet", "claude-4.5-sonnet-thinking",
  "claude-4.5-opus-high", "claude-4.5-opus-high-thinking",
  "claude-4-sonnet", "claude-4-sonnet-thinking",
  "gpt-5.5-none", "gpt-5.5-low", "gpt-5.5-medium", "gpt-5.5-high", "gpt-5.5-extra-high",
  "gpt-5.4-medium", "gpt-5.4-high", "gpt-5.4-xhigh", "gpt-5.4-mini-medium", "gpt-5.4-nano-medium",
  "gpt-5.3-codex", "gpt-5.3-codex-high", "gpt-5.2", "gpt-5.2-codex",
  "gpt-5.1", "gpt-5.1-codex-max-medium", "gpt-5.1-codex-mini", "gpt-5-mini",
  "gemini-3.1-pro", "gemini-3-flash", "gemini-3.5-flash",
  "kimi-k2.5", "grok-4.3", "grok-build-0.1",
];

// ─── Context window & max tokens maps ────────────────────────────────────────

/**
 * Default context window for models not in MODEL_CONTEXT_WINDOWS.
 * Conservative: errs on early compaction rather than missed overflow.
 */
const FALLBACK_CONTEXT_WINDOW = 200000;

/**
 * Default max tokens for models not in MAX_TOKENS_MAP.
 */
const DEFAULT_MAX_TOKENS = 16384;

/**
 * Cursor models known to accept image input, keyed by SDK base id (the clean
 * ids Cursor.models.list() returns, e.g. "claude-opus-4-8" — not the CLI's
 * "claude-4.6-opus"). The SDK catalog exposes no vision flag, so capability is
 * declared, not detected. Unknown ids stay text-only (safe failure). Seeded
 * conservatively; codex, nano, auto, composer and kimi families omitted until
 * confirmed. Hand-maintained like MODEL_CONTEXT_WINDOWS; re-applied by
 * /cursor-refresh-models.
 *
 * SYNC (L6): when Cursor adds or renames a vision model, add its SDK base id
 * here. A missing id is treated as text-only (images are silently dropped), so
 * keep this list current as the catalog evolves.
 */
const VISION_CAPABLE_SDK_MODELS = new Set([
  // Claude — all 3+ tiers are multimodal (ids reconciled against Cursor.models.list()).
  "claude-fable-5", "claude-haiku-4-5",
  "claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8",
  "claude-sonnet-4", "claude-sonnet-4-5", "claude-sonnet-4-6",
  // GPT-5 family (codex/nano omitted — image support unconfirmed).
  "gpt-5-mini", "gpt-5.1", "gpt-5.2", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5",
  // Gemini (2.5+ multimodal).
  "gemini-2.5-flash", "gemini-3-flash", "gemini-3.1-pro", "gemini-3.5-flash",
  // Grok (grok-build omitted).
  "grok-4.3",
]);

/**
 * Per-model context window values.
 * Family-base keys cover all effort variants; standalone keys for raw IDs.
 *
 * SYNC (L6): hand-maintained — when Cursor ships a new model or changes a
 * window, add/adjust its key here. Unknown ids fall back to
 * FALLBACK_CONTEXT_WINDOW, so a missing entry degrades quietly rather than
 * erroring; keep it current as the catalog evolves.
 */
const MODEL_CONTEXT_WINDOWS = {
  // ── Claude families ──
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-7-thinking": 1_000_000,
  "claude-4.6-opus": 1_000_000,
  "claude-4.6-sonnet": 1_000_000,
  "claude-fable-5": 1_000_000,
  "claude-4.5-opus": 200_000,
  "claude-4.5-sonnet": 200_000,
  "claude-4-sonnet": 200_000,
  // ── GPT families ──
  "gpt-5.5": 1_050_000,
  "gpt-5.4": 1_050_000,
  "gpt-5.4-mini": 1_050_000,
  "gpt-5.4-nano": 1_050_000,
  "gpt-5.3-codex": 400_000,
  "gpt-5.1-codex-max": 400_000,
  // ── Standalone models ──
  "gemini-3.1-pro": 1_000_000,
  "gemini-3-flash": 1_000_000,
  "gemini-3.5-flash": 1_048_576,
  "grok-4.3": 1_000_000,
  "grok-build-0.1": 1_000_000,
  "kimi-k2.5": 256_000,
  "gpt-5.2": 400_000,
  "gpt-5.2-codex": 400_000,
  "gpt-5.1": 128_000,
  "gpt-5.1-codex-mini": 400_000,
  "gpt-5-mini": 400_000,
  "composer-2": 200_000,
  "composer-2.5": 200_000,
  "auto": 200_000,
};

/**
 * Per-model max tokens values.
 * Derives all keys from MODEL_CONTEXT_WINDOWS with the default value.
 */
const MAX_TOKENS_MAP = Object.fromEntries(
  Object.keys(MODEL_CONTEXT_WINDOWS).map(k => [k, DEFAULT_MAX_TOKENS])
);

// ─── @ context-suffix helpers ────────────────────────────────────────────────

/**
 * Convert a numeric context window to a human-readable suffix.
 * @param {number} cw — context window value
 * @returns {string} e.g. "1m", "400k"
 */
function contextWindowToSuffix(cw) {
  if (cw >= 1_000_000) return "1m";
  if (cw >= 500_000) return `${Math.round(cw / 1000)}k`;
  return `${Math.round(cw / 1000)}k`;
}

/**
 * Parse a context suffix like "1m" or "272k" into a numeric value.
 * @param {string} suffix — context suffix (with or without leading @)
 * @returns {number}
 */
function parseContextWindow(suffix) {
  if (!suffix) return FALLBACK_CONTEXT_WINDOW;
  const s = suffix.replace(/^@/, "");
  const m = s.match(/^(\d+)([km])$/i);
  if (!m) return FALLBACK_CONTEXT_WINDOW;
  const num = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  return unit === "m" ? num * 1_000_000 : num * 1_000;
}

/**
 * Strip @ context suffix from a model ID.
 * @param {string} modelId
 * @returns {string}
 */
function stripContextSuffix(modelId) {
  if (!modelId) return modelId;
  return modelId.replace(/@[a-z0-9]+$/, "");
}

/**
 * Extract the @ context suffix from a model ID.
 * @param {string} modelId
 * @returns {string|null} e.g. "@1m", "@272k", or null
 */
function extractContextSuffix(modelId) {
  if (!modelId) return null;
  const m = modelId.match(/@[a-z0-9]+$/);
  return m ? m[0] : null;
}

// ─── Model context window cache builder ─────────────────────────────────────

/**
 * Build a cache mapping each model ID to its context window.
 * Used for quick runtime lookup without re-parsing the model ID.
 * @param {Array<{id: string}>} models — raw model objects from cursor-agent or FALLBACK_MODELS
 * @returns {Record<string, number>}
 */
function buildModelContextWindows(models) {
  const cwCache = {};
  for (const m of models) {
    // Prefer per-model contextWindow from CLI display-name parsing
    if (m.contextWindow) {
      cwCache[m.id] = m.contextWindow;
      continue;
    }
    const parsed = parseModelId(m.id);
    let key;
    if (parsed) {
      key = parsed.base;
    } else {
      // Strip -fast for standalone model lookup (matches standalone loop in buildModelConfigs)
      key = m.id.endsWith("-fast") ? m.id.slice(0, -5) : m.id;
    }
    cwCache[m.id] = MODEL_CONTEXT_WINDOWS[key] ?? FALLBACK_CONTEXT_WINDOW;
  }
  return cwCache;
}

/**
 * Fallback context window map: maps every FALLBACK_MODELS ID to its
 * context window, resolved through family-base or standalone key lookup.
 * Ensures every fallback model ID has an accurate context window even
 * when the live cursor-agent models fetch fails.
 */
const FALLBACK_MODEL_CONTEXT_WINDOWS = Object.fromEntries(
  FALLBACK_MODELS.map(id => {
    const parsed = parseModelId(id);
    const key = parsed ? parsed.base : id;
    return [id, MODEL_CONTEXT_WINDOWS[key] ?? FALLBACK_CONTEXT_WINDOW];
  })
);

/**
 * Fallback max tokens map: mirrors FALLBACK_MODEL_CONTEXT_WINDOWS keys.
 * Ensures every fallback model ID has a max tokens value.
 */
const FALLBACK_MAX_TOKENS_MAP = Object.fromEntries(
  Object.keys(FALLBACK_MODEL_CONTEXT_WINDOWS).map(id => {
    const parsed = parseModelId(id);
    const key = parsed ? parsed.base : id;
    return [id, MAX_TOKENS_MAP[key] ?? DEFAULT_MAX_TOKENS];
  })
);