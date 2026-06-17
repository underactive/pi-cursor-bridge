import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSdkDeferred } from "../lib/cursor-helpers.js";

// L1: settle-once guard on the bridge deferred.

test("makeSdkDeferred: resolve flips settled and yields the value", async () => {
  const d = makeSdkDeferred();
  assert.equal(d.settled, false);
  d.resolve("first");
  assert.equal(d.settled, true);
  assert.equal(await d.promise, "first");
});

test("makeSdkDeferred: a second resolve is a no-op (value unchanged)", async () => {
  const d = makeSdkDeferred();
  d.resolve("first");
  d.resolve("second");
  assert.equal(d.settled, true);
  assert.equal(await d.promise, "first");
});

test("makeSdkDeferred: reject after resolve is a no-op (stays resolved)", async () => {
  const d = makeSdkDeferred();
  d.resolve("ok");
  d.reject(new Error("late"));
  assert.equal(d.settled, true);
  assert.equal(await d.promise, "ok");
});

test("makeSdkDeferred: reject flips settled and rejects once", async () => {
  const d = makeSdkDeferred();
  d.reject(new Error("boom"));
  d.resolve("ignored");
  assert.equal(d.settled, true);
  await assert.rejects(d.promise, /boom/);
});
