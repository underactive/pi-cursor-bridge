#!/usr/bin/env node
/**
 * Fake cursor-agent for proxy smoke tests (test/proxy.test.js).
 *
 * Modes:
 *   - `models --trust`: print two canned model lines and exit 0.
 *   - anything else: read stdin to EOF, then emit canned NDJSON events on
 *     stdout mirroring cursor-agent's --output-format stream-json:
 *       thinking → assistant (echoes the --model argv value) → result (usage).
 *
 * Echoing the resolved --model in the assistant text lets tests observe
 * family/effort variant resolution and session model pinning end-to-end.
 */

const argv = process.argv.slice(2);

if (argv[0] === "models") {
  process.stdout.write("gpt-5.5-high - GPT-5.5 1M High\n");
  process.stdout.write("auto - Auto (default)\n");
  process.exit(0);
}

const modelIdx = argv.indexOf("--model");
const model = modelIdx >= 0 ? argv[modelIdx + 1] : "unknown";

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  emit({ type: "thinking", content: "pondering..." });
  emit({
    type: "assistant",
    message: { content: [{ type: "text", text: `model=${model}` }] },
  });
  emit({
    type: "result",
    usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2 },
  });
  process.exit(0);
});
