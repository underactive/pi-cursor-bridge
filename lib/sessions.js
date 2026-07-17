/**
 * Session management for the cursor-bridge proxy.
 *
 * Pure Node (no Pi imports) so it can be unit-tested via `node --test`.
 * Loaded by the extension through loadSdkHelpers()'s realpath dynamic-import.
 */

/**
 * Default session idle timeout (5 minutes in ms).
 * After this period of inactivity, the session and its subprocess are
 * released. Configurable via PI_CURSOR_SESSION_TIMEOUT_MS.
 */
export const DEFAULT_SESSION_TIMEOUT_MS = 300_000;

export function getSessionTimeout() {
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
export class CursorSession {
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
export class SessionManager {
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
