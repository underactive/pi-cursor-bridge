import { test } from "node:test";
import assert from "node:assert/strict";
import {
  forceMode,
  cursorAgentEnv,
  buildPromptFromMessages,
  normalizeModel,
  formatCursorError,
} from "../lib/cursor-cli.js";

test("forceMode parses env per call", () => {
  delete process.env.PI_CURSOR_FORCE_MODE;
  assert.equal(forceMode(), null);
  process.env.PI_CURSOR_FORCE_MODE = "plan";
  assert.equal(forceMode(), "plan");
  process.env.PI_CURSOR_FORCE_MODE = "ASK";
  assert.equal(forceMode(), "ask");
  process.env.PI_CURSOR_FORCE_MODE = "agent";
  assert.equal(forceMode(), null);
  delete process.env.PI_CURSOR_FORCE_MODE;
});

test("cursorAgentEnv injects CURSOR_API_KEY only when a key is given", () => {
  const withKey = cursorAgentEnv("ck-test");
  assert.equal(withKey.CURSOR_API_KEY, "ck-test");
  const prev = process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_API_KEY;
  const withoutKey = cursorAgentEnv(null);
  assert.equal(withoutKey.CURSOR_API_KEY, undefined);
  if (prev !== undefined) process.env.CURSOR_API_KEY = prev;
});

test("buildPromptFromMessages formats roles and skips empties", () => {
  const prompt = buildPromptFromMessages([
    { role: "system", content: "sys" },
    { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url" }] },
    { role: "assistant", content: "yo" },
    { role: "tool", name: "read", content: "data" },
    { role: "user", content: "" },
  ]);
  assert.match(prompt, /<\|im_start\|>system\nsys\n<\|im_end\|>/);
  assert.match(prompt, /<\|im_start\|>user\nhi\n<\|im_end\|>/);
  assert.match(prompt, /<\|im_start\|>assistant\nyo\n<\|im_end\|>/);
  assert.match(prompt, /<\|im_start\|>tool \(read\)\ndata\n<\|im_end\|>/);
  assert.equal(prompt.match(/<\|im_start\|>/g).length, 4);
});

test("normalizeModel strips provider prefix and @ context suffix", () => {
  assert.equal(normalizeModel(""), "auto");
  assert.equal(normalizeModel(undefined), "auto");
  assert.equal(normalizeModel("cursor-bridge/gpt-5.5-high"), "gpt-5.5-high");
  assert.equal(normalizeModel("gpt-5.5-high@1m"), "gpt-5.5-high");
  assert.equal(normalizeModel("cursor-bridge/claude-4.6-opus-high@400k"), "claude-4.6-opus-high");
});

test("formatCursorError maps common failures", () => {
  assert.match(formatCursorError("Quota exceeded"), /Quota exceeded/);
  assert.match(formatCursorError("auth token invalid"), /cursor-agent login/);
  assert.match(formatCursorError("rate limit hit"), /Rate limited/);
  assert.match(formatCursorError("model xyz not found"), /Model not found/);
  assert.match(formatCursorError("boom"), /cursor-bridge error: boom/);
});
