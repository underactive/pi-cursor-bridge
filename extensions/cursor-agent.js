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
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";

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

/**
 * Run cursor-agent in "list models" mode.
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
          models.push({
            id: m[1],
            name: m[2].trim(),
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
  return modelId.replace(/^cursor-agent\//, "");
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

  // 1. Strip -fast suffix (orthogonal speed modifier, deferred)
  let id = modelId;
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

    let cursorModel = normalizeModel(model);

    // If a reasoning_effort is provided and we have a variant map,
    // attempt model ID substitution for collapsed families.
    if (reasoning_effort !== undefined && typeof __variantMap !== "undefined") {
      // normalizeModel strips cursor-agent/ prefix, so cursorModel is the raw ID
      const resolved = resolveModelVariant(cursorModel, reasoning_effort, __variantMap);
      if (resolved) {
        cursorModel = resolved;
      }
    }
    const prompt = buildPromptFromMessages(messages);
    const id = `cursor-agent-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    // --force auto-approves all tool calls (bash, file ops, etc.)
    // without it, cursor-agent rejects every tool execution, making
    // models unable to run commands or access the filesystem.
    // Safe because the proxy binds to 127.0.0.1:32124 only.
    const args = [
      "--print", "--output-format", "stream-json",
      "--model", cursorModel, "--trust", "--force",
    ];
    if (stream) {
      args.push("--stream-partial-output");
    }

    const child = spawn(cursorAgentPath(), args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    child.stdin.write(prompt);
    child.stdin.end();

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
          assembledText = "";
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
        for (const line of lineBuffer) {
          if (!line.trim()) continue;
          try {
            handleStreamEvent(JSON.parse(line.trim()));
          } catch {}
        }

        if (usage) {
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: cursorModel, choices: [], usage: { prompt_tokens: usage.inputTokens ?? 0, completion_tokens: usage.outputTokens ?? 0, total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0), cache_read_tokens: usage.cacheReadTokens ?? 0, cache_write_tokens: usage.cacheWriteTokens ?? 0 } })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: cursorModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
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
        let thinkingText = "";  // accumulate thinking content
        let errorText = "";
        let usage = null;

        for (const line of stdout.trim().split("\n")) {
          try {
            const event = JSON.parse(line.trim());
            if (event.type === "thinking") {
              // Accumulate thinking content
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

        // Include thinking content in the response
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
        if (usage) {
          responsePayload.usage = {
            prompt_tokens: usage.inputTokens ?? 0,
            completion_tokens: usage.outputTokens ?? 0,
            total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
            cache_read_tokens: usage.cacheReadTokens ?? 0,
            cache_write_tokens: usage.cacheWriteTokens ?? 0,
          };
        }
        res.end(JSON.stringify(responsePayload));
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

    configs.push({
      id: `${PROVIDER_ID}/${base}`,
      name: base,
      reasoning: true,
      thinkingLevelMap: buildThinkingLevelMap(entry),
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    });
  }

  // Register standalone models (flat, non-reasoning entries)
  for (const id of standaloneModels) {
    configs.push({
      id: `${PROVIDER_ID}/${id}`,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    });
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
  const CACHE_TTL = 60_000;
  globalThis.__variantMap = {};  // populated alongside models

  async function getModels() {
    if (modelsCache.length > 0 && Date.now() - modelsCacheTime < CACHE_TTL) {
      return modelsCache;
    }
    try {
      modelsCache = await fetchCursorModels();
      const { variantMap: vm } = buildModelFamilies(modelsCache);
      globalThis.__variantMap = vm;
      modelsCacheTime = Date.now();
    } catch (err) {
      console.error("[cursor-agent] Failed to fetch models:", err.message);
      if (modelsCache.length === 0) {
        const fallback = FALLBACK_MODELS.map((id) => ({
          id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "cursor",
        }));
        modelsCache = fallback;
        const { variantMap: vm } = buildModelFamilies(fallback);
        globalThis.__variantMap = vm;
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

    startupLog = {
      lines: [
        `Proxy server running on http://${HOST}:${PORT}/v1`,
        `Registered ${modelConfigs.length} models with Pi`,
      ],
    };
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