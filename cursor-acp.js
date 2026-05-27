/**
 * cursor-acp Pi Extension
 *
 * Starts an OpenAI-compatible HTTP proxy server on port 32124 that wraps
 * Cursor's `cursor-agent` CLI. This lets Pi (and any OpenAI-compatible
 * client) access Cursor Pro models through the same API the
 * opencode-cursor bridge uses.
 *
 * Usage:
 *   1. Restart Pi or run /reload
 *   2. Open /model and select a cursor-acp/... model
 *   3. Start chatting!
 *
 * Requires `cursor-agent` to be logged in:
 *   cursor-agent login
 */

import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ─── Config ───────────────────────────────────────────────────────────

const PORT = 32124;
const HOST = "127.0.0.1";
const PROVIDER_ID = "cursor-acp";

/**
 * Resolve the cursor-agent binary path.
 */
function resolveCursorAgent() {
  const envPath = process.env.CURSOR_ACP_CURSOR_AGENT_PATH;
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
  return process.env.CURSOR_ACP_CURSOR_AGENT_PATH || resolveCursorAgent();
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
  return modelId.replace(/^cursor-acp\//, "");
}

/**
 * Strip cursor-agent's model-intro banner.
 * Format: `**Model:** Composer (Auto)\n\nactual response...`
 */
function stripModelIntro(text) {
  return text.replace(/^\*\*Model:\*\*.*?\n\n/, "");
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

    const { messages, stream, model } = requestBody;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "messages is required" }));
      return;
    }

    const cursorModel = normalizeModel(model);
    const prompt = buildPromptFromMessages(messages);
    const id = `cursor-acp-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    const args = [
      "--print", "--output-format", "stream-json",
      "--stream-partial-output",
      "--model", cursorModel, "--trust",
    ];

    const child = spawn(cursorAgentPath(), args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: { ...process.env, CURSOR_ACP_LOG_LEVEL: "error" },
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

      let accumulated = "";
      let streaming = false;
      let usage = null;
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString()));

      const lineBuffer = [];
      child.stdout.on("data", (d) => {
        const lines = (lineBuffer.join("") + d.toString()).split("\n");
        lineBuffer.length = 0;

        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "thinking") continue;

            // Reset tracking on tool_call — cursor-agent outputs a new
            // assistant phase after tool calls, and the final event only
            // contains the LAST phase's text, not the accumulated total.
            if (event.type === "tool_call") {
              accumulated = "";
              streaming = false;
            }

            if (event.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type !== "text" || !block.text) continue;
                const fullText = block.text;

                // Compute delta (final event has complete text)
                let delta = fullText;
                if (accumulated && fullText.startsWith(accumulated)) {
                  delta = fullText.slice(accumulated.length);
                }
                if (!delta) continue;
                accumulated += delta;

                if (!streaming) {
                  // Buffer until we can identify/drop the intro banner
                  const cleaned = stripModelIntro(accumulated);
                  if (cleaned !== accumulated) {
                    streaming = true;
                    if (cleaned) {
                      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: cursorModel, choices: [{ index: 0, delta: { content: cleaned }, finish_reason: null }] })}\n\n`);
                    }
                  } else if (accumulated.length > 0 && !"**Model:".startsWith(accumulated) && !accumulated.startsWith("**Model:")) {
                    streaming = true;
                    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: cursorModel, choices: [{ index: 0, delta: { content: accumulated }, finish_reason: null }] })}\n\n`);
                  }
                } else {
                  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: cursorModel, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`);
                }
              }
            }

            if (event.type === "result") {
              usage = event.usage || null;
            }
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
            const event = JSON.parse(line.trim());
            if (event.type === "result") usage = event.usage || usage;
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
        let errorText = "";
        let usage = null;

        for (const line of stdout.trim().split("\n")) {
          try {
            const event = JSON.parse(line.trim());
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

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id,
          object: "chat.completion",
          created,
          model: cursorModel,
          choices: [{ index: 0, message: { role: "assistant", content: errorText || stripModelIntro(assistantText || "No response") }, finish_reason: errorText ? "error" : "stop" }],
          usage: usage ? { prompt_tokens: usage.inputTokens ?? 0, completion_tokens: usage.outputTokens ?? 0, total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) } : undefined,
        }));
      });

      child.on("error", (err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Failed to spawn cursor-agent: ${err.message}`, type: "server_error" } }));
      });
    }
  });
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
        res.end(JSON.stringify({ ok: true }));
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

export default async function (pi) {
  if (process.env.CURSOR_ACP_DISABLE === "1") {
    console.log("[cursor-acp] Disabled via CURSOR_ACP_DISABLE=1");
    return;
  }

  let server = null;
  let modelsCache = [];
  let modelsCacheTime = 0;
  const CACHE_TTL = 60_000;

  async function getModels() {
    if (modelsCache.length > 0 && Date.now() - modelsCacheTime < CACHE_TTL) {
      return modelsCache;
    }
    try {
      modelsCache = await fetchCursorModels();
      modelsCacheTime = Date.now();
    } catch (err) {
      console.error("[cursor-acp] Failed to fetch models:", err.message);
      if (modelsCache.length === 0) {
        modelsCache = FALLBACK_MODELS.map((id) => ({
          id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "cursor",
        }));
      }
    }
    return modelsCache;
  }

  try {
    server = startProxyServer(getModels);

    await new Promise((resolve, reject) => {
      server.listen(PORT, HOST, () => {
        console.log(`[cursor-acp] Proxy server running on http://${HOST}:${PORT}/v1`);
        resolve();
      });
      server.once("error", (err) => {
        if (err.code === "EADDRINUSE") {
          console.log(`[cursor-acp] Port ${PORT} already in use — reusing existing proxy`);
          resolve();
        } else {
          reject(err);
        }
      });
    });

    const models = await getModels();

    const modelConfigs = models
      .filter((m) => m.id && !m.id.startsWith("_"))
      .map((m) => ({
        id: `${PROVIDER_ID}/${m.id}`,
        name: m.name || m.id,
        reasoning: /thinking|reasoning|high|xhigh/i.test(m.id),
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16384,
      }));

    pi.registerProvider(PROVIDER_ID, {
      name: "Cursor ACP",
      baseUrl: `http://${HOST}:${PORT}/v1`,
      apiKey: "CURSOR_ACP_API_KEY",
      api: "openai-completions",
      authHeader: false,
      models: modelConfigs,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens",
        supportsUsageInStreaming: true,
      },
    });

    console.log(`[cursor-acp] Registered ${modelConfigs.length} models with Pi`);
  } catch (err) {
    console.error("[cursor-acp] Failed to start:", err.message);
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