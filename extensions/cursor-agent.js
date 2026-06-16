/**
 * pi-cursor-agent Pi Extension
 *
 * Starts an OpenAI-compatible HTTP proxy server on port 32124 that wraps
 * Cursor's `cursor-agent` CLI. This lets Pi (and any OpenAI-compatible
 * client) access Cursor Pro models through the same API the
 * opencode-cursor bridge uses.
 *
 * Usage:
 *   1. Restart Pi or run /reload
 *   2. Open /model and select a cursor-agent/... model
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
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { SessionManager, buildSessionPrompt } from "./cursor-session.js";

// ─── Config ───────────────────────────────────────────────────────────

const PORT = 32124;
const HOST = "127.0.0.1";
const PROVIDER_ID = "cursor-agent";
const HEALTH_SERVICE_ID = "cursor-agent";

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
 * Resolve the cache file path: ~/.pi/agent/cursor-agent-model-cache.json
 */
function getCacheFilePath() {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return path.join(home, ".pi", "agent", "cursor-agent-model-cache.json");
}

/**
 * Read Cursor auth state and return a SHA-256 hex hash.
 *
 * Sources (in priority order):
 *   1. CURSOR_API_KEY env var
 *   2. ~/.cursor/cli-config.json (authInfo + serverConfigCache)
 *   3. Unauthenticated sentinel
 *
 * @returns {string} hex-encoded SHA-256 hash
 */
function getAuthHash() {
  const apiKey = process.env.CURSOR_API_KEY;
  if (apiKey) {
    return crypto.createHash("sha256").update(`apikey:${apiKey}`).digest("hex");
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
    console.error("[cursor-agent] Failed to write model cache:", err.message);
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
      parts.push(content);
    } else if (role === "user") {
      parts.push(content);
    } else if (role === "assistant") {
      parts.push(content);
    } else if (role === "tool") {
      parts.push(`[Tool result from ${msg.name || "tool"}]: ${content}`);
    }
  }
  return parts.join("\n\n");
}

function normalizeModel(modelId) {
  if (!modelId) return "auto";
  return modelId.replace(/^cursor-agent\//, "").replace(/@[a-z0-9]+$/, "");
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
  return `cursor-agent error: ${stderr}`;
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

    // If a reasoning_effort is provided and we have a variant map,
    // attempt model ID substitution for collapsed families.
    if (reasoning_effort !== undefined && typeof __variantMap !== "undefined") {
      const resolved = resolveModelVariant(cursorModel, reasoning_effort, __variantMap);
      if (resolved) {
        cursorModel = resolved;
      }
    }

    // Resolve or create session. For sessionless requests, cursorModel is
    // re-resolved each time and no subprocess is persisted.
    const session = activeSessionManager
      ? activeSessionManager.getOrCreateSession(sessionId, cursorModel)
      : null;

    // Persist resolved model ID if this is a new session
    if (session && sessionId && !session.messageHistory.length) {
      // First turn — persist model ID for cross-turn consistency
      session.modelId = cursorModel;
    }

    // Use persisted model ID for subsequent turns
    const effectiveModel = (session && session.modelId) ? session.modelId : cursorModel;

    const id = `cursor-agent-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    // Check for existing subprocess in session
    let child = session?.subprocessRef ?? null;
    const isNewSubprocess = !child || child.killed;

    if (isNewSubprocess) {
      // Spawn a persistent subprocess (no --print, stdin stays open)
      const args = [
        "--output-format", "stream-json",
        "--model", effectiveModel, "--trust", "--force",
      ];
      if (stream) {
        args.push("--stream-partial-output");
      }

      child = spawn(cursorAgentPath(), args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });

      if (session) {
        session.subprocessRef = child;
      }

      // Write the full session history as the initial prompt
      if (session && session.messageHistory.length > 0) {
        const fullPrompt = buildSessionPrompt(session);
        child.stdin.write(fullPrompt);
      } else {
        const prompt = buildPromptFromMessages(messages);
        child.stdin.write(prompt);
      }
      // stdin stays OPEN — no child.stdin.end()
    } else {
      // Reusing existing subprocess: write only new messages not yet in session history.
      // The request body contains the full conversation history per OpenAI API
      // convention, so we must filter to only the unseen portion.
      if (session && session.messageHistory.length > 0) {
        const seenCount = session.messageHistory.length;
        const newMessages = messages.slice(-(messages.length - seenCount));
        if (newMessages.length > 0) {
          const newPrompt = buildPromptFromMessages(newMessages);
          child.stdin.write(newPrompt);
        }
      } else {
        const prompt = buildPromptFromMessages(messages);
        child.stdin.write(prompt);
      }
    }

    if (stream) {
      // ── Streaming ──
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // With --stream-partial-output, assistant events are usually incremental
      // deltas; the stream may end with one cumulative snapshot. Track assembled
      // text so we only forward the new suffix and skip duplicate finals.
      let assembledText = "";
      let usage = null;
      child.stderr.on("data", () => { /* errors surfaced via [DONE] for now */ });

      const writeChunk = (content) => {
        if (!content) return;
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
          // Record tool call in session history if available
          if (session && event.message) {
            session.messageHistory.push(event.message);
          }
          return;
        }

        if (event.type === "assistant" && event.message?.content) {
          // Record assistant message in session history
          if (session && event.message) {
            session.messageHistory.push(event.message);
          }
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
        for (const line of lineBuffer) {
          if (!line.trim()) continue;
          try {
            handleStreamEvent(JSON.parse(line.trim()));
          } catch {}
        }

        // Accumulate usage into session
        if (session && usage) {
          session.accumulateUsage(usage);
        }

        const finalUsage = session ? session.tokenUsage : (usage || {});
        if (finalUsage.inputTokens !== undefined || finalUsage.outputTokens !== undefined) {
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: cursorModel, choices: [], usage: { prompt_tokens: finalUsage.inputTokens ?? 0, completion_tokens: finalUsage.outputTokens ?? 0, total_tokens: (finalUsage.inputTokens ?? 0) + (finalUsage.outputTokens ?? 0), cache_read_tokens: finalUsage.cacheReadTokens ?? 0, cache_write_tokens: finalUsage.cacheWriteTokens ?? 0 } })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: cursorModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();

        // Start idle timeout for session release
        if (session && sessionId) {
          activeSessionManager?.releaseSession(sessionId);
        }
      });

      child.on("error", (err) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: cursorModel, choices: [{ index: 0, delta: { content: `cursor-agent error: ${err.message}` }, finish_reason: "error" }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }
      });

    } else {
      // ── Non-streaming ──
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));

      child.on("close", (code) => {
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
              // Record assistant message in session history
              if (session && event.message) {
                session.messageHistory.push(event.message);
              }
              for (const block of event.message.content) {
                if (block.type === "text") assistantText = block.text;
              }
            }
            if (event.type === "tool_call") {
              // Record tool call in session history for follow-up
              if (session && event.message) {
                session.messageHistory.push(event.message);
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

        // Accumulate usage into session
        if (session && usage) {
          session.accumulateUsage(usage);
        }

        const finalUsage = session ? session.tokenUsage : (usage || {});

        const responseMessage = {
          role: "assistant",
          content: errorText || assistantText || "No response",
        };
        if (thinkingText) {
          responseMessage.reasoning_text = thinkingText;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
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
        res.end(JSON.stringify(responsePayload));

        // Start idle timeout for session release
        if (session && sessionId) {
          activeSessionManager?.releaseSession(sessionId);
        }
      });

      child.on("error", (err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Failed to spawn cursor-agent: ${err.message}`, type: "server_error" } }));
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
 * Probe http://127.0.0.1:32124/health and confirm a pi-cursor-agent proxy
 * is already running there (vs. some unrelated service squatting on
 * the port). Returns true only when the running server identifies
 * itself as cursor-agent.
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
        res.end(JSON.stringify({ ok: true, service: HEALTH_SERVICE_ID }));
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

let startupLogHandlerRegistered = false;

function scheduleStartupLog(pi) {
  if (startupLogHandlerRegistered) return;
  startupLogHandlerRegistered = true;

  // Pi's default custom-message renderer inserts a blank line between the
  // [cursor-agent] header and the content. Render it ourselves so the content
  // appears on the line immediately following the header.
  pi.registerMessageRenderer("cursor-agent", (message, _options, theme) => {
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
    if (event.reason !== "startup" && event.reason !== "reload") return;
    const payload = startupLog;
    if (!payload) return;

    // session_start runs before Pi renders [Context]/[Skills]/[Extensions];
    // defer to the next macrotask so messages appear after that header.
    setTimeout(() => {
      if ("error" in payload) {
        if (ctx.hasUI) {
          pi.sendMessage({ customType: "cursor-agent", content: `Failed to start: ${payload.error}`, display: true });
        } else {
          console.error(`[cursor-agent] Failed to start: ${payload.error}`);
        }
        return;
      }
      // Send all startup lines as a single message so consecutive lines render
      // under one [cursor-agent] header instead of each line getting its own.
      if (payload.lines.length === 0) return;
      if (ctx.hasUI) {
        pi.sendMessage({
          customType: "cursor-agent",
          content: payload.lines.join("\n"),
          display: true,
        });
      } else {
        for (const line of payload.lines) {
          console.log(`[cursor-agent] ${line}`);
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

    const map = {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
    };

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
      id: `${PROVIDER_ID}/${base}`,
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
        id: `${PROVIDER_ID}/${base}@${suffix}`,
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
      id: `${PROVIDER_ID}/${id}`,
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
        id: `${PROVIDER_ID}/${mapKey}@${suffix}`,
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

function registerCursorProvider(pi, modelConfigs) {
  pi.registerProvider(PROVIDER_ID, {
    name: "Cursor Agent",
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

export default async function (pi) {
  scheduleStartupLog(pi);

  if (process.env.PI_CURSOR_AGENT_DISABLE === "1") {
    startupLog = { lines: ["Disabled via PI_CURSOR_AGENT_DISABLE=1"] };
    return;
  }

  // Close any server from a previous load so /reload re-binds the port with
  // the latest handler code instead of silently reusing the stale server.
  const PREV = globalThis.__piCursorAgentServer;
  if (PREV) {
    try { PREV.close(); } catch {}
    globalThis.__piCursorAgentServer = null;
  }

  let modelsCache = [];
  let modelsCacheTime = 0;
  let modelsCacheOrigin = null; // "disk" | "cli" | "stale-disk" | "fallback"
  const CACHE_TTL = 60_000;
  globalThis.__variantMap = {};          // populated alongside models
  globalThis.__modelContextWindows = {};  // cached per-model context windows

  // Register /cursor-refresh-models command early so it's available on all
  // startup paths (new proxy, peer-attach, and disabled). The handler
  // references getModels(), buildModelConfigs(), and registerCursorProvider()
  // which are all defined later in this closure but accessible at call time.
  pi.registerCommand("cursor-refresh-models", {
    description: "Refresh the cursor-agent model list from the CLI",
    handler: async (_args, ctx) => {
      // 1. Clear disk cache
      try { fs.unlinkSync(getCacheFilePath()); } catch {}

      // 2. Reset in-memory state
      modelsCache = [];
      modelsCacheTime = 0;
      modelsCacheOrigin = null;
      globalThis.__variantMap = {};
      globalThis.__modelContextWindows = {};

      // 3. Re-fetch from CLI (disk cache cleared, so getModels will hit CLI)
      try {
        const freshModels = await getModels();
        const modelConfigs = buildModelConfigs(freshModels);
        registerCursorProvider(pi, modelConfigs);

        const count = freshModels.length;
        if (ctx.hasUI) {
          pi.sendMessage({
            customType: "cursor-agent",
            content: `Refreshed ${count} cursor-agent models`,
            display: true,
          });
        } else {
          console.log(`[cursor-agent] Refreshed ${count} models`);
        }
      } catch (err) {
        const msg = `Failed to refresh models: ${err.message}`;
        if (ctx.hasUI) {
          pi.sendMessage({
            customType: "cursor-agent",
            content: msg,
            display: true,
          });
        } else {
          console.error(`[cursor-agent] ${msg}`);
        }
      }
    },
  });

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

    if (modelsCache.length > 0 && Date.now() - modelsCacheTime < CACHE_TTL) {
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
      console.error("[cursor-agent] Failed to fetch models:", err.message);
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
   * so the second/third instance still gets cursor-agent models in
   * /model instead of failing with EADDRINUSE.
   */
  async function attachToExistingProxy(reason) {
    try {
      const peerModels = await fetchPeerModels();
      const modelConfigs = buildModelConfigs(peerModels);
      registerCursorProvider(pi, modelConfigs);
      startupLog = {
        lines: [
          `Attached to existing proxy at http://${HOST}:${PORT}/v1 (${reason})`,
          `Registered ${modelConfigs.length} models with Pi`,
        ],
      };
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
          startupLog = {
            lines: [
              `Attached to existing proxy at http://${HOST}:${PORT}/v1 (${reason})`,
              `Registered ${modelConfigs.length} models with Pi`,
              `Loaded ${modelConfigs.length} models from disk cache (peer models unavailable)`,
            ],
          };
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
        globalThis.__piCursorAgentServer = server;
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

    const models = await getModels();
    const modelConfigs = buildModelConfigs(models);
    registerCursorProvider(pi, modelConfigs);

    const logLines = [
      `Proxy server running on http://${HOST}:${PORT}/v1`,
      `Registered ${modelConfigs.length} models with Pi`,
    ];
    if (modelsCacheOrigin === "disk") {
      logLines.push(`Loaded ${models.length} models from disk cache`);
    } else if (modelsCacheOrigin === "cli") {
      if (!DISABLE_MODEL_CACHE) {
        logLines.push(`Discovered ${models.length} models via cursor-agent CLI, cached to disk`);
      }
    } else if (modelsCacheOrigin === "stale-disk") {
      logLines.push(`Loaded ${models.length} models from stale disk cache (CLI unavailable)`);
    } else if (modelsCacheOrigin === "fallback") {
      logLines.push(`Using built-in fallback list (${models.length} models) \u2014 CLI unavailable`);
    }
    startupLog = { lines: logLines };
  } catch (err) {
    // Race: another Pi instance bound the port between our probe and
    // our listen(). Fall back to client-only mode so the user still
    // gets cursor-agent models instead of a hard failure.
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
 * Per-model context window values.
 * Family-base keys cover all effort variants; standalone keys for raw IDs.
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