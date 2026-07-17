import { test } from "node:test";
import assert from "node:assert/strict";
import { parseModelId } from "../lib/cursor-helpers.js";

test("parseModelId: null for empty, auto, and standalone models", () => {
  assert.equal(parseModelId(""), null);
  assert.equal(parseModelId("auto"), null);
  assert.equal(parseModelId("composer-2"), null);
  assert.equal(parseModelId("gemini-3.1-pro"), null);
});

test("parseModelId: plain effort-suffixed model", () => {
  assert.deepEqual(parseModelId("gpt-5.5-high"), {
    base: "gpt-5.5",
    effort: "high",
    isThinking: false,
    originalModelId: "gpt-5.5-high",
    isFast: false,
  });
});

test("parseModelId: longest effort token wins (extra-high before high)", () => {
  const parsed = parseModelId("gpt-5.5-extra-high");
  assert.equal(parsed.base, "gpt-5.5");
  assert.equal(parsed.effort, "extra-high");
});

test("parseModelId: thinking infix keeps -thinking in the family base", () => {
  assert.deepEqual(parseModelId("claude-opus-4-7-thinking-high"), {
    base: "claude-opus-4-7-thinking",
    effort: "high",
    isThinking: true,
    originalModelId: "claude-opus-4-7-thinking-high",
    isFast: false,
  });
});

test("parseModelId: effort + trailing -thinking suffix", () => {
  const parsed = parseModelId("claude-4.6-sonnet-medium-thinking");
  assert.equal(parsed.base, "claude-4.6-sonnet");
  assert.equal(parsed.effort, "medium");
  assert.equal(parsed.isThinking, true);
});

test("parseModelId: boolean-thinking model (no effort token)", () => {
  assert.deepEqual(parseModelId("claude-4.5-sonnet-thinking"), {
    base: "claude-4.5-sonnet",
    effort: null,
    isThinking: true,
    originalModelId: "claude-4.5-sonnet-thinking",
    isFast: false,
  });
});

test("parseModelId: -fast suffix is stripped and flagged", () => {
  const parsed = parseModelId("gpt-5.5-high-fast");
  assert.equal(parsed.base, "gpt-5.5");
  assert.equal(parsed.effort, "high");
  assert.equal(parsed.isFast, true);
  // standalone fast model still returns null (no effort token)
  assert.equal(parseModelId("composer-2-fast"), null);
});

test("parseModelId: @ context suffix is stripped before parsing", () => {
  const parsed = parseModelId("gpt-5.5-high@1m");
  assert.equal(parsed.base, "gpt-5.5");
  assert.equal(parsed.effort, "high");
  assert.equal(parsed.originalModelId, "gpt-5.5-high@1m");
});

test("parseModelId: effort token alone (empty base) is not a family", () => {
  assert.equal(parseModelId("-high"), null);
});
