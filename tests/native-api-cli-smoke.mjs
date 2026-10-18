#!/usr/bin/env node
/*
 * Opt-in adapter smoke for a user-supplied Codex CLI and the generic native API
 * gateway. It makes no real model request: the only upstream is a loopback mock
 * that answers the real exec_command tool call once.
 *
 * Usage:
 *   node tests/native-api-cli-smoke.mjs --binary C:\path\to\codex.exe --sha256 <64-hex>
 *
 * The binary may also be supplied with SOL_LUNA_NATIVE_API_SMOKE_BINARY and
 * SOL_LUNA_NATIVE_API_SMOKE_SHA256. No host user path is embedded in this file.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNativeApiGateway } from "../scripts/native-api-gateway.mjs";

const PROFILE_ID = "a1b2c3d4e5f60718293a4b5c";
const TOKEN = "native-api-cli-smoke-local-token";
const MODEL = "native-api-cli-smoke-model";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function option(name) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
}

function usage() {
  return [
    "Usage: node tests/native-api-cli-smoke.mjs --binary PATH [--sha256 HASH] [--none-profile]",
    "",
    "Runs an opt-in loopback-only generic API adapter smoke. It requires a",
    "Codex CLI path; the expected SHA-256 is optional but recommended. It never",
    "calls a real model or provider.",
    "",
    "Environment fallbacks:",
    "  SOL_LUNA_NATIVE_API_SMOKE_BINARY",
    "  SOL_LUNA_NATIVE_API_SMOKE_SHA256",
  ].join("\n");
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

const binary = option("binary") || process.env.SOL_LUNA_NATIVE_API_SMOKE_BINARY;
const expectedHash = option("sha256") || process.env.SOL_LUNA_NATIVE_API_SMOKE_SHA256;
const noneProfile = process.argv.includes("--none-profile");
if (!binary) throw new Error(`--binary is required (or set SOL_LUNA_NATIVE_API_SMOKE_BINARY)\n\n${usage()}`);
const binaryPath = path.resolve(binary);
const binaryHash = createHash("sha256").update(await fs.readFile(binaryPath)).digest("hex");
if (expectedHash && expectedHash.toLowerCase() !== binaryHash) {
  throw new Error(`CLI SHA-256 mismatch: expected ${expectedHash}, got ${binaryHash}`);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-api-cli-smoke-"));
const codexHome = path.join(root, "codex-home");
const workspace = path.join(root, "workspace");
const calls = [];
const requestedHosts = new Set();
const gatewayHosts = new Set();
const blockedProxyAttempts = [];
let mockServer;
let proxyServer;
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

function jsonResponse(res, value) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function streamResponse(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const value of chunks) res.write(`data: ${JSON.stringify(value)}\r\n\r\n`);
  res.end("data: [DONE]\r\n\r\n");
}

try {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  mockServer = http.createServer(async (req, res) => {
    requestedHosts.add(req.headers.host);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push(body);
    if (calls.length === 1) {
      const tool = (body.tools || []).find(({ function: fn }) => fn?.parameters?.properties?.cmd);
      if (!tool) {
        jsonResponse(res, { error: { message: "The CLI did not send an exec_command function with cmd." } });
        return;
      }
      const args = {
        cmd: `node -e "require('fs').writeFileSync('smoke-output.txt','native-api-cli-proof'); console.log('native-api-cli-proof')"`,
        workdir: workspace,
        yield_time_ms: 1000,
        max_output_tokens: 200,
      };
      const completion = {
        id: "chatcmpl-native-api-tool",
        model: MODEL,
        choices: [{ index: 0, message: { role: "assistant", tool_calls: [{ id: "call_native_api_exec_1", type: "function", function: { name: tool.function.name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 },
      };
      if (body.stream) {
        streamResponse(res, [
          { id: completion.id, model: MODEL, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { id: completion.id, model: MODEL, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_native_api_exec_1", type: "function", function: { name: tool.function.name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
          { id: completion.id, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          { id: completion.id, model: MODEL, choices: [], usage: completion.usage },
        ]);
      } else jsonResponse(res, completion);
      return;
    }
    const toolMessage = body.messages?.find((message) => message.role === "tool" && message.tool_call_id === "call_native_api_exec_1");
    assert.ok(toolMessage, "the CLI must return the real tool result by call id");
    assert.match(toolMessage.content, /native-api-cli-proof/);
    const final = {
      id: "chatcmpl-native-api-final",
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "Native API CLI smoke succeeded." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 31, completion_tokens: 6, total_tokens: 37 },
    };
    if (body.stream) {
      streamResponse(res, [
        { id: final.id, model: MODEL, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
        { id: final.id, model: MODEL, choices: [{ index: 0, delta: { content: "Native API CLI smoke succeeded." }, finish_reason: null }] },
        { id: final.id, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { id: final.id, model: MODEL, choices: [], usage: final.usage },
      ]);
    } else jsonResponse(res, final);
  });

  const upstreamPort = await listen(mockServer);
  proxyServer = http.createServer((req, res) => {
    blockedProxyAttempts.push(req.url);
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("The opt-in smoke blocks every proxy request.");
  });
  proxyServer.on("connect", (req, socket) => {
    blockedProxyAttempts.push(req.url);
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  const proxyPort = await listen(proxyServer);
  const proxyBase = `http://127.0.0.1:${proxyPort}`;

  gateway = createNativeApiGateway({
    resolveProfile: async ({ profileId }) => profileId === PROFILE_ID ? {
      profileId: PROFILE_ID,
      protocol: "chat_completions",
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      model: MODEL,
      reasoning: noneProfile
        ? { supported: ["none"], default: "none", parameter: "none" }
        : { supported: ["low", "medium", "high"], default: "low", parameter: "reasoning_effort" },
      credential: { type: "env", name: "OPENAI_API_KEY" },
    } : null,
    resolveAuth: async () => ({ headers: { authorization: "Bearer loopback-smoke-only" } }),
    token: TOKEN,
    timeoutMs: 10_000,
    logger: { info() {} },
  });
  gateway.server.on("request", (req) => gatewayHosts.add(req.headers.host));
  const { port, baseUrl } = await gateway.start(0);
  const providerBase = `${baseUrl}/profiles/${PROFILE_ID}/v1`;
  const configLines = [
    `model = "${MODEL}"`,
    'model_provider = "local_smoke"',
    ...(noneProfile ? ['model_reasoning_effort = "none"', 'model_reasoning_summary = "none"'] : ['model_reasoning_effort = "low"']),
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    'web_search = "disabled"',
    "",
    "[model_providers.local_smoke]",
    'name = "Native API loopback smoke"',
    `base_url = "${providerBase}"`,
    'wire_api = "responses"',
    'env_key = "OPENAI_API_KEY"',
    'supports_websockets = false',
    "",
  ];
  await fs.writeFile(path.join(codexHome, "config.toml"), configLines.join("\n"), "utf8");

  const safeEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    if (process.env[key]) safeEnv[key] = process.env[key];
  }
  safeEnv.CODEX_HOME = codexHome;
  safeEnv.HOME = codexHome;
  safeEnv.OPENAI_API_KEY = "loopback-smoke-key-never-sent";
  safeEnv.NO_PROXY = "127.0.0.1,localhost";
  safeEnv.no_proxy = safeEnv.NO_PROXY;
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) safeEnv[key] = proxyBase;
  const prompt = "Use exec_command exactly once to create smoke-output.txt in the current workspace with the text native-api-cli-proof, then confirm.";
  child = spawn(binaryPath, [
    "exec", "--skip-git-repo-check", "--ephemeral", "--dangerously-bypass-approvals-and-sandbox", "--strict-config",
    "-c", 'model_provider="local_smoke"',
    "--model", MODEL, "-C", workspace, prompt,
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
  assert.equal(calls.length, 2, `expected the tool request and one continuation; got ${calls.length}`);
  const firstReasoning = calls[0].reasoning;
  if (noneProfile) {
    assert.ok(firstReasoning === undefined
      || (firstReasoning && typeof firstReasoning === "object"
        && !Array.isArray(firstReasoning) && Object.keys(firstReasoning).length === 0),
    `none-profile CLI must send an empty/omitted reasoning object, got ${JSON.stringify(firstReasoning)}`);
  }
  assert.equal((await fs.readFile(path.join(workspace, "smoke-output.txt"), "utf8")).trim(), "native-api-cli-proof");
  assert.equal([...requestedHosts].every((host) => /^(127\.0\.0\.1|localhost):\d+$/.test(host)), true, "upstream host must be loopback");
  assert.equal([...gatewayHosts].every((host) => /^(127\.0\.0\.1|localhost):\d+$/.test(host)), true, "gateway host must be loopback");
  console.log(JSON.stringify({
    status: "passed",
    binary: binaryPath,
    binarySha256: binaryHash,
    gatewayPort: port,
    cliExitCode: exitCode,
    chatRequests: calls.length,
    noneProfile,
    firstReasoning: firstReasoning ?? null,
    toolResultReturnedToUpstream: calls.length === 2,
    workspaceFileCreatedByCliTool: true,
    stdoutTail: stdout.slice(-600),
    stderrTail: stderr.slice(-600),
    proxyAttemptsBlocked: blockedProxyAttempts.length,
  }, null, 2));
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([once(child, "close"), new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
  child?.kill();
  await gateway?.close();
  await closeServer(proxyServer);
  await closeServer(mockServer);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
