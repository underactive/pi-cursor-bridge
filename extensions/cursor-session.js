/**
 * cursor-session — Session management for pi-cursor-agent
 *
 * Provides CursorSession (per-session state) and SessionManager
 * (lifecycle + cleanup) used by the HTTP proxy to support multi-turn
 * conversations through cursor-agent's persistent subprocess mode.
 *
 * Usage:
 *   import { SessionManager, buildSessionPrompt } from "./cursor-session.js";
 *   const sessions = new SessionManager();
 *   const session = sessions.getOrCreateSession(sessionId, modelId);
 *   const prompt = buildSessionPrompt(session);
 */

// ─── Config ───────────────────────────────────────────────────────────

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

// ─── CursorSession ────────────────────────────────────────────────────

/**
 * Represents a single multi-turn conversation session with cursor-agent.
 *
 * A session holds:
 *  - The resolved cursor-agent model ID (persisted after first resolution)
 *  - The full OpenAI-format message history for prompt construction
 *  - Accumulated token usage across turns
 *  - Reference to the persistent cursor-agent subprocess (or null in
 *    single-turn / --print fallback mode)
 *  - Creation and last-activity timestamps for idle timeout
 */
class CursorSession {
  /**
   * @param {string} sessionId — UUID or caller-provided session identifier
   * @param {string} modelId — resolved cursor-agent model ID (--model arg)
   */
  constructor(sessionId, modelId) {
    /** @type {string} */
    this.sessionId = sessionId;

    /**
     * Resolved cursor-agent model ID, persisted after first resolution.
     * Subsequent turns skip re-resolution for cross-turn consistency.
     * @type {string}
     */
    this.modelId = modelId;

    /**
     * Full OpenAI-format message history for this session.
     * Used by buildSessionPrompt() to reconstruct context.
     * @type {Array<object>}
     */
    this.messageHistory = [];

    /**
     * Accumulated token usage across all turns in this session.
     * @type {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }}
     */
    this.tokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    /**
     * Reference to the persistent cursor-agent child process.
     * Set after spawn in the agent loop (Slice 4). Null in single-turn
     * or before first spawn.
     * @type {import("node:child_process").ChildProcess|null}
     */
    this.subprocessRef = null;

    /** @type {number} — Date.now() at creation */
    this.createdAt = Date.now();

    /** @type {number} — Date.now() at last activity */
    this.lastActivityAt = Date.now();
  }

  /**
   * Touch the session to mark recent activity.
   * Call after every interaction (read/write).
   */
  touch() {
    this.lastActivityAt = Date.now();
  }

  /**
   * Add messages to this session's history.
   * Accepts a single message or an array.
   * @param {object|object[]} messages — OpenAI-format message(s)
   */
  addMessages(messages) {
    const msgs = Array.isArray(messages) ? messages : [messages];
    this.messageHistory.push(...msgs);
    this.touch();
  }

  /**
   * Clear the message history for a fresh start.
   */
  resetHistory() {
    this.messageHistory = [];
    this.tokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    this.touch();
  }

  /**
   * Accumulate usage from a single turn.
   * @param {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }} usage
   */
  accumulateUsage(usage) {
    if (!usage) return;
    this.tokenUsage.inputTokens += usage.inputTokens ?? 0;
    this.tokenUsage.outputTokens += usage.outputTokens ?? 0;
    this.tokenUsage.cacheReadTokens += usage.cacheReadTokens ?? 0;
    this.tokenUsage.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  }

  /**
   * Returns true if the session has been idle longer than the timeout.
   * @param {number} [timeoutMs] — timeout in ms (defaults to PI_CURSOR_SESSION_TIMEOUT_MS)
   * @returns {boolean}
   */
  isExpired(timeoutMs) {
    const ttl = timeoutMs ?? getSessionTimeout();
    return Date.now() - this.lastActivityAt > ttl;
  }
}

// ─── SessionManager ───────────────────────────────────────────────────

/**
 * Manages the lifecycle of all active CursorSession instances.
 *
 * Sessions are keyed by caller-provided session ID (typically from the
 * X-Session-Id HTTP header). The manager handles creation, lookup,
 * release with idle timeout, and periodic cleanup.
 *
 * Usage:
 *   const sessions = new SessionManager();
 *   const session = sessions.getOrCreateSession("abc-123", "claude-4.6-sonnet");
 *   sessions.releaseSession("abc-123");  // start idle timer
 *   sessions.cleanup();                  // sweep expired sessions
 */
class SessionManager {
  constructor() {
    /** @type {Map<string, CursorSession>} */
    this._sessions = new Map();

    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    this._releaseTimers = new Map();
  }

  /**
   * Get or create a session for the given ID.
   *
   * If the session exists and is active, returns it. If it exists but
   * has a different modelId, returns the existing session (the model
   * from first creation wins — subsequent requests with different model
   * IDs are ignored).
   *
   * If no session exists, creates one with the given modelId.
   *
   * @param {string} sessionId
   * @param {string} modelId — resolved cursor-agent model ID
   * @returns {CursorSession}
   */
  getOrCreateSession(sessionId, modelId) {
    if (!sessionId) {
      // No session ID provided — create ephemeral session not tracked in the map
      return new CursorSession("", modelId);
    }

    let session = this._sessions.get(sessionId);
    if (session) {
      // Cancel any pending release timer
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

  /**
   * Get an existing session by ID, or null if not found.
   * @param {string} sessionId
   * @returns {CursorSession|null}
   */
  getSession(sessionId) {
    return this._sessions.get(sessionId) ?? null;
  }

  /**
   * Start the release timer for a session. After the timeout, the session
   * is removed from the map and its subprocess is killed.
   *
   * Call this when a turn completes to start the idle countdown.
   * If another request arrives before the timer fires, getOrCreateSession
   * cancels the timer.
   *
   * @param {string} sessionId
   * @param {number} [timeoutMs] — idle timeout in ms
   */
  releaseSession(sessionId, timeoutMs) {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    // Don't double-schedule
    if (this._releaseTimers.has(sessionId)) return;

    const ttl = timeoutMs ?? getSessionTimeout();

    const timer = setTimeout(() => {
      this._cleanupSession(sessionId);
    }, ttl);

    // Allow the timer to not prevent process exit
    if (timer.unref) timer.unref();

    this._releaseTimers.set(sessionId, timer);
  }

  /**
   * Immediately remove a session, kill its subprocess, and clear timers.
   * @param {string} sessionId
   */
  removeSession(sessionId) {
    this._cleanupSession(sessionId);
  }

  /**
   * Sweep all expired sessions and release them.
   * Call periodically (e.g., on a setInterval or before shutdown).
   * @param {number} [timeoutMs]
   */
  cleanup(timeoutMs) {
    const ttl = timeoutMs ?? getSessionTimeout();
    const now = Date.now();

    for (const [id, session] of this._sessions) {
      if (now - session.lastActivityAt > ttl) {
        this._cleanupSession(id);
      }
    }
  }

  /**
   * Kill all active sessions and clear the manager.
   * Call on shutdown.
   */
  destroy() {
    for (const [id] of this._sessions) {
      this._cleanupSession(id);
    }
    // Clear any remaining release timers
    for (const [id, timer] of this._releaseTimers) {
      clearTimeout(timer);
      this._releaseTimers.delete(id);
    }
  }

  /**
   * Internal: clean up a single session.
   * Kills the subprocess, clears the timer, removes from the map.
   * @param {string} sessionId
   * @private
   */
  _cleanupSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    // Kill subprocess if alive
    const child = session.subprocessRef;
    if (child && !child.killed) {
      try { child.kill(); } catch {}
    }

    // Clear release timer
    const timer = this._releaseTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this._releaseTimers.delete(sessionId);
    }

    // Remove from map
    this._sessions.delete(sessionId);
  }
}

// ─── Prompt Builder ───────────────────────────────────────────────────

/**
 * Build a text prompt from a session's message history that cursor-agent
 * can understand.
 *
 * Unlike the lossy buildPromptFromMessages() in cursor-agent.js, this
 * function preserves:
 *  - Role boundaries (via <|im_start|>role format)
 *  - Tool call IDs (embedded in tool results)
 *  - Message ordering (no ambiguous \n\n separation)
 *
 * cursor-agent accepts freeform text on stdin (no structured NDJSON),
 * so we use a ChatML-like delimiter convention that the CLI's internal
 * parser can disambiguate.
 *
 * @param {CursorSession} session — the session whose history to serialize
 * @returns {string} — serialized prompt for cursor-agent stdin
 */
function buildSessionPrompt(session) {
  const parts = [];

  for (const msg of session.messageHistory) {
    const role = msg.role || "user";
    let content = "";

    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      // Extract text segments only — cursor-agent's stdin accepts text
      content = msg.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    }

    if (role === "system") {
      parts.push(`<|im_start|>system\n${content}\n<|im_end|>`);
    } else if (role === "user") {
      parts.push(`<|im_start|>user\n${content}\n<|im_end|>`);
    } else if (role === "assistant") {
      parts.push(`<|im_start|>assistant\n${content}\n<|im_end|>`);
    } else if (role === "tool") {
      const toolName = msg.name ? ` (${msg.name})` : "";
      const toolCallId = msg.tool_call_id ? ` [call:${msg.tool_call_id}]` : "";
      parts.push(`<|im_start|>tool${toolName}${toolCallId}\n${content}\n<|im_end|>`);
    }
  }

  return parts.join("\n");
}

// ─── Exports ──────────────────────────────────────────────────────────

export { CursorSession, SessionManager, buildSessionPrompt, getSessionTimeout };
