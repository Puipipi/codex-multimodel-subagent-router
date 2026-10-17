import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { createNativeGateway } from "../scripts/native-gateway.mjs";

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const deepEqual = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1; };

const dir = await mkdtemp(path.join(os.tmpdir(), "native-gateway-"));
const logPath = path.join(dir, "gateway.jsonl");
const calls = [];

function sse(usage = { input_tokens: 2, output_tokens: 3, total_tokens: 5 }) {
  return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { usage } })}\n\n`, {
    status: 200, headers: { "content-type": "text/event-stream" },
  });
}

function relaySse(payload, usage = { input_tokens: 7, output_tokens: 11, total_tokens: 18 }) {
  const args = JSON.stringify({ payload });
  return new Response([
    `data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", name: "relay_external_agent_payload", id: "fc_1", call_id: "call_1" } })}`,
    "",
    `data: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: args })}`,
    "",
    `data: ${JSON.stringify({ type: "response.completed", response: { usage } })}`,
    "",
  ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const fakeFetch = async (url, options) => {
  const rawBody = Buffer.isBuffer(options.body) ? Buffer.from(options.body) : Buffer.from(String(options.body || ""));
  const body = rawBody.toString("utf8");
  const headers = new Headers(options.headers);
  calls.push({ url, headers, body, rawBody });
  if (url.startsWith("https://native.test")) {
    if (body.includes("relay_external_agent_payload")) return relaySse("RELAYED PLAINTEXT");
    return sse({ input_tokens: 20, output_tokens: 4, total_tokens: 24 });
  }
  if (url.startsWith("https://deepseek.test")) return sse({ input_tokens: 30, output_tokens: 6, total_tokens: 36 });
  throw new Error(`unexpected URL ${url}`);
};

const token = "test-token";
const gateway = createNativeGateway({
  deepSeekKey: "ds-test-key", logPath, token, fetchImpl: fakeFetch,
  nativeBase: "https://native.test", deepSeekBase: "https://deepseek.test",
});
const port = await gateway.start();
const base = `http://127.0.0.1:${port}/${token}/v1/responses`;

try {
  const health = await fetch(`http://127.0.0.1:${port}/${token}/_health`);
  const healthBody = await health.json();
  equal(healthBody.pid, process.pid, "health identifies the real gateway process PID");

  const chatgptBody = JSON.stringify({ model: "gpt-6.1-sol", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "main" }] }] });
  const gpt = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer chatgpt-test", "chatgpt-account-id": "acct", "x-codex-parent-thread-id": "parent-1", "thread-id": "parent-1" },
    body: chatgptBody,
  });
  equal(gpt.status, 200, "GPT request succeeds");
  const gptCall = calls.find((call) => call.url.startsWith("https://native.test") && !call.body.includes("relay_external_agent_payload"));
  equal(gptCall.body, chatgptBody, "unrecognized model body is raw-transparent");
  equal(gptCall.headers.get("authorization"), "Bearer chatgpt-test", "GPT authorization is relayed");
  equal(gptCall.headers.get("chatgpt-account-id"), "acct", "GPT account header is relayed");

  const gzipBody = gzipSync(Buffer.from(chatgptBody));
  const gz = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: "Bearer chatgpt-test" },
    body: gzipBody,
  });
  equal(gz.status, 200, "gzip GPT request succeeds");
  const gzipCall = calls.find((call) => call.headers.get("content-encoding") === "gzip");
  ok(gzipCall, "compressed GPT request is forwarded as raw gzip");
  equal(Buffer.compare(gzipCall.rawBody, gzipBody), 0, "compressed GPT bytes remain transparent");

  const dsBody = JSON.stringify({
    model: "deepseek/deepseek-flash",
    input: [{
      type: "agent_message",
      content: [
        { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
        { type: "encrypted_content", encrypted_content: "already plaintext" },
      ],
    }],
  });
  const ds = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer chatgpt-test", "chatgpt-account-id": "acct", "thread-id": "child-A", "x-codex-parent-thread-id": "parent-1" },
    body: dsBody,
  });
  equal(ds.status, 200, "DeepSeek plaintext request succeeds");
  const dsCall = calls.find((call) => call.url.startsWith("https://deepseek.test") && call.body.includes("already plaintext"));
  ok(dsCall, "DeepSeek request reaches the DeepSeek base");
  equal(dsCall.headers.get("authorization"), "Bearer ds-test-key", "DeepSeek uses only its own credential");
  equal(dsCall.headers.get("chatgpt-account-id"), null, "ChatGPT account header is not sent to DeepSeek");
  equal(dsCall.headers.get("x-codex-parent-thread-id"), null, "Codex parent header is not sent to DeepSeek");
  ok(dsCall.body.includes("deepseek-flash"), "DeepSeek wire model is used");
  ok(!dsCall.body.includes("use_responses_lite"), "ResponsesLite is not sent");
  equal(gateway.stats.child_thread_ids.includes("child-A"), true, "child thread id is observed");

  const relayBody = JSON.stringify({
    model: "deepseek/deepseek-flash",
    input: [{
      type: "agent_message",
      content: [
        { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
        { type: "encrypted_content", encrypted_content: "gAAAAAnative-opaque" },
      ],
    }],
  });
  for (let i = 0; i < 2; i += 1) {
    const response = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer chatgpt-test", "chatgpt-account-id": "acct", "thread-id": "child-B", "x-codex-parent-thread-id": "parent-1" },
      body: relayBody,
    });
    equal(response.status, 200, `native relay request ${i + 1} succeeds`);
  }
  equal(gateway.stats.relay_calls, 1, "same account+ciphertext relays once");
  equal(gateway.stats.relay_cache_hits, 1, "second relay is a cache hit");
  const relayed = calls.find((call) => call.url.startsWith("https://deepseek.test") && call.body.includes("RELAYED PLAINTEXT"));
  ok(relayed, "relayed plaintext reaches DeepSeek");
  ok(!relayed.body.includes("gAAAAAnative-opaque"), "opaque ciphertext never reaches DeepSeek");

  await new Promise((resolve) => setTimeout(resolve, 100));
  equal(gateway.stats.openai_requests, 2, "two GPT requests observed");
  equal(gateway.stats.openai_usages.length, 2, "one main GPT usage slot per GPT request");
  deepEqual(gateway.stats.openai_usages[0], { input_tokens: 20, output_tokens: 4, total_tokens: 24 }, "GPT usage is captured");
  ok(gateway.stats.deepseek_usages.length >= 3, "DeepSeek usage is captured per request");
  deepEqual(gateway.stats.deepseek_usages[0], { input_tokens: 30, output_tokens: 6, total_tokens: 36 }, "DeepSeek usage is captured");
  equal(gateway.stats.relay_usages.length, 1, "relay usage is captured once");
  equal(gateway.stats.relay_usages[0].total_tokens, 18, "relay usage value");
} finally {
  await gateway.close();
  await rm(dir, { recursive: true, force: true });
}

console.log(`PASS ${checks} native gateway assertions`);
