import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startProxyServer } from "../lib/proxy.js";
import { ModelCatalog } from "../lib/model-catalog.js";

const isWin = process.platform === "win32";
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-cursor-agent.mjs",
);

const catalog = new ModelCatalog();
catalog.adopt([
  { id: "gpt-5.5-low" },
  { id: "gpt-5.5-medium" },
  { id: "gpt-5.5-high" },
  { id: "auto" },
]);

let server;
let baseUrl;
let prevAgentPath;

before(async () => {
  fs.chmodSync(FIXTURE, 0o755);
  prevAgentPath = process.env.PI_CURSOR_AGENT_PATH;
  process.env.PI_CURSOR_AGENT_PATH = FIXTURE;
  server = startProxyServer({
    modelsFn: async () => [{ id: "gpt-5.5-high", object: "model" }],
    catalog,
    getAuthKey: () => null,
    host: "127.0.0.1",
    healthServiceId: "cursor-bridge-test",
    getLiveRunsCount: () => 0,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (prevAgentPath !== undefined) process.env.PI_CURSOR_AGENT_PATH = prevAgentPath;
  else delete process.env.PI_CURSOR_AGENT_PATH;
  server.closeAllConnections?.();
  server.close();
});

function postChat(body, headers = {}) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("/health reports service id and live runs", async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.deepEqual(await res.json(), { ok: true, service: "cursor-bridge-test", liveRuns: 0 });
});

test("/v1/models returns the model list", async () => {
  const res = await fetch(`${baseUrl}/v1/models`);
  const payload = await res.json();
  assert.equal(payload.object, "list");
  assert.equal(payload.data[0].id, "gpt-5.5-high");
});

test("400 on invalid JSON body", async () => {
  const res = await postChat("{not json");
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Invalid JSON/);
});

test("400 on missing messages", async () => {
  const res = await postChat({ model: "auto" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /messages is required/);
});

test("non-streaming happy path: JSON shape, usage mapping, reasoning text", { skip: isWin }, async () => {
  const res = await postChat({ model: "auto", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.object, "chat.completion");
  const msg = payload.choices[0].message;
  assert.equal(msg.role, "assistant");
  assert.equal(msg.content, "model=auto");
  assert.equal(msg.reasoning_text, "pondering...");
  assert.equal(payload.choices[0].finish_reason, "stop");
  assert.deepEqual(payload.usage, {
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18,
    cache_read_tokens: 3,
    cache_write_tokens: 2,
  });
});

test("streaming happy path: SSE chunks, usage chunk, stop, [DONE]", { skip: isWin }, async () => {
  const res = await postChat({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const text = await res.text();
  const events = text
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6));
  assert.equal(events.at(-1), "[DONE]");
  const parsed = events.slice(0, -1).map((e) => JSON.parse(e));
  const contentChunks = parsed.filter((p) => p.choices?.[0]?.delta?.content);
  assert.equal(contentChunks.map((p) => p.choices[0].delta.content).join(""), "model=auto");
  const reasoning = parsed.find((p) => p.choices?.[0]?.delta?.reasoning_content);
  assert.equal(reasoning.choices[0].delta.reasoning_content, "pondering...");
  const usageChunk = parsed.find((p) => p.usage);
  assert.equal(usageChunk.usage.prompt_tokens, 11);
  assert.equal(usageChunk.usage.completion_tokens, 7);
  const stop = parsed.find((p) => p.choices?.[0]?.finish_reason === "stop");
  assert.ok(stop);
});

test("family base id + reasoning_effort resolves via the catalog", { skip: isWin }, async () => {
  const res = await postChat({
    model: "cursor-bridge/gpt-5.5",
    reasoning_effort: "high",
    messages: [{ role: "user", content: "hi" }],
  });
  const payload = await res.json();
  assert.equal(payload.choices[0].message.content, "model=gpt-5.5-high");
  assert.equal(payload.model, "gpt-5.5-high");
});

test("same X-Session-Id pins the first request's model", { skip: isWin }, async () => {
  const sid = `test-session-${Date.now()}`;
  const r1 = await postChat(
    { model: "gpt-5.5", reasoning_effort: "low", messages: [{ role: "user", content: "a" }] },
    { "X-Session-Id": sid },
  );
  assert.equal((await r1.json()).choices[0].message.content, "model=gpt-5.5-low");
  const r2 = await postChat(
    { model: "gpt-5.5", reasoning_effort: "high", messages: [{ role: "user", content: "b" }] },
    { "X-Session-Id": sid },
  );
  // Model pinned at session creation — the second request keeps gpt-5.5-low.
  assert.equal((await r2.json()).choices[0].message.content, "model=gpt-5.5-low");
});

test("spawn error: non-streaming returns 500 JSON", { skip: isWin }, async () => {
  process.env.PI_CURSOR_AGENT_PATH = "/nonexistent-cursor-agent";
  try {
    const res = await postChat({ model: "auto", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.match(payload.error.message, /Failed to spawn cursor-agent CLI/);
    assert.equal(payload.error.type, "server_error");
  } finally {
    process.env.PI_CURSOR_AGENT_PATH = FIXTURE;
  }
});

test("spawn error: streaming emits error chunk + [DONE]", { skip: isWin }, async () => {
  process.env.PI_CURSOR_AGENT_PATH = "/nonexistent-cursor-agent";
  try {
    const res = await postChat({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /cursor-bridge error:/);
    assert.match(text, /"finish_reason":"error"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    process.env.PI_CURSOR_AGENT_PATH = FIXTURE;
  }
});

test("404 on unknown path", async () => {
  const res = await fetch(`${baseUrl}/nope`);
  assert.equal(res.status, 404);
});
