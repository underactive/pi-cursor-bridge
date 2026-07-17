import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CursorSession,
  SessionManager,
  getSessionTimeout,
  DEFAULT_SESSION_TIMEOUT_MS,
} from "../lib/sessions.js";

function fakeChild() {
  return {
    killed: false,
    kill() { this.killed = true; },
  };
}

test("getSessionTimeout returns default without env", () => {
  delete process.env.PI_CURSOR_SESSION_TIMEOUT_MS;
  assert.equal(getSessionTimeout(), DEFAULT_SESSION_TIMEOUT_MS);
});

test("getSessionTimeout honors PI_CURSOR_SESSION_TIMEOUT_MS", () => {
  process.env.PI_CURSOR_SESSION_TIMEOUT_MS = "1234";
  assert.equal(getSessionTimeout(), 1234);
  process.env.PI_CURSOR_SESSION_TIMEOUT_MS = "not-a-number";
  assert.equal(getSessionTimeout(), DEFAULT_SESSION_TIMEOUT_MS);
  delete process.env.PI_CURSOR_SESSION_TIMEOUT_MS;
});

test("empty sessionId returns a throwaway session (not stored)", () => {
  const mgr = new SessionManager();
  const s = mgr.getOrCreateSession("", "gpt-5.5");
  assert.equal(s.sessionId, "");
  assert.equal(mgr.getSession(""), null);
  mgr.destroy();
});

test("getOrCreateSession stores, reuses, and pins the model", () => {
  const mgr = new SessionManager();
  const s1 = mgr.getOrCreateSession("abc", "model-a");
  const s2 = mgr.getOrCreateSession("abc", "model-b");
  assert.equal(s1, s2);
  assert.equal(s2.modelId, "model-a"); // model pinned at creation
  mgr.destroy();
});

test("reuse cancels a pending release timer", () => {
  const mgr = new SessionManager();
  mgr.getOrCreateSession("abc", "m");
  mgr.releaseSession("abc", 60_000);
  assert.equal(mgr._releaseTimers.size, 1);
  mgr.getOrCreateSession("abc", "m");
  assert.equal(mgr._releaseTimers.size, 0);
  mgr.destroy();
});

test("releaseSession schedules cleanup that kills the child", async () => {
  const mgr = new SessionManager();
  const s = mgr.getOrCreateSession("abc", "m");
  const child = fakeChild();
  s.subprocessRef = child;
  mgr.releaseSession("abc", 10);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(mgr.getSession("abc"), null);
  assert.equal(child.killed, true);
  mgr.destroy();
});

test("destroy kills children and clears all timers", () => {
  const mgr = new SessionManager();
  const s = mgr.getOrCreateSession("abc", "m");
  const child = fakeChild();
  s.subprocessRef = child;
  mgr.releaseSession("abc", 60_000);
  mgr.destroy();
  assert.equal(child.killed, true);
  assert.equal(mgr._sessions.size, 0);
  assert.equal(mgr._releaseTimers.size, 0);
});

test("cleanup removes only expired sessions", () => {
  const mgr = new SessionManager();
  const stale = mgr.getOrCreateSession("stale", "m");
  stale.lastActivityAt = Date.now() - 10_000;
  mgr.getOrCreateSession("fresh", "m");
  mgr.cleanup(5_000);
  assert.equal(mgr.getSession("stale"), null);
  assert.ok(mgr.getSession("fresh"));
  mgr.destroy();
});

test("isExpired respects backdated lastActivityAt", () => {
  const s = new CursorSession("x", "m");
  assert.equal(s.isExpired(1000), false);
  s.lastActivityAt = Date.now() - 2000;
  assert.equal(s.isExpired(1000), true);
});
