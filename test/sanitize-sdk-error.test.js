import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSdkError } from "../lib/cursor-helpers.js";

// L2: scrub the API key from both error.message and error.stack.

const KEY = "key_secret_ABC123";

test("sanitizeSdkError: key scrubbed from the returned message", () => {
  const err = new Error(`request failed with ${KEY}`);
  const out = sanitizeSdkError(err, KEY);
  assert.ok(!out.includes(KEY), "returned message must not contain the key");
});

test("sanitizeSdkError: key scrubbed from error.stack in place", () => {
  const err = new Error(`boom ${KEY}`);
  // Ensure the stack actually contains the key (constructed from the message).
  err.stack = `Error: boom ${KEY}\n    at somewhere (/app/x.js:1:1)`;
  const out = sanitizeSdkError(err, KEY);
  assert.ok(!out.includes(KEY), "returned message must not contain the key");
  assert.ok(!err.stack.includes(KEY), "error.stack must not contain the key after sanitize");
  assert.ok(err.stack.includes("***"), "scrubbed stack should show the redaction marker");
});

test("sanitizeSdkError: category mapping still applies (auth)", () => {
  const err = new Error("401 Unauthorized");
  const out = sanitizeSdkError(err, KEY);
  assert.match(out, /Authentication failed/);
});

test("sanitizeSdkError: no apiKey provided leaves message intact, no throw", () => {
  const err = new Error("some generic failure");
  const out = sanitizeSdkError(err, "");
  assert.match(out, /Cursor SDK error: some generic failure/);
});
