import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelCatalog } from "../lib/model-catalog.js";

const MODELS = [
  { id: "gpt-5.5-low" },
  { id: "gpt-5.5-medium" },
  { id: "gpt-5.5-high" },
  { id: "auto" },
];

test("adopt builds the variant map from models", () => {
  const catalog = new ModelCatalog();
  assert.deepEqual(catalog.variantMap, {});
  catalog.adopt(MODELS);
  assert.ok(catalog.variantMap["gpt-5.5"]);
});

test("clear empties the map", () => {
  const catalog = new ModelCatalog();
  catalog.adopt(MODELS);
  catalog.clear();
  assert.deepEqual(catalog.variantMap, {});
});

test("L5 snapshot stability: adopt/clear replace, never mutate", () => {
  const catalog = new ModelCatalog();
  catalog.adopt(MODELS);
  const snapshot = catalog.variantMap;
  const snapshotKeys = Object.keys(snapshot);

  catalog.adopt([{ id: "claude-4.6-opus-high" }, { id: "claude-4.6-opus-medium" }]);
  assert.notEqual(catalog.variantMap, snapshot);
  assert.deepEqual(Object.keys(snapshot), snapshotKeys); // old reference untouched

  catalog.clear();
  assert.deepEqual(Object.keys(snapshot), snapshotKeys);
});

test("resolve returns default and effort variants", () => {
  const catalog = new ModelCatalog();
  catalog.adopt(MODELS);
  assert.equal(catalog.resolve("gpt-5.5", "high"), "gpt-5.5-high");
  const defaultVariant = catalog.resolve("gpt-5.5", undefined);
  assert.ok(defaultVariant && defaultVariant.startsWith("gpt-5.5-"));
  assert.equal(catalog.resolve("unknown-model", "high"), null);
});
