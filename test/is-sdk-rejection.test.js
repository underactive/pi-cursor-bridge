import { test } from "node:test";
import assert from "node:assert/strict";
import { isSdkRejection } from "../lib/cursor-helpers.js";

// M5: only swallow rejections whose TOP stack frame is in @cursor/sdk.

test("isSdkRejection: top frame inside node_modules/@cursor/sdk/ → true", () => {
  const reason = new Error("boom");
  reason.stack = [
    "Error: boom",
    "    at Agent.send (/app/node_modules/@cursor/sdk/dist/index.js:42:7)",
    "    at /app/extensions/cursor-agent.js:2100:5",
  ].join("\n");
  assert.equal(isSdkRejection(reason), true);
});

test("isSdkRejection: message mentions @cursor/sdk but top frame is app code → false", () => {
  const reason = new Error("failed talking to @cursor/sdk");
  reason.stack = [
    "Error: failed talking to @cursor/sdk",
    "    at handleChatCompletions (/app/extensions/cursor-agent.js:900:5)",
    "    at Server.<anonymous> (/app/extensions/cursor-agent.js:1260:9)",
  ].join("\n");
  assert.equal(isSdkRejection(reason), false);
});

test("isSdkRejection: @cursor/sdk only in a deeper frame → false (not the top)", () => {
  const reason = new Error("nope");
  reason.stack = [
    "Error: nope",
    "    at appThing (/app/extensions/cursor-agent.js:10:1)",
    "    at Agent.send (/app/node_modules/@cursor/sdk/dist/index.js:42:7)",
  ].join("\n");
  assert.equal(isSdkRejection(reason), false);
});

test("isSdkRejection: a plain string reason → false (no stack)", () => {
  assert.equal(isSdkRejection("something about @cursor/sdk"), false);
});

test("isSdkRejection: undefined/no-stack reason → false", () => {
  assert.equal(isSdkRejection(undefined), false);
  assert.equal(isSdkRejection({}), false);
});
