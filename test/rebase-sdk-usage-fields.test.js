import { test } from "node:test";
import assert from "node:assert/strict";
import { rebaseSdkUsageFields } from "../lib/cursor-helpers.js";

// Regression: Pi's silent context-overflow check flags a successful turn when
// usage.input + usage.cacheRead > model.contextWindow. The SDK backend must
// therefore never echo Cursor's server-side input/cacheRead into those fields —
// they describe Cursor's internal agent context and a cumulative, unbounded
// cacheRead, not Pi's forwarded (compactable) conversation. These cases use the
// real numbers observed in the sessions that tripped the bug.

test("rebaseSdkUsageFields: cacheRead/cacheWrite are always zeroed", () => {
  // Short-session turn: Cursor reported input=127150, cacheRead=109374 (sum
  // 236524 > the 200000 window → false overflow). The rebased fields must drop
  // the cache entirely so input + cacheRead reflects only Pi's prompt.
  const fields = rebaseSdkUsageFields(1704, { input: 480, total: 540 });
  assert.equal(fields.cacheRead, 0);
  assert.equal(fields.cacheWrite, 0);
});

test("rebaseSdkUsageFields: input comes from the Pi estimate, not Cursor", () => {
  const fields = rebaseSdkUsageFields(1704, { input: 480, total: 540 });
  assert.equal(fields.input, 480);
  assert.equal(fields.output, 1704);
  assert.equal(fields.totalTokens, 540);
  // The overflow comparand (input + cacheRead) tracks the forwarded prompt only.
  assert.equal(fields.input + fields.cacheRead, 480);
});

test("rebaseSdkUsageFields: a huge Cursor turn still yields a bounded comparand", () => {
  // Big-session final turn: input=822555, cacheRead=780098 (sum 1.6M). The
  // rebased comparand must stay at the forwarded-prompt estimate (~22k), well
  // under any sane window — never Cursor's cumulative total.
  const fields = rebaseSdkUsageFields(22000, { input: 21000, total: 22079 });
  assert.equal(fields.input + fields.cacheRead, 21000);
  assert.equal(fields.totalTokens, 22079);
});

test("rebaseSdkUsageFields: missing estimate falls back to input 0 + real output", () => {
  const fields = rebaseSdkUsageFields(1200, undefined);
  assert.equal(fields.input, 0);
  assert.equal(fields.output, 1200);
  assert.equal(fields.cacheRead, 0);
  assert.equal(fields.totalTokens, 1200); // input(0) + output(1200)
});

test("rebaseSdkUsageFields: empty/zero estimate values are treated as absent", () => {
  const fields = rebaseSdkUsageFields(0, { input: 0, total: 0 });
  assert.equal(fields.input, 0);
  assert.equal(fields.output, 0);
  assert.equal(fields.totalTokens, 0);
});

test("rebaseSdkUsageFields: negative/garbage output is clamped to 0", () => {
  const fields = rebaseSdkUsageFields(-5, { input: 100, total: 150 });
  assert.equal(fields.output, 0);
  assert.equal(fields.input, 100);
  assert.equal(fields.totalTokens, 150);
});
