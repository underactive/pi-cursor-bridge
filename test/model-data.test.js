import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_MODELS,
  FALLBACK_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  MODEL_CONTEXT_WINDOWS,
  MAX_TOKENS_MAP,
  VISION_CAPABLE_SDK_MODELS,
  contextWindowToSuffix,
  parseContextFromDisplayName,
} from "../lib/model-data.js";

test("contextWindowToSuffix formats known values", () => {
  assert.equal(contextWindowToSuffix(1_000_000), "1m");
  assert.equal(contextWindowToSuffix(1_050_000), "1m");
  assert.equal(contextWindowToSuffix(400_000), "400k");
  assert.equal(contextWindowToSuffix(200_000), "200k");
  assert.equal(contextWindowToSuffix(256_000), "256k");
});

test("parseContextFromDisplayName parses annotations", () => {
  assert.equal(parseContextFromDisplayName("Opus 4.8 1M"), 1_000_000);
  assert.equal(parseContextFromDisplayName("GPT-5.2 400K"), 400_000);
  assert.equal(parseContextFromDisplayName("Codex 5.3 Low"), null);
  assert.equal(parseContextFromDisplayName(""), null);
  assert.equal(parseContextFromDisplayName(null), null);
});

test("family and fallback lookups behave", () => {
  assert.equal(MODEL_CONTEXT_WINDOWS["gpt-5.5"], 1_050_000);
  assert.equal(MODEL_CONTEXT_WINDOWS["nonexistent"] ?? FALLBACK_CONTEXT_WINDOW, FALLBACK_CONTEXT_WINDOW);
});

test("MAX_TOKENS_MAP mirrors MODEL_CONTEXT_WINDOWS keys with the default", () => {
  assert.deepEqual(Object.keys(MAX_TOKENS_MAP), Object.keys(MODEL_CONTEXT_WINDOWS));
  for (const v of Object.values(MAX_TOKENS_MAP)) assert.equal(v, DEFAULT_MAX_TOKENS);
});

test("FALLBACK_MODELS and vision set are non-empty", () => {
  assert.ok(FALLBACK_MODELS.length > 0);
  assert.ok(FALLBACK_MODELS.includes("auto"));
  assert.ok(VISION_CAPABLE_SDK_MODELS.has("gpt-5.5"));
});
