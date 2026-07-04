import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bridgeToolSteeringHints,
  enhanceBridgeInputSchema,
  enhanceBridgeToolDescription,
  normalizeBridgeToolArgs,
} from "../lib/cursor-helpers.js";

test("enhanceBridgeInputSchema: edit marks path and edits required with explicit description", () => {
  const schema = enhanceBridgeInputSchema("edit", {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit" },
      edits: { type: "array" },
    },
  });
  assert.deepEqual(schema.required, ["path", "edits"]);
  assert.match(schema.properties.path.description, /REQUIRED/);
  assert.match(schema.properties.path.description, /Path to the file to edit/);
});

test("enhanceBridgeInputSchema: non-path tools pass through unchanged", () => {
  const schema = { type: "object", properties: { pattern: { type: "string" } } };
  assert.equal(enhanceBridgeInputSchema("grep", schema), schema);
});

test("normalizeBridgeToolArgs: maps file_path alias to path for edit", () => {
  const out = normalizeBridgeToolArgs("edit", {
    file_path: "src/foo.ts",
    edits: [{ oldText: "a", newText: "b" }],
  });
  assert.deepEqual(out, {
    path: "src/foo.ts",
    edits: [{ oldText: "a", newText: "b" }],
  });
});

test("normalizeBridgeToolArgs: keeps explicit path and strips aliases", () => {
  const out = normalizeBridgeToolArgs("write", {
    path: "a.ts",
    file_path: "ignored.ts",
    content: "x",
  });
  assert.deepEqual(out, { path: "a.ts", content: "x" });
});

test("bridgeToolSteeringHints: includes pi_edit guidance when edit is bridged", () => {
  const hints = bridgeToolSteeringHints(["pi_read", "pi_edit"]);
  assert.ok(hints.some((line) => line.includes("pi_edit") && line.includes("path")));
});

test("enhanceBridgeToolDescription: edit mentions required path and edits", () => {
  const desc = enhanceBridgeToolDescription("edit", "Edit a file.");
  assert.match(desc, /path/i);
  assert.match(desc, /edits/i);
});
