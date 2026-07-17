/**
 * cursor-agent CLI helpers: binary resolution, spawn environment, model
 * listing, prompt building, and error formatting.
 *
 * Pure Node (no Pi imports) so it can be unit-tested via `node --test`.
 * Loaded by the extension through importLib()'s realpath dynamic-import.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DEFAULT_MAX_TOKENS, parseContextFromDisplayName } from "./model-data.js";

/**
 * Force every Cursor run into a read-only conversation mode.
 *
 * Set PI_CURSOR_FORCE_MODE=plan (or ask) in the environment when embedding the
 * bridge in a flow that must never mutate the workspace — e.g. pi plan-mode
 * subagents (pi-moa-plan spawns its proposer/synthesizer children with this
 * var). Without it, Cursor models run as full agents with their OWN local
 * edit/shell tools, so pi-side tool allowlists cannot stop them from writing.
 *
 * SDK runs map both values to mode "plan" (the SDK only knows agent|plan);
 * CLI runs pass --mode plan/ask and drop --force (auto-approve).
 *
 * Read per-run (not once at load) so a host extension living in the SAME pi
 * process (e.g. plan mode toggling on/off) can set/clear the var dynamically.
 * Note: SDK agents reused across turns keep the mode they were created with;
 * only newly created runs pick up a change.
 */
export function forceMode() {
  const v = (process.env.PI_CURSOR_FORCE_MODE || "").toLowerCase();
  return v === "plan" || v === "ask" ? v : null;
}

/**
 * Resolve the user's home directory (with a /tmp fallback for bare envs).
 */
export function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || "/tmp";
}

/**
 * Resolve the cursor-agent binary path.
 */
export function resolveCursorAgent() {
  const envPath = process.env.PI_CURSOR_AGENT_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const home = homeDir();
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

export function cursorAgentPath() {
  return process.env.PI_CURSOR_AGENT_PATH || resolveCursorAgent();
}

/**
 * Environment for cursor-agent spawns: inherits the process env and injects
 * the given Pi-stored API key when one is provided.
 * @param {string|null} [authKey] — Pi-stored Cursor API key (or null)
 */
export function cursorAgentEnv(authKey) {
  return authKey
    ? { ...process.env, CURSOR_API_KEY: authKey }
    : { ...process.env };
}

/**
 * Run cursor-agent in "list models" mode with enhanced parsing.
 *
 * Parses context window sizes from display names where available,
 * so dynamic models get accurate context windows without manual
 * map updates.
 * @param {string|null} [authKey] — Pi-stored Cursor API key (or null)
 */
export async function fetchCursorModels(authKey) {
  return new Promise((resolve, reject) => {
    const child = spawn(cursorAgentPath(), ["models", "--trust"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: cursorAgentEnv(authKey),
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
    child.on("error", reject);
    child.stdin.end();
  });
}

/**
 * Build a text prompt from OpenAI-format messages that cursor-agent
 * can understand.
 */
export function buildPromptFromMessages(messages) {
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

export function normalizeModel(modelId) {
  if (!modelId) return "auto";
  return modelId.replace(/^cursor-bridge\//, "").replace(/@[a-z0-9]+$/, "");
}

/**
 * Parse common cursor-agent errors into user-friendly messages.
 */
export function formatCursorError(stderr) {
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
