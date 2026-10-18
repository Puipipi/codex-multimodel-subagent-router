import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/native-transport-gateway.mjs", import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), "native-transport-faults-"));
const dshHome = path.join(root, "empty-dsh-home");
const logPath = path.join(root, "gateway.jsonl");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const equal = (actual, expected, message) => assert.equal(actual, expected, message);
const ok = (value, message) => assert.ok(value, message);

async function freeLoopbackPort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitUntil(predicate, message, timeoutMs = 1500) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await wait(10);
  }
  assert.fail(message);
}

const upstreamPort = await freeLoopbackPort();
const upstream = createHttpServer();
let upstreamMode = "success";
let acceptedConnections = 0;
const acceptedByMode = { reset: 0, timeout: 0, success: 0 };
let resetRequests = 0;
let resetSocketClosed = false;
let timeoutRequests = 0;
let timeoutSocketClosed = false;
let successfulRequests = 0;
upstream.on("connection", () => {
  acceptedConnections += 1;
  acceptedByMode[upstreamMode] = (acceptedByMode[upstreamMode] || 0) + 1;
});
upstream.on("request", (req, res) => {
  if (upstreamMode === "reset") {
    resetRequests += 1;
    req.resume();
    req.socket.once("close", () => { resetSocketClosed = true; });
    setImmediate(() => req.socket.destroy());
    return;
  }
  if (upstreamMode === "timeout") {
    timeoutRequests += 1;
    req.resume();
    req.socket.once("close", () => { timeoutSocketClosed = true; });
    return;
  }
  successfulRequests += 1;
  req.resume();
  res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  res.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\ndata: [DONE]\n\n');
});

let child;
let childLines;
let pendingLines = [];
let lineWaiters = [];
let childExit;
const token = "native-transport-test-token";

function nextChildMessage(timeoutMs = 4000) {
  if (pendingLines.length) return Promise.resolve(pendingLines.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      lineWaiters = lineWaiters.filter((item) => item !== waiter);
      reject(new Error("gateway fixture did not respond within the bound"));
    }, timeoutMs);
    const waiter = (line) => { clearTimeout(timer); resolve(line); };
    lineWaiters.push(waiter);
  });
}

function sendGatewayRequest(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  return fetch(`http://127.0.0.1:${port}/${token}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ model: "deepseek/deepseek-flash", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "fixed local transport probe" }] }] }),
    signal: controller.signal,
  }).then(async (response) => ({ status: response.status, body: await response.text() }))
    .finally(() => clearTimeout(timer));
}

try {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(dshHome));
  await new Promise((resolve, reject) => upstream.listen(upstreamPort, "127.0.0.1", resolve).once("error", reject));
  await new Promise((resolve) => upstream.close(resolve));

  const env = {
    PATH: process.env.PATH || "",
    DSH_HOME: dshHome,
    TEMP: root,
    TMP: root,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
  };
  child = spawn(process.execPath, [fixture, String(upstreamPort), logPath], {
    cwd: path.dirname(path.dirname(fixture)),
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  childLines = createInterface({ input: child.stdout });
  childLines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { message = { type: "invalid_message" }; }
    const waiter = lineWaiters.shift();
    if (waiter) waiter(message);
    else pendingLines.push(message);
  });
  childExit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const ready = await nextChildMessage();
  equal(ready.type, "ready", "real gateway child starts and reports only a safe readiness record");
  ok(Number.isInteger(ready.port), "gateway child binds a loopback port");

  const refused = await sendGatewayRequest(ready.port);
  equal(refused.status, 502, "a real refused upstream TCP connection maps to bounded HTTP 502");
  equal(acceptedConnections, 0, "the refusal happened while no upstream listener accepted a connection");

  await new Promise((resolve, reject) => upstream.listen(upstreamPort, "127.0.0.1", resolve).once("error", reject));
  upstreamMode = "success";
  const afterRefused = await sendGatewayRequest(ready.port);
  equal(afterRefused.status, 200, "the same gateway recovers with a normal dummy upstream response after refusal");
  equal(successfulRequests, 1, "the refused request was not retried and recovery sent one upstream request");

  upstreamMode = "reset";
  const reset = await sendGatewayRequest(ready.port);
  equal(reset.status, 502, "an accepted upstream connection closed by the server maps to HTTP 502");
  equal(resetRequests, 1, "the reset case reached the listening upstream HTTP server");
  await waitUntil(() => resetSocketClosed, "the accepted reset socket must close");

  upstreamMode = "success";
  const afterReset = await sendGatewayRequest(ready.port);
  equal(afterReset.status, 200, "the same gateway recovers with a normal dummy upstream response after reset");
  equal(successfulRequests, 2, "the reset request was not retried and recovery sent one upstream request");

  upstreamMode = "timeout";
  const timeout = await sendGatewayRequest(ready.port);
  equal(timeout.status, 504, "an accepted upstream that withholds headers maps to HTTP 504");
  equal(timeoutRequests, 1, "the timeout case reached the listening upstream HTTP server");
  await waitUntil(() => timeoutSocketClosed, "the timeout must abort the accepted upstream socket");

  upstreamMode = "success";
  const afterTimeout = await sendGatewayRequest(ready.port);
  equal(afterTimeout.status, 200, "the same gateway recovers with a normal dummy upstream response after timeout");
  equal(successfulRequests, 3, "the timeout request was not retried and recovery sent one upstream request");

  child.stdin.write("shutdown\n");
  const summary = await nextChildMessage();
  equal(summary.type, "summary", "child returns only a safe production gateway summary");
  equal(summary.stats.requests, 6, "production gateway counted exactly six caller requests");
  equal(summary.stats.deepseek_requests, 6, "all six requests followed the native DeepSeek path");
  equal(summary.stats.relay_calls, 0, "the local transport probe did not relay calls");
  ok(acceptedByMode.reset >= 1, "the reset scenario had an accepted TCP connection");
  ok(acceptedByMode.timeout >= 1, "the timeout scenario had an accepted TCP connection");
  ok(acceptedByMode.success >= 3, "each recovery request reached a listening upstream");
  equal(resetRequests + timeoutRequests + successfulRequests, 5, "the upstream processed exactly five requests, with no retry or duplicate request");
  equal(summary.events.filter((event) => event.kind === "error" && event.status === 502).length, 2,
    "production gateway logged exactly two transport failures");
  equal(summary.events.filter((event) => event.kind === "deepseek_timeout" && event.status === 504).length, 1,
    "production gateway logged exactly one timeout");
  equal(summary.events.filter((event) => event.kind === "deepseek" && event.status === 200).length, 3,
    "production gateway logged exactly three successful recovery responses");
  const errorCodes = summary.events.filter((event) => event.kind === "error" && event.status === 502)
    .map((event) => event.code || "code-unavailable");
  const exited = await Promise.race([childExit, wait(4000).then(() => null)]);
  ok(exited && exited.code === 0, `owned gateway child exits cleanly within the bound (code=${exited?.code ?? "none"}, signal=${exited?.signal ?? "none"})`);
  childLines.close();
  console.log(`PASS 26 native transport fault assertions; accepted TCP connections=${acceptedConnections} (reset=${acceptedByMode.reset || 0}, timeout=${acceptedByMode.timeout || 0}, success=${acceptedByMode.success || 0}), upstream HTTP requests=${resetRequests + timeoutRequests + successfulRequests}, gateway transport codes=${errorCodes.join(",")}`);
} finally {
  if (child && child.exitCode === null) {
    child.stdin.write("shutdown\n");
    const exited = await Promise.race([childExit, wait(2000).then(() => null)]);
    if (!exited && child.exitCode === null) child.kill();
  }
  if (upstream.listening) await new Promise((resolve) => upstream.close(resolve));
  await rm(root, { recursive: true, force: true });
}
