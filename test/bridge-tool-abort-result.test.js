import assert from "node:assert/strict";
import test from "node:test";

import { isBridgeToolAbortResult } from "../lib/cursor-helpers.js";

test("isBridgeToolAbortResult: detects Pi operation abort text", () => {
  assert.equal(isBridgeToolAbortResult({
    role: "toolResult",
    toolCallId: "t1",
    content: [{ type: "text", text: "Operation aborted" }],
    isError: true,
  }), true);
});

test("isBridgeToolAbortResult: detects request aborted string content", () => {
  assert.equal(isBridgeToolAbortResult({
    role: "toolResult",
    toolCallId: "t1",
    content: "Request was aborted.",
    isError: true,
  }), true);
});

test("isBridgeToolAbortResult: ignores ordinary tool errors", () => {
  assert.equal(isBridgeToolAbortResult({
    role: "toolResult",
    toolCallId: "t1",
    content: [{ type: "text", text: "ENOENT: no such file or directory" }],
    isError: true,
  }), false);
});

test("isBridgeToolAbortResult: ignores non-tool messages", () => {
  assert.equal(isBridgeToolAbortResult({ role: "user", content: "Operation aborted" }), false);
});
