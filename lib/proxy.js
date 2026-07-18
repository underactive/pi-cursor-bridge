/**
 * OpenAI-compatible HTTP proxy over the cursor-agent CLI: the
 * /v1/chat/completions handler (streaming + non-streaming), peer discovery,
 * and the proxy server factory.
 *
 * Pi-coupled state is injected by the extension:
 *   - catalog:          ModelCatalog (family variant map; L5 snapshot semantics)
 *   - getAuthKey:       () => current Pi-stored Cursor API key (M3 /login re-read)
 *   - getLiveRunsCount: () => in-flight SDK tool-bridge runs (for /health)
 *   - modelsFn:         () => Promise<model list> (for /v1/models)
 *   - host/port/healthServiceId: proxy binding + health identity
 *
 * Pure Node (no Pi imports) so it can be smoke-tested via `node --test`
 * (see test/proxy.test.js + test/fixtures/fake-cursor-agent.mjs).
 * Loaded by the extension through importLib()'s realpath dynamic-import.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { SessionManager } from "./sessions.js";
import {
  buildPromptFromMessages,
  cursorAgentEnv,
  cursorAgentPath,
  forceMode,
  formatCursorError,
  normalizeModel,
} from "./cursor-cli.js";
import { resolveModelVariant } from "./cursor-helpers.js";

// L3: cap the buffered stdout of a non-streaming cursor-agent reply (16 MiB).
const MAX_NONSTREAM_STDOUT_BYTES = 16 * 1024 * 1024;

// ─── Chat completions handler ─────────────────────────────────────────

/**
 * Module-level session manager instance, set when the proxy server starts.
 * The handler reads the X-Session-Id header to route requests to the
 * appropriate session for multi-turn conversations.
 * @type {SessionManager|null}
 */
let activeSessionManager = null;

/**
 * Spawn a cursor-agent completion child for one request.
 *
 * cursor-agent reads stdin until EOF, so callers write the prompt then close
 * stdin to signal that input is complete; the subprocess exits after
 * processing. Always a fresh subprocess per request.
 *
 * @param {string} effectiveModel — resolved cursor-agent model id (--model)
 * @param {boolean} stream — request --stream-partial-output deltas
 * @param {string|null} authKey — Pi-stored Cursor API key (or null)
 * @returns {import("node:child_process").ChildProcess}
 */
function spawnCursorChild(effectiveModel, stream, authKey) {
  const args = [
    "--output-format", "stream-json",
    "--model", effectiveModel, "--trust",
  ];
  // Read-only override: in plan/ask mode the CLI itself refuses edits, and
  // --force (auto-approve every tool) must not be passed. Otherwise keep the
  // historical headless default of auto-approved tools.
  const cliForceMode = forceMode();
  if (cliForceMode) args.push("--mode", cliForceMode);
  else args.push("--force");
  if (stream) {
    args.push("--stream-partial-output");
  }

  return spawn(cursorAgentPath(), args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
    env: cursorAgentEnv(authKey),
  });
}

/**
 * Map cursor-agent result usage to the OpenAI usage payload shape.
 * Reports THIS turn's usage only (M1): the proxy serves stateless OpenAI
 * clients that sum per-response usage, so a cumulative total would over-count.
 * Returns null when the result carried no token counts.
 * @param {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }} finalUsage
 */
function buildUsagePayload(finalUsage) {
  if (finalUsage.inputTokens === undefined && finalUsage.outputTokens === undefined) return null;
  return {
    prompt_tokens: finalUsage.inputTokens ?? 0,
    completion_tokens: finalUsage.outputTokens ?? 0,
    total_tokens: (finalUsage.inputTokens ?? 0) + (finalUsage.outputTokens ?? 0),
    cache_read_tokens: finalUsage.cacheReadTokens ?? 0,
    cache_write_tokens: finalUsage.cacheWriteTokens ?? 0,
  };
}

/**
 * M2: if the client drops the connection before the response finishes, kill
 * the subprocess instead of leaking it until the idle timer. writableFinished
 * distinguishes the normal-completion close (res.end already ran) from a real
 * disconnect.
 */
function attachDisconnectKill(res, child) {
  res.on("close", () => {
    if (res.writableFinished) return;
    if (child && !child.killed) {
      child.kill();
      console.log("[cursor-bridge] child killed on client close");
    }
  });
}

/**
 * Parse a buffer of newline-delimited JSON, invoking onEvent per parsed line.
 * Unparseable lines are skipped.
 */
function parseNdjson(text, onEvent) {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      onEvent(JSON.parse(trimmed));
    } catch { /* skip unparseable lines */ }
  }
}

/**
 * Stream cursor-agent NDJSON events to the client as OpenAI SSE chunks.
 * @param {import("node:child_process").ChildProcess} child
 * @param {import("node:http").ServerResponse} res
 * @param {{ id: string, created: number, cursorModel: string, session: object|null, sessionId: string }} ctx
 */
function handleStreamingResponse(child, res, ctx) {
  const { id, created, cursorModel, session, sessionId } = ctx;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  attachDisconnectKill(res, child);

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

    parseNdjson(lineBuffer.join(""), handleStreamEvent);

    // M1: per-turn usage — see buildUsagePayload.
    const usagePayload = buildUsagePayload(usage || {});
    // M2: the client may have disconnected — only write if the response is open.
    if (!res.writableEnded) {
      if (usagePayload) {
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: cursorModel, choices: [], usage: usagePayload })}\n\n`);
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
}

/**
 * Buffer the full cursor-agent reply, then answer with one OpenAI
 * chat.completion JSON document.
 * @param {import("node:child_process").ChildProcess} child
 * @param {import("node:http").ServerResponse} res
 * @param {{ id: string, created: number, cursorModel: string, session: object|null, sessionId: string }} ctx
 */
function handleNonStreamingResponse(child, res, ctx) {
  const { id, created, cursorModel, session, sessionId } = ctx;

  // M2: the whole reply is buffered until child close, so an early client
  // drop would otherwise leak the subprocess — kill it on disconnect.
  attachDisconnectKill(res, child);

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

    parseNdjson(stdout, (event) => {
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
    });

    if ((code !== 0 || !assistantText) && stderr.trim()) {
      errorText = formatCursorError(stderr.trim());
    }
    if (stdoutTruncated) {
      console.log(`[cursor-bridge] non-streaming stdout truncated at ${MAX_NONSTREAM_STDOUT_BYTES} bytes`);
    }

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
    // M1: per-turn usage — see buildUsagePayload.
    const usagePayload = buildUsagePayload(usage || {});
    if (usagePayload) {
      responsePayload.usage = usagePayload;
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

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{ catalog: import("./model-catalog.js").ModelCatalog|null, getAuthKey: () => (string|null) }} ctx
 */
export function handleChatCompletions(req, res, ctx) {
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
    // L5: snapshot the variant map once. /cursor-refresh-models replaces the
    // catalog's map mid-flight; capturing a stable reference here keeps this
    // request reading one consistent map instead of a half-cleared one.
    const variantMap = ctx.catalog ? ctx.catalog.variantMap : null;
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

    const child = spawnCursorChild(effectiveModel, !!stream, ctx.getAuthKey());

    if (session) {
      session.subprocessRef = child;
    }

    // Build prompt from the request body messages (OpenAI API convention sends
    // the full conversation history on every request).
    const prompt = buildPromptFromMessages(messages);
    child.stdin.write(prompt);
    child.stdin.end();

    const responseCtx = { id, created, cursorModel, session, sessionId };
    if (stream) {
      handleStreamingResponse(child, res, responseCtx);
    } else {
      handleNonStreamingResponse(child, res, responseCtx);
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
export function fetchLocalJson(pathname, { host, port, timeoutMs = 750 }) {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: pathname, method: "GET", timeout: timeoutMs },
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
export async function detectExistingProxy({ host, port, serviceId }) {
  const health = await fetchLocalJson("/health", { host, port });
  return !!(health && health.ok === true && health.service === serviceId);
}

// ─── HTTP Server ──────────────────────────────────────────────────────

/**
 * Create (but do not listen) the proxy HTTP server.
 * @param {{ modelsFn: () => Promise<Array>, catalog: object|null, getAuthKey: () => (string|null), host: string, healthServiceId: string, getLiveRunsCount: () => number }} deps
 */
export function startProxyServer({ modelsFn, catalog, getAuthKey, host, healthServiceId, getLiveRunsCount }) {
  // Initialize the shared session manager for multi-turn conversations
  activeSessionManager = new SessionManager();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || host}`);

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
        return handleChatCompletions(req, res, { catalog, getAuthKey });
      }

      if (url.pathname === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        // liveRuns drives the H1/H2 diagnostics: poll until it returns to 0.
        res.end(JSON.stringify({ ok: true, service: healthServiceId, liveRuns: getLiveRunsCount() }));
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

