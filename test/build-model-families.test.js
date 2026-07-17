import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModelFamilies, resolveModelVariant } from "../lib/cursor-helpers.js";

const mk = (ids) => ids.map((id) => ({ id }));

test("buildModelFamilies: groups effort variants into a family with medium default", () => {
  const { variantMap, standaloneModels } = buildModelFamilies(
    mk(["gpt-5.5-low", "gpt-5.5-medium", "gpt-5.5-high"]),
  );
  const entry = variantMap["gpt-5.5"];
  assert.ok(entry);
  assert.equal(entry.defaultVariant, "gpt-5.5-medium");
  assert.deepEqual(entry.variants, {
    low: "gpt-5.5-low",
    medium: "gpt-5.5-medium",
    high: "gpt-5.5-high",
  });
  assert.deepEqual(standaloneModels, []);
});

test("buildModelFamilies: unparseable models stay standalone", () => {
  const { variantMap, standaloneModels } = buildModelFamilies(
    mk(["auto", "composer-2", "gemini-3.1-pro"]),
  );
  assert.deepEqual(variantMap, {});
  assert.deepEqual(standaloneModels.sort(), ["auto", "composer-2", "gemini-3.1-pro"]);
});

test("buildModelFamilies: thinking variants land in thinkingVariants", () => {
  const { variantMap } = buildModelFamilies(
    mk(["claude-4.6-sonnet-medium", "claude-4.6-sonnet-medium-thinking"]),
  );
  const entry = variantMap["claude-4.6-sonnet"];
  assert.equal(entry.variants.medium, "claude-4.6-sonnet-medium");
  assert.equal(entry.thinkingVariants.medium, "claude-4.6-sonnet-medium-thinking");
});

test("buildModelFamilies: boolean-thinking variant maps to 'on'", () => {
  const { variantMap } = buildModelFamilies(
    mk(["claude-4.5-sonnet", "claude-4.5-sonnet-thinking"]),
  );
  const entry = variantMap["claude-4.5-sonnet"];
  assert.ok(entry);
  assert.equal(entry.thinkingVariants.on, "claude-4.5-sonnet-thinking");
  // The standalone base is linked into the family as the "off" default
  assert.equal(entry.variants.off, "claude-4.5-sonnet");
  assert.equal(entry.defaultVariant, "claude-4.5-sonnet");
});

test("buildModelFamilies: linked standalone base is removed from standaloneModels", () => {
  const { standaloneModels } = buildModelFamilies(
    mk(["claude-4.5-sonnet", "claude-4.5-sonnet-thinking", "composer-2"]),
  );
  assert.deepEqual(standaloneModels, ["composer-2"]);
});

test("buildModelFamilies: high is default when medium missing", () => {
  const { variantMap } = buildModelFamilies(mk(["claude-4.5-opus-high"]));
  assert.equal(variantMap["claude-4.5-opus"].defaultVariant, "claude-4.5-opus-high");
});

test("resolveModelVariant: unknown family returns null", () => {
  assert.equal(resolveModelVariant("nope", undefined, {}), null);
});

test("resolveModelVariant: no effort or 'off' resolves the default variant", () => {
  const { variantMap } = buildModelFamilies(mk(["gpt-5.5-medium", "gpt-5.5-high"]));
  assert.equal(resolveModelVariant("gpt-5.5", undefined, variantMap), "gpt-5.5-medium");
  assert.equal(resolveModelVariant("gpt-5.5", "off", variantMap), "gpt-5.5-medium");
});

test("resolveModelVariant: thinking variant preferred over non-thinking at same effort", () => {
  const { variantMap } = buildModelFamilies(
    mk(["claude-4.6-sonnet-medium", "claude-4.6-sonnet-medium-thinking"]),
  );
  assert.equal(
    resolveModelVariant("claude-4.6-sonnet", "medium", variantMap),
    "claude-4.6-sonnet-medium-thinking",
  );
});

test("resolveModelVariant: falls back to non-thinking variant, else null", () => {
  const { variantMap } = buildModelFamilies(mk(["gpt-5.5-medium", "gpt-5.5-high"]));
  assert.equal(resolveModelVariant("gpt-5.5", "high", variantMap), "gpt-5.5-high");
  assert.equal(resolveModelVariant("gpt-5.5", "xhigh", variantMap), null);
});
