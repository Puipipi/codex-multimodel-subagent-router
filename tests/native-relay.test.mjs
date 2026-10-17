import assert from "node:assert/strict";
import {
  RelayCache, buildRelayRequest, parseRelayBody, relayCacheKey,
} from "../scripts/native-relay.mjs";

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };

const json = JSON.stringify({
  output: [{ type: "function_call", name: "relay_external_agent_payload", arguments: JSON.stringify({ payload: "exact\npayload" }) }],
  usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
});
const parsedJson = parseRelayBody(Buffer.from(json), "application/json");
equal(parsedJson.payload, "exact\npayload", "JSON relay payload is exact");
equal(parsedJson.usage.total_tokens, 7, "JSON usage is captured");

const sse = [
  "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"name\":\"relay_external_agent_payload\",\"id\":\"fc_1\",\"call_id\":\"call_1\"}}",
  "",
  "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"delta\":\"{\\\"payload\\\":\\\"sse\\\\nvalue\\\"}\"}",
  "",
  "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_1\",\"arguments\":\"{\\\"payload\\\":\\\"sse\\\\nvalue\\\"}\"}",
  "",
  "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":5,\"output_tokens\":6,\"total_tokens\":11}}}",
  "",
].join("\n");
const parsedSse = parseRelayBody(Buffer.from(sse), "text/event-stream");
equal(parsedSse.payload, "sse\nvalue", "SSE relay payload is exact");
equal(parsedSse.usage.total_tokens, 11, "SSE usage is captured");

const request = buildRelayRequest({ type: "agent_message" }, { model: "gpt-6.1-sol" });
equal(request.tool_choice.name, "relay_external_agent_payload", "relay tool is forced");
equal(request.input[0].type, "agent_message", "original item is relayed");

const keyA = relayCacheKey({ authorization: "auth-a", account: "acct", ciphertext: "same" });
const keyB = relayCacheKey({ authorization: "auth-b", account: "acct", ciphertext: "same" });
ok(keyA.key !== keyB.key, "account scope separates cache entries");

const cache = new RelayCache({ ttlMs: 60_000, now: () => Date.now() });
let calls = 0;
let release;
const gate = new Promise((resolve) => { release = resolve; });
const operation = async () => { calls += 1; await gate; return "once"; };
const first = cache.run("k", operation);
const second = cache.run("k", operation);
release();
const [a, b] = await Promise.all([first, second]);
equal(a, "once", "first relay result");
equal(b, "once", "coalesced relay result");
equal(calls, 1, "concurrent identical ciphertexts coalesce into one relay call");
equal(cache.metrics.coalesced, 1, "coalescing metric is recorded");
equal(await cache.run("k", async () => "twice"), "once", "cached payload is reused");

const failure = new RelayCache({ ttlMs: 60_000, failureBackoffMs: 60_000 });
await assert.rejects(failure.run("fail", async () => { const error = new Error("rate limited"); error.status = 429; throw error; }), /rate limited/);
checks += 1;
await assert.rejects(failure.run("fail", async () => "must not run"), /rate limited/);
checks += 1;

console.log(`PASS ${checks} native relay assertions`);
