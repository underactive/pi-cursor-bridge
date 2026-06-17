import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateConversationTokens } from "../lib/cursor-helpers.js";

// The SDK backend reports this value as usage.totalTokens so Pi's context gauge
// (and auto-compaction) track Pi's OWN forwarded conversation rather than
// Cursor's internal agent-loop accounting. The block-counting MUST mirror Pi's
// own estimateTokens() for assistant messages (text + thinking + toolCall
// name/args) so the gauge stays stable across turns.

test("estimateConversationTokens: ceil(chars / 4) for prompt-only", () => {
  // 9 chars / 4 = 2.25 → ceil → 3
  assert.equal(estimateConversationTokens("123456789", []), 3);
});

test("estimateConversationTokens: empty prompt + no blocks → 0", () => {
  assert.equal(estimateConversationTokens("", []), 0);
  assert.equal(estimateConversationTokens("", undefined), 0);
});

test("estimateConversationTokens: counts text + thinking output blocks", () => {
  const blocks = [
    { type: "text", text: "aaaa" },       // 4
    { type: "thinking", thinking: "bbbb" }, // 4
  ];
  // prompt 4 + 4 + 4 = 12 chars / 4 = 3
  assert.equal(estimateConversationTokens("cccc", blocks), 3);
});

test("estimateConversationTokens: toolCall counts name + serialized arguments", () => {
  const blocks = [{ type: "toolCall", name: "ls", arguments: { path: "/" } }];
  // name "ls" = 2, JSON.stringify({path:"/"}) = '{"path":"/"}' = 12 → 14 chars
  // 14 / 4 = 3.5 → ceil → 4
  assert.equal(estimateConversationTokens("", blocks), 4);
});

test("estimateConversationTokens: toolCall with missing arguments serializes {}", () => {
  const blocks = [{ type: "toolCall", name: "x" }];
  // "x" = 1, JSON.stringify({}) = "{}" = 2 → 3 chars / 4 → ceil → 1
  assert.equal(estimateConversationTokens("", blocks), 1);
});

test("estimateConversationTokens: unknown block types contribute 0", () => {
  const blocks = [{ type: "image" }, { type: "toolResult", content: "ignored" }, null];
  assert.equal(estimateConversationTokens("abcd", blocks), 1); // just the 4-char prompt
});

test("estimateConversationTokens: respects a custom charsPerToken", () => {
  // 10 chars / 5 = 2
  assert.equal(estimateConversationTokens("0123456789", [], 5), 2);
});

test("estimateConversationTokens: non-positive charsPerToken falls back to 4", () => {
  assert.equal(estimateConversationTokens("12345678", [], 0), 2); // 8/4
});

test("estimateConversationTokens: non-string prompt treated as empty", () => {
  assert.equal(estimateConversationTokens(undefined, [{ type: "text", text: "aaaa" }]), 1);
});
