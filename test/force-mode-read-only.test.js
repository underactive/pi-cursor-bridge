import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Contract: PI_CURSOR_FORCE_MODE must force BOTH backends into Cursor's native
// read-only modes. Embedders (e.g. pi-moa-plan's plan-mode subagents) rely on
// this — Cursor models are full agents with their own local edit/shell tools,
// so pi-side tool allowlists cannot stop them from writing to the workspace.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "extensions", "cursor-bridge.js"), "utf8");
// forceMode() itself lives in lib/cursor-cli.js (bound into the extension by importLib).
const cliSource = readFileSync(path.join(root, "lib", "cursor-cli.js"), "utf8");

test("forceMode() reads PI_CURSOR_FORCE_MODE per run and accepts only plan/ask", () => {
	assert.match(cliSource, /function forceMode\(\)/);
	assert.match(cliSource, /process\.env\.PI_CURSOR_FORCE_MODE/);
	assert.match(cliSource, /v === "plan" \|\| v === "ask" \? v : null/);
});

test("CLI path: --mode replaces --force when forceMode() is set", () => {
	assert.match(source, /if \(cliForceMode\) args\.push\("--mode", cliForceMode\);\s*\n\s*else args\.push\("--force"\);/);
	// --force must never be an unconditional completion-spawn arg.
	assert.doesNotMatch(source, /"--model", effectiveModel, "--trust", "--force"/);
});

test("SDK path: Agent.create uses plan mode when forceMode() is set", () => {
	assert.match(source, /mode: forceMode\(\) \? "plan" : "agent"/);
	// No unconditional agent-mode Agent.create may remain.
	assert.doesNotMatch(source, /mode: "agent",/);
});
