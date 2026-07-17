import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CACHE_FORMAT_VERSION,
  getAuthHash,
  getCacheFilePath,
  loadModelCache,
  saveModelCache,
} from "../lib/model-cache.js";

const MODELS = [
  { id: "gpt-5.5-high", name: "GPT-5.5 High", contextWindow: 1_050_000 },
  { id: "auto", name: "Auto" },
];

let tmpHome;
let prevHome;
let prevApiKey;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-cache-test-"));
  prevHome = process.env.HOME;
  prevApiKey = process.env.CURSOR_API_KEY;
  process.env.HOME = tmpHome;
  delete process.env.CURSOR_API_KEY;
});

afterEach(() => {
  process.env.HOME = prevHome;
  if (prevApiKey !== undefined) process.env.CURSOR_API_KEY = prevApiKey;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test("save then load round-trips models for the same auth key", async () => {
  await saveModelCache(MODELS, "1.2.3", "ck-abc");
  const entry = loadModelCache({}, "ck-abc");
  assert.ok(entry);
  assert.equal(entry.models.length, 2);
  assert.equal(entry.models[0].id, "gpt-5.5-high");
  assert.equal(entry.models[0].contextWindow, 1_050_000);
});

test("load misses for a different auth key", async () => {
  await saveModelCache(MODELS, "1.2.3", "ck-abc");
  assert.equal(loadModelCache({}, "ck-other"), null);
});

test("expired entries return null unless allowStale", async () => {
  await saveModelCache(MODELS, "", "ck-abc");
  // Backdate the entry beyond TTL
  const file = getCacheFilePath();
  const cache = JSON.parse(fs.readFileSync(file, "utf8"));
  const hash = getAuthHash("ck-abc");
  cache.entries[hash].cachedAt = Date.now() - 999_999_999;
  fs.writeFileSync(file, JSON.stringify(cache));
  assert.equal(loadModelCache({}, "ck-abc"), null);
  const stale = loadModelCache({ allowStale: true }, "ck-abc");
  assert.ok(stale);
  assert.equal(stale.models.length, 2);
});

test("corrupt cache file is deleted and load returns null", () => {
  const file = getCacheFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{not json");
  assert.equal(loadModelCache({}, "ck-abc"), null);
  assert.equal(fs.existsSync(file), false);
});

test("format-version mismatch returns null", async () => {
  await saveModelCache(MODELS, "", "ck-abc");
  const file = getCacheFilePath();
  const cache = JSON.parse(fs.readFileSync(file, "utf8"));
  cache.formatVersion = CACHE_FORMAT_VERSION + 1;
  fs.writeFileSync(file, JSON.stringify(cache));
  assert.equal(loadModelCache({}, "ck-abc"), null);
});

test("getAuthHash is stable per key and env var wins", () => {
  const a = getAuthHash("ck-abc");
  assert.equal(getAuthHash("ck-abc"), a);
  assert.notEqual(getAuthHash("ck-other"), a);
  process.env.CURSOR_API_KEY = "env-key";
  const envHash = getAuthHash("ck-abc");
  assert.notEqual(envHash, a);
  assert.equal(getAuthHash(null), envHash); // env overrides everything
  delete process.env.CURSOR_API_KEY;
});
