import http from "node:http";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  DEEPSEEK_BASE, NATIVE_BASE, PICKER_SLUG, buildDeepSeekBody,
  normalizeNativeAgentInput, normalizeRoutedAgentInput, routeForModel,
} from "./native-routing.mjs";
import { RelayCache, buildRelayRequest, parseRelayBody, relayCacheKey } from "./native-relay.mjs";
import { parseUsageFromSse } from "./native-usage.mjs";
import { readDeepSeekKey } from "./native-credentials.mjs";

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);
const NATIVE_RELAY_HEADERS = new Set([
  "authorization", "chatgpt-account-id", "originator", "openai-beta", "session_id",
  "session-id", "thread-id", "user-agent", "x-client-request-id", "x-codex-beta-features",
  "x-codex-installation-id", "x-codex-parent-thread-id", "x-codex-turn-metadata",
  "x-codex-turn-state", "x-codex-window-id", "x-oai-attestation", "x-openai-subagent",
]);
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_BYTES = 128 * 1024 * 1024;
const RELAY_RESPONSE_MAX = 4 * 1024 * 1024;

function defaultStateDir() {
  const base = process.env.LOCALAPPDATA
    || (process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local")
      : process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"));
  return path.join(base, "sol-luna-deepseek-router", "native-gateway");
}

function decodeBody(raw, encoding) {
  const options = { maxOutputLength: MAX_DECODED_BYTES };
  switch ((encoding || "").toLowerCase()) {
    case "gzip": return gunzipSync(raw, options);
    case "deflate": return inflateSync(raw, options);
    case "br": return brotliDecompressSync(raw, options);
    case "zstd": return zstdDecompressSync(raw, options);
    case "": case "identity": return raw;
    default: throw Object.assign(new Error(`unsupported content-encoding: ${encoding}`), { status: 415 });
  }
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function localPath(pathname, token) {
  const first = pathname.indexOf("/", 1);
  const candidate = first < 0 ? pathname.slice(1) : pathname.slice(1, first);
  if (candidate !== token) return null;
  return first < 0 ? "/" : pathname.slice(first) || "/";
}

function upstreamPath(pathname) {
  return pathname.startsWith("/v1/") ? pathname.slice(3) : pathname;
}

function json(res, status, body) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": payload.length });
  res.end(payload);
}

function responseHeaders(upstream) {
  const headers = new Headers();
  for (const [name, value] of upstream.headers) {
    if (HOP.has(name) || name === "content-encoding" || name === "content-length") continue;
    headers.set(name, value);
  }
  return headers;
}

async function monitorUsage(stream, onDone) {
  const reader = stream.getReader();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        text += Buffer.from(value).toString("utf8");
        if (text.length > 4 * 1024 * 1024) text = text.slice(-4 * 1024 * 1024);
      }
    }
  } catch { /* client branch owns the response */ }
  onDone(parseUsageFromSse(text));
}

function relayHeaders(req) {
  const headers = new Headers({ "content-type": "application/json", accept: "text/event-stream" });
  for (const [name, value] of Object.entries(req.headers)) {
    if (NATIVE_RELAY_HEADERS.has(name) && value !== undefined) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  return headers;
}

export function createNativeGateway({
  deepSeekKey = null,
  logPath,
  nativeBase = NATIVE_BASE,
  deepSeekBase = DEEPSEEK_BASE,
  relayModel = process.env.SOL_LUNA_NATIVE_RELAY_MODEL || "gpt-6.1-sol",
  fetchImpl = fetch,
  token = randomBytes(32).toString("base64url"),
  maxRelayCalls = Infinity,
  relayTimeoutMs = 120_000,
  onShutdown = null,
} = {}) {
  if (!logPath) throw new Error("native gateway logPath is required");
  const cache = new RelayCache();
  const stats = {
    requests: 0, openai_requests: 0, deepseek_requests: 0,
    openai_usages: [], deepseek_usages: [], relay_usages: [],
    openai_latencies_ms: [], deepseek_latencies_ms: [], relay_latencies_ms: [],
    relay_calls: 0, relay_cache_hits: 0, relay_errors: 0,
    child_thread_ids: [], statuses: [],
  };
  const log = (event) => {
    try {
      mkdirSync(path.dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
    } catch { /* logging must not break inference */ }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const routePath = localPath(url.pathname, token);
    if (routePath === null) { json(res, 401, { error: { message: "unauthorized" } }); return; }
    if (req.method === "GET" && routePath === "/_health") {
      json(res, 200, {
        ok: true, model: PICKER_SLUG, deepseek_key: Boolean(deepSeekKey),
        requests: stats.requests, relay_calls: stats.relay_calls,
        relay_cache_hits: stats.relay_cache_hits,
      });
      return;
    }
    if (req.method === "POST" && routePath === "/_shutdown") {
      if (req.headers["x-sol-luna-token"] !== token) { json(res, 401, { error: { message: "unauthorized" } }); return; }
      json(res, 202, { ok: true });
      if (typeof onShutdown === "function") setImmediate(onShutdown);
      return;
    }
    if (req.method !== "POST") { json(res, 405, { error: { message: "POST only" } }); return; }

    const started = Date.now();
    const threadId = req.headers["thread-id"] || req.headers["session_id"] || null;
    const parentThreadId = req.headers["x-codex-parent-thread-id"] || null;
    if (parentThreadId && threadId && threadId !== parentThreadId && !stats.child_thread_ids.includes(threadId)) {
      stats.child_thread_ids.push(threadId);
    }
    let direction = "unknown";
    try {
      const raw = await readBody(req);
      const parsed = JSON.parse(decodeBody(raw, req.headers["content-encoding"]).toString("utf8"));
      direction = routeForModel(parsed.model);
      stats.requests += 1;
      log({ kind: "request", route: direction, model: parsed.model, thread_id: threadId, parent_thread_id: parentThreadId, bytes: raw.length });

      if (direction === "deepseek") {
        if (!deepSeekKey) { json(res, 503, { error: { message: "DeepSeek credential is not configured" } }); return; }
        stats.deepseek_requests += 1;
        const relay = async ({ item, encrypted }) => {
          const authorization = String(req.headers.authorization || "");
          if (!authorization) throw Object.assign(new Error("native relay requires ChatGPT authentication"), { status: 401 });
          const { key } = relayCacheKey({ authorization, account: req.headers["chatgpt-account-id"] || "", ciphertext: encrypted });
          const payload = await cache.run(key, async () => {
            if (stats.relay_calls >= maxRelayCalls) throw Object.assign(new Error("native relay call cap reached"), { status: 429 });
            stats.relay_calls += 1;
            const relayStarted = Date.now();
            const response = await fetchImpl(`${nativeBase.replace(/\/$/, "")}/responses`, {
              method: "POST",
              headers: relayHeaders(req),
              body: JSON.stringify(buildRelayRequest(item, { model: relayModel })),
              signal: AbortSignal.timeout(relayTimeoutMs),
            });
            const buffer = Buffer.from(await response.arrayBuffer());
            stats.relay_latencies_ms.push(Date.now() - relayStarted);
            stats.statuses.push(response.status);
            if (!response.ok) {
              stats.relay_errors += 1;
              log({ kind: "relay", status: response.status, latency_ms: Date.now() - relayStarted });
              throw Object.assign(new Error("native relay failed"), { status: response.status });
            }
            if (buffer.length > RELAY_RESPONSE_MAX) throw Object.assign(new Error("native relay response too large"), { status: 502 });
            const result = parseRelayBody(buffer, response.headers.get("content-type") || "");
            if (!result) throw Object.assign(new Error("native relay omitted payload"), { status: 502 });
            const usage = result.usage || parseUsageFromSse(buffer.toString("utf8"));
            stats.relay_usages.push(usage || null);
            log({ kind: "relay", status: response.status, latency_ms: Date.now() - relayStarted, usage: usage || null });
            return result.payload;
          });
          stats.relay_cache_hits = cache.metrics.hits;
          return payload;
        };
        const input = Array.isArray(parsed.input) ? await normalizeRoutedAgentInput(parsed.input, { relay }) : parsed.input;
        const body = buildDeepSeekBody({ ...parsed, input });
        const headers = new Headers({
          authorization: `Bearer ${deepSeekKey}`,
          "content-type": "application/json",
          accept: req.headers.accept || "text/event-stream",
          "user-agent": req.headers["user-agent"] || "sol-luna-native-gateway",
        });
        const upstream = await fetchImpl(`${deepSeekBase.replace(/\/$/, "")}/responses`, {
          method: "POST", headers, body: JSON.stringify(body),
        });
        stats.statuses.push(upstream.status);
        stats.deepseek_latencies_ms.push(Date.now() - started);
        if (upstream.status !== 200) {
          const errorBody = Buffer.from(await upstream.arrayBuffer());
          stats.deepseek_usages.push(null);
          log({ kind: "deepseek_error", status: upstream.status, body: errorBody.toString("utf8").slice(0, 800) });
          res.writeHead(upstream.status, Object.fromEntries(responseHeaders(upstream).entries()));
          res.end(errorBody);
          return;
        }
        res.writeHead(upstream.status, Object.fromEntries(responseHeaders(upstream).entries()));
        if (!upstream.body) { stats.deepseek_usages.push(null); res.end(); return; }
        const [toClient, toMonitor] = upstream.body.tee();
        Readable.fromWeb(toClient).on("error", (error) => res.destroy(error)).pipe(res);
        await monitorUsage(toMonitor, (usage) => {
          stats.deepseek_usages.push(usage || null);
          log({ kind: "deepseek", status: upstream.status, model: PICKER_SLUG, usage: usage || null, latency_ms: Date.now() - started });
        });
        return;
      }

      const nativeNormalized = normalizeNativeAgentInput(parsed.input);
      const outgoing = nativeNormalized ? Buffer.from(JSON.stringify({ ...parsed, input: nativeNormalized })) : raw;
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || HOP.has(name) || name === "content-length") continue;
        if (name === "content-encoding" && nativeNormalized) continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      headers.set("content-type", "application/json");
      const upstream = await fetchImpl(`${nativeBase.replace(/\/$/, "")}${upstreamPath(routePath)}${url.search}`, {
        method: "POST", headers, body: outgoing,
      });
      stats.openai_requests += 1;
      stats.openai_latencies_ms.push(Date.now() - started);
      stats.statuses.push(upstream.status);
      log({ kind: "openai", status: upstream.status, model: parsed.model, latency_ms: Date.now() - started, native_plaintext_restored: Boolean(nativeNormalized) });
      res.writeHead(upstream.status, Object.fromEntries(responseHeaders(upstream).entries()));
      if (!upstream.body) { stats.openai_usages.push(null); res.end(); return; }
      const [toClient, toMonitor] = upstream.body.tee();
      Readable.fromWeb(toClient).on("error", (error) => res.destroy(error)).pipe(res);
      await monitorUsage(toMonitor, (usage) => {
        stats.openai_usages.push(usage || null);
        log({ kind: "openai_usage", status: upstream.status, model: parsed.model, usage: usage || null });
      });
    } catch (error) {
      log({ kind: "error", status: error?.status || 502, code: error?.code || null, message: String(error?.message || error).slice(0, 300) });
      if (!res.headersSent) json(res, Number.isInteger(error?.status) ? error.status : 502, { error: { message: "native gateway request failed" } });
      else res.destroy();
    }
  });

  return {
    server,
    token,
    stats,
    cache,
    async start(port = 0) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      return server.address().port;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function stateFileFromArgs(argv) {
  const at = argv.indexOf("--state");
  if (at >= 0 && argv[at + 1]) return path.resolve(argv[at + 1]);
  return path.join(defaultStateDir(), "gateway.json");
}

function writeStateAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, file);
}

async function serve(argv) {
  const stateFile = stateFileFromArgs(argv);
  const identityAt = argv.indexOf("--identity");
  const identityFile = identityAt >= 0 && argv[identityAt + 1] ? path.resolve(argv[identityAt + 1]) : null;
  let identity = null;
  if (identityFile) {
    try { identity = JSON.parse(readFileSync(identityFile, "utf8")); } catch { identity = null; }
  }
  const token = identity?.token || randomBytes(32).toString("base64url");
  const preferredPort = Number.isInteger(identity?.port) ? identity.port : 0;
  const logAt = argv.indexOf("--log");
  const logPath = logAt >= 0 && argv[logAt + 1]
    ? path.resolve(argv[logAt + 1])
    : path.join(path.dirname(stateFile), "gateway.log");
  let deepSeekKey = null;
  try { deepSeekKey = readDeepSeekKey(); } catch { /* GPT-only startup remains possible */ }
  let closing = false;
  const gateway = createNativeGateway({
    deepSeekKey, logPath, token,
    onShutdown: () => {
      if (closing) return;
      closing = true;
      gateway.close().finally(() => {
        try {
          const current = JSON.parse(readFileSync(stateFile, "utf8"));
          if (current.token === gateway.token) rmSync(stateFile, { force: true });
        } catch { /* best effort */ }
        process.exit(0);
      });
    },
  });
  const port = await gateway.start(preferredPort);
  if (identityFile && !identity) {
    mkdirSync(path.dirname(identityFile), { recursive: true, mode: 0o700 });
    const temp = `${identityFile}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ version: 1, token, port, created_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, identityFile);
  }
  writeStateAtomic(stateFile, {
    version: 1, pid: process.pid, port, token,
    started_at: new Date().toISOString(), model: PICKER_SLUG, log: logPath,
    identity: identityFile,
  });
  const shutdown = () => {
    if (closing) return;
    closing = true;
    gateway.close().finally(() => {
      try {
        const current = JSON.parse(readFileSync(stateFile, "utf8"));
        if (current.token === gateway.token) rmSync(stateFile, { force: true });
      } catch { /* best effort */ }
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--serve")) {
    process.stderr.write("usage: node scripts/native-gateway.mjs --serve --state <private-state.json> [--log <private.log>]\n");
    process.exitCode = 2;
  } else {
    serve(process.argv.slice(2)).catch((error) => {
      process.stderr.write(`${String(error?.message || error)}\n`);
      process.exitCode = 1;
    });
  }
}
