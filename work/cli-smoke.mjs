import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { createNativeApiGateway } from "../scripts/native-api-gateway.mjs";

const workRoot = path.resolve("work");
const root = path.join(workRoot, `private-cli-smoke-${process.pid}`);
const codexHome = path.join(root, "codex-home");
const workspace = path.join(root, "workspace");
const profileId = "a1b2c3d4e5f60718293a4b5c";
const token = "private-local-smoke-token";
const model = "mimo-local-smoke";
const calls = [];
const requestedHosts = new Set();
const gatewayHosts = new Set();
const blockedProxyAttempts = [];
let mockServer;
let proxyServer;
let proxyBase;
let gateway;
let child;

function listen(server) {
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => server.address().port);
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.close();
  await once(server, "close");
}

function digest(kind, namespace, name) {
  return createHash("sha256").update(JSON.stringify([kind, namespace || "", name])).digest("hex").slice(0, 32);
}

function jsonResponse(res, value) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function streamResponse(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const value of chunks) res.write(`data: ${JSON.stringify(value)}\r\n\r\n`);
  res.end("data: [DONE]\r\n\r\n");
}

mockServer = http.createServer(async (req, res) => {
  requestedHosts.add(req.headers.host);
  const requestChunks = [];
  for await (const chunk of req) requestChunks.push(chunk);
  const body = JSON.parse(Buffer.concat(requestChunks).toString("utf8"));
  calls.push(body);
  const summary = { keys: Object.keys(body).sort(), model: body.model, stream: body.stream, tools: (body.tools || []).map(({ function: fn }) => ({ name: fn.name, description: fn.description, parameters: fn.parameters })) };
  await fs.writeFile(path.join(root, `chat-request-${calls.length}.json`), JSON.stringify(summary, null, 2));

  if (calls.length === 1) {
    const candidate = (body.tools || []).find(({ function: fn }) => fn.parameters?.properties?.cmd);
    if (!candidate) {
      jsonResponse(res, { error: { message: "No real Codex exec_command function schema with cmd property was received." } });
      return;
    }
    const args = {
      cmd: `node -e "require('fs').writeFileSync('smoke-output.txt','native-cli-proof'); console.log('native-cli-proof')"`,
      workdir: workspace,
      yield_time_ms: 1000,
      max_output_tokens: 200,
    };
    const completion = {
      id: "chatcmpl-cli-tool",
      model,
      choices: [{ index: 0, message: { role: "assistant", tool_calls: [{ id: "call_cli_exec_1", type: "function", function: { name: candidate.function.name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 },
    };
    if (body.stream) {
      streamResponse(res, [
        { id: completion.id, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
        { id: completion.id, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_cli_exec_1", type: "function", function: { name: candidate.function.name.slice(0, 7), arguments: "" } }] }, finish_reason: null }] },
        { id: completion.id, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: candidate.function.name.slice(7), arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
        { id: completion.id, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        { id: completion.id, model, choices: [], usage: completion.usage },
      ]);
    } else jsonResponse(res, completion);
    return;
  }

  const toolMessage = body.messages?.find((message) => message.role === "tool" && message.tool_call_id === "call_cli_exec_1");
  assert.ok(toolMessage, "second actual CLI request must include the real tool result by call_id");
  assert.match(toolMessage.content, /native-cli-proof/, "tool output must come from the CLI executor");
  const final = { id: "chatcmpl-cli-final", model, choices: [{ index: 0, message: { role: "assistant", content: "CLI tool smoke succeeded." }, finish_reason: "stop" }], usage: { prompt_tokens: 31, completion_tokens: 6, total_tokens: 37 } };
  if (body.stream) streamResponse(res, [
    { id: final.id, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { id: final.id, model, choices: [{ index: 0, delta: { content: "CLI tool smoke succeeded." }, finish_reason: null }] },
    { id: final.id, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { id: final.id, model, choices: [], usage: final.usage },
  ]);
  else jsonResponse(res, final);
});

try {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  const upstreamPort = await listen(mockServer);
  proxyServer = http.createServer((req, res) => {
    blockedProxyAttempts.push(req.url);
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Private smoke blocks every non-loopback HTTP proxy request.");
  });
  proxyServer.on("connect", (req, socket) => {
    blockedProxyAttempts.push(req.url);
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  const proxyPort = await listen(proxyServer);
  proxyBase = `http://127.0.0.1:${proxyPort}`;
  gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId: requestedId }) => requestedId === profileId ? {
      profileId, protocol: "chat_completions", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, model,
      reasoning: { supported: ["low", "medium", "high"], default: "low", parameter: "reasoning_effort" },
      credential: { type: "env", name: "OPENAI_API_KEY" },
    } : null,
    resolveAuth: async () => ({ headers: { authorization: "Bearer local-test-only" } }),
    token, timeoutMs: 10_000, logger: { info() {} },
  });
  gateway.server.on("request", (req) => gatewayHosts.add(req.headers.host));
  const { port, baseUrl } = await gateway.start(0);
  const providerBase = `${baseUrl}/profiles/${profileId}/v1`;
  await fs.writeFile(path.join(codexHome, "config.toml"), [
    `model = "${model}"`,
    'model_provider = "local_smoke"',
    'model_reasoning_effort = "low"',
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    'web_search = "disabled"',
    '',
    '[model_providers.local_smoke]',
    'name = "Private loopback protocol smoke"',
    `base_url = "${providerBase}"`,
    'wire_api = "responses"',
    'env_key = "OPENAI_API_KEY"',
    'supports_websockets = false',
  ].join("\n"), "utf8");

  const journalPath = "C:\\Users\\23825\\AppData\\Local\\Packages\\OpenAI.Codex_2p2nqsd0c76g0\\LocalCache\\Local\\sol-luna-deepseek-router\\native-isolated\\install-bounded-retry-20261018.json";
  const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
  const binary = journal.files.runtimeExePath;
  const expectedHash = "6ec8cb89c6f80e52b35ef285d6337a4f5a99b3f294f3b983c95e6af6bcb4666f";
  const actualHash = createHash("sha256").update(await fs.readFile(binary)).digest("hex");
  assert.equal(actualHash, expectedHash, "pinned Codex CLI binary hash must match before execution");

  const safeEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) if (process.env[key]) safeEnv[key] = process.env[key];
  safeEnv.CODEX_HOME = codexHome;
  safeEnv.HOME = codexHome;
  safeEnv.OPENAI_API_KEY = "test-only-never-valid";
  safeEnv.NO_PROXY = "127.0.0.1,localhost";
  safeEnv.no_proxy = safeEnv.NO_PROXY;
  safeEnv.HTTP_PROXY = proxyBase;
  safeEnv.HTTPS_PROXY = proxyBase;
  safeEnv.ALL_PROXY = proxyBase;
  safeEnv.http_proxy = proxyBase;
  safeEnv.https_proxy = proxyBase;
  safeEnv.all_proxy = proxyBase;
  const prompt = "Use exec_command exactly once to create smoke-output.txt in the current workspace with the text native-cli-proof and confirm when done.";
  child = spawn(binary, [
    "exec", "--skip-git-repo-check", "--ephemeral", "--dangerously-bypass-approvals-and-sandbox", "--strict-config",
    "-c", 'model_provider="local_smoke"',
    "--model", model, "-C", workspace, prompt,
  ], { cwd: workspace, env: safeEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  let timeout;
  const exitCode = await Promise.race([
    once(child, "exit").then(([code]) => code),
    new Promise((_, reject) => { timeout = setTimeout(() => { child.kill(); reject(new Error("CLI smoke timed out after 45 seconds")); }, 45_000); }),
  ]).finally(() => clearTimeout(timeout));
  assert.equal(exitCode, 0, `Codex CLI exited ${exitCode}; stderr tail: ${stderr.slice(-1500)}`);
  assert.equal(calls.length, 2, `expected exactly tool request and continuation; got ${calls.length}; stderr tail: ${stderr.slice(-1500)}`);
  assert.equal((await fs.readFile(path.join(workspace, "smoke-output.txt"), "utf8")).trim(), "native-cli-proof");
  const firstRequest = JSON.parse(await fs.readFile(path.join(root, "chat-request-1.json"), "utf8"));
  console.log(JSON.stringify({
    binarySha256: actualHash,
    gatewayPort: port,
    cliExitCode: exitCode,
    stdoutTail: stdout.slice(-800),
    stderrTail: stderr.slice(-800),
    firstChatRequestKeys: firstRequest.keys,
    model: firstRequest.model,
    streamed: firstRequest.stream,
    functionToolCount: firstRequest.tools.length,
    toolResultReturnedToUpstream: calls.length === 2,
    workspaceFileCreatedByCliTool: true,
    actualRequestHosts: [...requestedHosts],
    gatewayRequestHosts: [...gatewayHosts],
    externallyAddressedRequestsBlockedByLocalProxy: blockedProxyAttempts,
  }, null, 2));
} catch (error) {
  console.error(`CLI smoke failed: ${error.stack || error}`);
  throw error;
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([once(child, "close"), new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
  child?.kill();
  await gateway?.close();
  await closeServer(proxyServer);
  await closeServer(mockServer);
  const resolvedRoot = path.resolve(root);
  if (resolvedRoot.startsWith(`${workRoot}${path.sep}`)) {
    let removed = false;
    for (let attempt = 0; attempt < 6 && !removed; attempt += 1) {
      try { await fs.rm(resolvedRoot, { recursive: true, force: true }); removed = true; }
      catch (error) {
        if (attempt === 5) console.error(`Private smoke cleanup deferred (${error.code}).`);
        else await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
  }
}
