import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import {
  chatCompletionToResponse,
  chatSseToResponses,
  responsesRequestToChat,
} from "../scripts/native-api-protocol.mjs";
import { createNativeApiGateway } from "../scripts/native-api-gateway.mjs";

const PROFILE_ID = "a1b2c3d4e5f60718293a4b5c";
const profile = {
  profileId: PROFILE_ID,
  protocol: "chat_completions",
  baseUrl: "http://127.0.0.1:0/v1",
  model: "mimo-model",
  reasoning: { supported: ["low", "medium", "high"], default: "medium", parameter: "reasoning_effort" },
  credential: { type: "env", name: "MIMO_API_KEY" },
};

function chatTool(name, args) {
  return { id: args.id, type: "function", function: { name, arguments: args.arguments } };
}

function sseFrame(value) {
  return `data: ${JSON.stringify(value)}\r\n\r\n`;
}

async function* chunksOf(text, sizes) {
  let offset = 0;
  let index = 0;
  while (offset < text.length) {
    const size = sizes[index++ % sizes.length];
    yield Buffer.from(text.slice(offset, offset + size));
    offset += size;
  }
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

test("Responses input becomes ordered Chat messages and tool history round-trips by call_id", () => {
  const body = {
    model: "mimo-model",
    instructions: "Be concise",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
      { type: "reasoning", content: [] },
      { type: "reasoning", content: [{ type: "reasoning_text", text: "prior thought" }] },
      { type: "function_call", id: "fc-old", call_id: "call-fn", name: "lookup", arguments: "{\"q\":1}" },
      { type: "function_call_output", call_id: "call-fn", output: "found" },
      { type: "custom_tool_call", id: "ctc-old", call_id: "call-exec", name: "exec", namespace: "local", input: "echo ok" },
      { type: "custom_tool_call_output", call_id: "call-exec", output: "ok" },
    ],
    tools: [
      { type: "function", name: "lookup", description: "lookup", parameters: { type: "object", properties: { q: { type: "number" } } } },
      { type: "namespace", name: "local", tools: [{ type: "custom", name: "exec", description: "run a command", format: { type: "text" } }] },
    ],
  };

  const { body: chat, toolMap } = responsesRequestToChat(body, profile);
  assert.equal(chat.model, "mimo-model");
  assert.equal(chat.messages[0].role, "system");
  assert.deepEqual(chat.messages.slice(1).map(({ role }) => role), ["user", "assistant", "assistant", "tool", "assistant", "tool"]);
  assert.equal(chat.messages[2].content, "prior thought");
  assert.equal(chat.messages[3].tool_calls[0].id, "call-fn");
  assert.equal(chat.messages[4].tool_call_id, "call-fn");
  assert.equal(chat.messages[5].tool_calls[0].id, "call-exec");
  assert.equal(chat.messages[6].tool_call_id, "call-exec");
  assert.equal(toolMap.get(chat.messages[5].tool_calls[0].function.name).kind, "custom");
});

test("Responses request rejects model overrides and unsupported input explicitly", () => {
  assert.throws(() => responsesRequestToChat({ model: "other", input: "hi" }, profile), /model/i);
  assert.throws(() => responsesRequestToChat({ model: "mimo-model", input: [{ type: "computer_call_output", call_id: "x", output: [] }] }, profile), /unsupported/i);
  assert.throws(() => responsesRequestToChat({ model: "mimo-model", input: [{ type: "reasoning", encrypted_content: "opaque" }] }, profile), /encrypted reasoning/i);
});

test("preserves Chat's boolean parallel_tool_calls and only accepts explicitly supported request options", () => {
  const tools = [{ type: "function", name: "one", parameters: { type: "object" } }, { type: "function", name: "two", parameters: { type: "object" } }];
  assert.equal(responsesRequestToChat({ model: "mimo-model", input: "x", tools, parallel_tool_calls: false }, profile).body.parallel_tool_calls, false);
  assert.equal(responsesRequestToChat({ model: "mimo-model", input: "x", tools, parallel_tool_calls: true }, profile).body.parallel_tool_calls, true);
});

test("ignores Codex's optional encrypted-reasoning include, but rejects other non-portable include requests", () => {
  assert.deepEqual(responsesRequestToChat({ model: "mimo-model", input: "x", include: [] }, profile).body.messages, [{ role: "user", content: "x" }]);
  const converted = responsesRequestToChat({ model: "mimo-model", input: "x", include: ["reasoning.encrypted_content"] }, profile);
  assert.equal("include" in converted.body, false);
  assert.throws(() => responsesRequestToChat({ model: "mimo-model", input: "x", include: ["web_search_call.action.sources"] }, profile), /include/);
});

test("maps the standard Responses prompt_cache_key to the standard Chat field", () => {
  const converted = responsesRequestToChat({ model: "mimo-model", input: "x", prompt_cache_key: "test-only-key" }, profile);
  assert.equal(converted.body.prompt_cache_key, "test-only-key");
});

test("drops Codex-only client_metadata when converting to the standard Chat API", () => {
  const converted = responsesRequestToChat({ model: "mimo-model", input: "x", client_metadata: { client: "codex" } }, profile);
  assert.equal("client_metadata" in converted.body, false);
});

test("preserves namespaces on flat Responses function and custom definitions", () => {
  const { body: chat, toolMap } = responsesRequestToChat({
    model: "mimo-model", input: "x",
    tools: [
      { type: "function", name: "exec_command", namespace: "default", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
      { type: "custom", name: "apply_patch", namespace: "codex", format: { type: "text" } },
    ],
  }, profile);
  assert.equal(toolMap.get(chat.tools[0].function.name).namespace, "default");
  assert.equal(toolMap.get(chat.tools[1].function.name).namespace, "codex");
  const result = chatCompletionToResponse({ choices: [{ message: { tool_calls: [
    chatTool(chat.tools[0].function.name, { id: "call-ns", arguments: JSON.stringify({ cmd: "node -v" }) }),
  ] }, finish_reason: "tool_calls" }] }, { model: "mimo-model", toolMap });
  assert.equal(result.output[0].namespace, "default");
});

test("realistic Codex tool params flatten custom apply_patch grammar without claiming Chat enforcement", () => {
  const grammar = { type: "grammar", syntax: "lark", definition: 'start: "*** Begin Patch" /[\\s\\S]*/ "*** End Patch"' };
  const { body: chat, toolMap } = responsesRequestToChat({
    model: "mimo-model",
    instructions: "Use the provided tools.",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Keep changes focused." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "edit file" }] },
      { type: "reasoning", content: [] },
    ],
    stream: true,
    max_output_tokens: 2400,
    reasoning: { effort: "medium" },
    tool_choice: { type: "custom", name: "apply_patch" },
    tools: [
      { type: "custom", name: "apply_patch", description: "Apply a patch.", format: grammar },
      { type: "custom", name: "exec_command", description: "Run a shell command.", format: { type: "text" } },
    ],
  }, profile);
  assert.equal(chat.stream, true);
  assert.equal(chat.stream_options.include_usage, true);
  assert.equal(chat.max_tokens, 2400);
  assert.equal(chat.reasoning_effort, "medium");
  assert.equal(chat.tool_choice.type, "function");
  assert.equal(chat.tools[0].type, "function");
  assert.match(chat.tools[0].function.description, /Chat provider cannot enforce/);
  assert.match(chat.tools[0].function.description, /start:/);
  assert.equal(toolMap.get(chat.tools[0].function.name).format, grammar);
});

test("non-streaming Chat tool calls become native function and custom Responses items", () => {
  const { body: request, toolMap } = responsesRequestToChat({
    model: "mimo-model",
    input: "start",
    tools: [
      { type: "function", name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } },
      { type: "custom", name: "exec", format: { type: "text" } },
    ],
  }, profile);
  const names = [...toolMap.keys()];
  const result = chatCompletionToResponse({
    id: "chatcmpl-1",
    model: "mimo-model",
    choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [
      chatTool(names[0], { id: "call-a", arguments: "{\"q\":\"x\"}" }),
      chatTool(names[1], { id: "call-b", arguments: "{\"input\":\"echo x\"}" }),
    ] }, finish_reason: "tool_calls" }],
  }, { requestId: "req-1", model: "mimo-model", toolMap });

  assert.equal(result.object, "response");
  assert.deepEqual(result.output.map(({ type }) => type), ["function_call", "custom_tool_call"]);
  assert.equal(result.output[0].id.startsWith("fc_"), true);
  assert.equal(result.output[0].call_id, "call-a");
  assert.equal(result.output[0].name, "lookup");
  assert.equal(result.output[1].call_id, "call-b");
  assert.equal(result.output[1].name, "exec");
  assert.equal(result.output[1].input, "echo x");
  assert.equal(result.usage, null);
});

test("streaming Chat deltas preserve interleaved call indexes, namespace, and standard custom events", async () => {
  const customName = "codex_custom_exec";
  const toolMap = new Map([["lookup", { kind: "function", name: "lookup" }], [customName, { kind: "custom", name: "exec", namespace: "local" }]]);
  const chunks = [
    { id: "chatcmpl-2", model: "mimo-model", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { id: "chatcmpl-2", choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call-c", type: "function", function: { name: customName, arguments: "" } }] }, finish_reason: null }] },
    { id: "chatcmpl-2", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-f", type: "function", function: { name: "lookup", arguments: "" } }] }, finish_reason: null }] },
    { id: "chatcmpl-2", choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: "{\"input\":" } }] }, finish_reason: null }] },
    { id: "chatcmpl-2", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"q\":" } }] }, finish_reason: null }] },
    { id: "chatcmpl-2", choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: "\"echo\"}" } }] }, finish_reason: null }] },
    { id: "chatcmpl-2", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"x\"}" } }] }, finish_reason: null }] },
    { id: "chatcmpl-2", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { id: "chatcmpl-2", choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
  ];
  const source = chunks.map(sseFrame).join("") + "data: [DONE]\r\n\r\n";
  const events = [];
  for await (const event of chatSseToResponses(chunksOf(source, [1, 2, 7, 3]), { requestId: "req-2", model: "mimo-model", toolMap })) events.push(event);

  const types = events.map(({ type }) => type);
  assert.equal(types[0], "response.created");
  assert.equal(types.includes("response.function_call_arguments.delta"), true);
  assert.equal(types.includes("response.custom_tool_call_input.delta"), true);
  assert.equal(types.includes("response.output_tool_call.delta"), false);
  assert.equal(types.at(-1), "response.completed");
  const doneItems = events.filter(({ type }) => type === "response.output_item.done").map(({ item }) => item);
  assert.deepEqual(doneItems.map(({ type }) => type), ["function_call", "custom_tool_call"]);
  assert.equal(doneItems[0].call_id, "call-f");
  assert.equal(doneItems[0].arguments, "{\"q\":\"x\"}");
  assert.equal(doneItems[1].call_id, "call-c");
  assert.equal(doneItems[1].input, "echo");
  assert.equal(doneItems[1].namespace, "local");
  const addedById = new Map(events.filter(({ type }) => type === "response.output_item.added").map(({ item, output_index }) => [item.id, output_index]));
  const doneById = new Map(events.filter(({ type }) => type === "response.output_item.done").map(({ item, output_index }) => [item.id, output_index]));
  events.at(-1).response.output.forEach((item, outputIndex) => {
    assert.equal(addedById.get(item.id), outputIndex);
    assert.equal(doneById.get(item.id), outputIndex);
    assert.equal("output_index" in item, false);
  });
  assert.deepEqual(events.at(-1).response.usage, {
    input_tokens: 7,
    output_tokens: 3,
    total_tokens: 10,
  });
});

test("streaming tool names may arrive in valid fragmented prefixes", async () => {
  const toolMap = new Map([["lookup", { kind: "function", name: "lookup" }]]);
  const frames = [
    { id: "chatcmpl-frag", model: "mimo-model", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-frag", type: "function", function: { name: "look", arguments: "" } }] }, finish_reason: null }] },
    { id: "chatcmpl-frag", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "up", arguments: "{}" } }] }, finish_reason: null }] },
    { id: "chatcmpl-frag", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  const events = [];
  for await (const event of chatSseToResponses(chunksOf(frames.map(sseFrame).join("") + "data: [DONE]\r\n\r\n", [2, 4]), { model: "mimo-model", toolMap })) events.push(event);
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(events.at(-1).response.output[0].name, "lookup");
  assert.equal(events.at(-1).response.output[0].arguments, "{}");
});

test("stream ending without [DONE] or a terminal chunk never fabricates completed or zero usage", async () => {
  const text = sseFrame({ id: "chatcmpl-cut", model: "mimo-model", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] });
  const events = [];
  for await (const event of chatSseToResponses(chunksOf(text, [3, 5]), { requestId: "req-cut", model: "mimo-model", toolMap: new Map() })) events.push(event);
  assert.equal(events.some(({ type }) => type === "response.completed"), false);
  assert.equal(events.at(-1).type, "response.failed");
  assert.equal(events.at(-1).response.usage, null);
});

test("gateway binds immutable profile path, injects only resolved credentials, and preserves Responses passthrough", async (t) => {
  let observed;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed = { url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp-upstream", object: "response", output: [], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID ? { ...profile, profileId, protocol: "responses", baseUrl: `http://127.0.0.1:${upstreamPort}/v1` } : null,
    resolveAuth: async () => ({ headers: { authorization: "Bearer injected-secret" } }),
    token: "local-token",
    logger: { info() {} },
  });
  const { port, baseUrl } = await gateway.start(0);
  t.after(() => gateway.close());

  const response = await fetch(`${baseUrl}/profiles/${PROFILE_ID}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer attacker-token", cookie: "caller-cookie=secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "mimo-model", input: "hello" }),
  });
  assert.equal(port > 0, true);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, "resp-upstream");
  assert.equal(observed.url, "/v1/responses");
  assert.equal(observed.headers.authorization, "Bearer injected-secret");
  assert.equal(observed.headers.cookie, undefined);
  assert.equal(observed.body.input, "hello");
});

test("gateway rejects unknown profile, mismatched model, and disallowed routes before upstream", async (t) => {
  let upstreamCalls = 0;
  const upstream = http.createServer((_req, res) => { upstreamCalls += 1; res.end("unexpected"); });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID ? { ...profile, baseUrl: `http://127.0.0.1:${upstreamPort}/v1` } : null,
    resolveAuth: async () => ({ headers: {} }),
    token: "local-token",
    logger: { info() {} },
  });
  const { baseUrl } = await gateway.start(0);
  t.after(() => gateway.close());
  const unknown = await fetch(`${baseUrl}/profiles/b1b2c3d4e5f60718293a4b5c/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "mimo-model", input: "x" }) });
  const mismatch = await fetch(`${baseUrl}/profiles/${PROFILE_ID}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "other", input: "x" }) });
  const badPath = await fetch(`${baseUrl}/v1/responses`, { method: "POST", body: "{}" });
  assert.equal(unknown.status, 404);
  assert.equal(mismatch.status, 400);
  assert.equal(badPath.status, 404);
  assert.equal(upstreamCalls, 0);
});

test("gateway converts auth resolver failures into credential_unavailable without exposing resolver text", async (t) => {
  const gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID ? profile : null,
    resolveAuth: async () => { throw new Error("secret-bearing resolver diagnostic must not escape"); },
    token: "local-token",
    logger: { info() {} },
  });
  const { baseUrl } = await gateway.start(0);
  t.after(() => gateway.close());
  const response = await fetch(`${baseUrl}/profiles/${PROFILE_ID}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mimo-model", input: "hello" }),
  });
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.match(text, /credential_unavailable/);
  assert.doesNotMatch(text, /secret-bearing/);
});

test("gateway maps a Chat JSON tool call to Responses JSON without executing the tool", async (t) => {
  let observed;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const toolName = observed.tools[0].function.name;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-json", model: "mimo-model", choices: [{ index: 0, message: { role: "assistant", tool_calls: [
        { id: "call-real", type: "function", function: { name: toolName, arguments: "{\"input\":\"echo hello\"}" } },
      ] }, finish_reason: "tool_calls" }],
    }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID ? { ...profile, baseUrl: `http://127.0.0.1:${upstreamPort}/v1` } : null,
    resolveAuth: async () => ({ headers: {} }),
    token: "local-token",
    logger: { info() {} },
  });
  const { baseUrl } = await gateway.start(0);
  t.after(() => gateway.close());
  const response = await fetch(`${baseUrl}/profiles/${PROFILE_ID}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mimo-model", input: "run", tools: [{ type: "custom", name: "exec", format: { type: "text" } }] }),
  });
  const json = await response.json();
  assert.equal(response.status, 200);
  assert.equal(observed.model, "mimo-model");
  assert.equal(json.output[0].type, "custom_tool_call");
  assert.equal(json.output[0].call_id, "call-real");
  assert.equal(json.output[0].input, "echo hello");
  assert.equal("output" in json.output[0], false);
});

test("gateway ends a timed out Chat SSE response with response.failed, never response.completed", async (t) => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sseFrame({ id: "chatcmpl-timeout", model: "mimo-model", choices: [{ index: 0, delta: { content: "started" }, finish_reason: null }] }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID ? { ...profile, baseUrl: `http://127.0.0.1:${upstreamPort}/v1` } : null,
    resolveAuth: async () => ({ headers: {} }),
    token: "local-token",
    timeoutMs: 100,
    logger: { info() {} },
  });
  const { baseUrl } = await gateway.start(0);
  t.after(() => gateway.close());
  const response = await fetch(`${baseUrl}/profiles/${PROFILE_ID}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mimo-model", input: "hello", stream: true }),
  });
  const events = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean).map((frame) => JSON.parse(frame.split(/\r?\n/).find((line) => line.startsWith("data: ")).slice(6)));
  assert.equal(response.status, 200);
  assert.equal(events.at(-1).type, "response.failed");
  assert.equal(events.at(-1).response.error.code, "timeout");
  assert.equal(events.some(({ type }) => type === "response.completed"), false);
});

test("gateway preserves upstream auth failures and returns bounded timeout before response headers", async (t) => {
  let calls = 0;
  const upstream = http.createServer(async (_req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":{"message":"test unauthorized"}}');
    }
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID ? { ...profile, baseUrl: `http://127.0.0.1:${upstreamPort}/v1` } : null,
    resolveAuth: async () => ({ headers: { authorization: "Bearer test-only" } }),
    token: "local-token",
    timeoutMs: 100,
    logger: { info() {} },
  });
  const { baseUrl } = await gateway.start(0);
  t.after(() => gateway.close());
  const url = `${baseUrl}/profiles/${PROFILE_ID}/v1/responses`;
  const request = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "mimo-model", input: "hello" }) });
  const unauthorized = await request();
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: { message: "test unauthorized" } });
  const timeout = await request();
  assert.equal(timeout.status, 504);
  assert.equal((await timeout.json()).error.code, "timeout");
});

test("gateway cancels the upstream request when the local CLI disconnects", async (t) => {
  let upstreamClosedResolve;
  const upstreamClosed = new Promise((resolve) => { upstreamClosedResolve = resolve; });
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sseFrame({ id: "chatcmpl-disconnect", model: "mimo-model", choices: [{ index: 0, delta: { content: "connected" }, finish_reason: null }] }));
    res.on("close", upstreamClosedResolve);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID ? { ...profile, baseUrl: `http://127.0.0.1:${upstreamPort}/v1` } : null,
    resolveAuth: async () => ({ headers: {} }), token: "local-token", timeoutMs: 1000, logger: { info() {} },
  });
  const { port, baseUrl } = await gateway.start(0);
  t.after(() => gateway.close());
  const client = http.request(`${baseUrl}/profiles/${PROFILE_ID}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" } });
  client.on("response", (res) => { res.once("data", () => client.destroy()); });
  client.end(JSON.stringify({ model: "mimo-model", input: "hello", stream: true }));
  await Promise.race([upstreamClosed, new Promise((_, reject) => setTimeout(() => reject(new Error("upstream did not observe client disconnect")), 1000))]);
});

