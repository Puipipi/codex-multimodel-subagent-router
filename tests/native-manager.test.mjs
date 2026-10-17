import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureGateway, gatewayPaths, gatewaySpawnOptions, gatewayStatus, readGatewayState, stopGateway,
} from "../scripts/native-gateway-manager.mjs";

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };

const dir = await mkdtemp(path.join(os.tmpdir(), "native-manager-"));
const paths = gatewayPaths(dir);
try {
  const options = gatewaySpawnOptions();
  equal(options.windowsHide, true, "gateway spawn is hidden");
  equal(options.detached, true, "gateway spawn is detached from the caller");
  equal(options.stdio, "ignore", "gateway spawn uses no piped stdio");
  const first = await ensureGateway({ paths });
  ok(first.state.port > 0, "gateway listens on a loopback port");
  ok(first.state.token.length >= 32, "gateway writes a capability token to private state");
  equal((await gatewayStatus({ paths })).running, true, "status reports a healthy gateway");
  const healthyStatus = await gatewayStatus({ paths });
  const second = await ensureGateway({ paths });
  equal(second.started, false, "ensure is idempotent");
  equal(second.state.port, first.state.port, "idempotent ensure keeps the same instance");
  const state = await readGatewayState(paths);
  ok(state.pid > 0, "state records the gateway pid");
  const stopped = await stopGateway({ paths });
  equal(stopped.stopped, true, "authenticated shutdown stops the owned gateway");
  equal((await gatewayStatus({ paths })).running, false, "status is down after stop");
  const resumed = await ensureGateway({ paths });
  equal(resumed.state.port, first.state.port, "restart keeps the same stable port");
  equal(resumed.state.token, first.state.token, "restart keeps the same stable token and config endpoint");
  ok(resumed.started, "restart starts a fresh hidden process");
  await stopGateway({ paths });
  equal(healthyStatus.pid, first.state.pid, "status reports the PID verified by health");
  equal(healthyStatus.state_pid, first.state.pid, "status exposes the persisted state PID");

  const mismatchDir = await mkdtemp(path.join(os.tmpdir(), "native-manager-mismatch-"));
  const mismatchPaths = gatewayPaths(mismatchDir);
  const token = "test-health-token";
  let healthPayload = { ok: true, pid: process.pid };
  let shutdownRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === `/${token}/_health`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(healthPayload));
      return;
    }
    if (req.url === `/${token}/_shutdown`) shutdownRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const mismatchPort = server.address().port;
  const stalePid = process.pid + 1;
  await writeFile(mismatchPaths.state, JSON.stringify({ pid: stalePid, port: mismatchPort, token }));
  try {
    const mismatch = await gatewayStatus({ paths: mismatchPaths });
    equal(mismatch.running, false, "a healthy listener with a different PID is not the state gateway");
    equal(mismatch.pid, null, "unmatched state PID is not presented as live");
    equal(mismatch.state_pid, stalePid, "stale persisted PID remains visible for diagnosis");
    equal(mismatch.live_pid, process.pid, "health response exposes the actual listener PID");
    equal(mismatch.pid_status, "mismatch", "status classifies a PID mismatch");
    let spawnAttempts = 0;
    await assert.rejects(
      ensureGateway({ paths: mismatchPaths, spawnImpl: () => { spawnAttempts += 1; throw new Error("unexpected spawn"); } }),
      /identity is mismatch/,
    );
    equal(spawnAttempts, 0, "ensure does not launch a duplicate when another PID owns the listener");
    const refusedStop = await stopGateway({ paths: mismatchPaths });
    equal(refusedStop.reason, "pid_mismatch", "stop refuses to target a different live PID");
    equal(shutdownRequests, 0, "mismatched listener receives no shutdown request");

    healthPayload = { ok: true };
    const legacy = await gatewayStatus({ paths: mismatchPaths });
    equal(legacy.running, false, "legacy health without PID is not trusted");
    equal(legacy.pid_status, "unverified", "legacy health is classified as unverified");
    const refusedLegacyStop = await stopGateway({ paths: mismatchPaths });
    equal(refusedLegacyStop.reason, "pid_unverified", "stop refuses health responses without PID");
    equal(shutdownRequests, 0, "legacy listener receives no shutdown request");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(mismatchDir, { recursive: true, force: true });
  }

  const unreachableDir = await mkdtemp(path.join(os.tmpdir(), "native-manager-unreachable-"));
  const unreachablePaths = gatewayPaths(unreachableDir);
  await writeFile(unreachablePaths.state, JSON.stringify({ pid: 0, port: 1, token }));
  try {
    const unreachable = await gatewayStatus({ paths: unreachablePaths });
    equal(unreachable.running, false, "unreachable gateway is not reported as running");
    equal(unreachable.pid_status, "unreachable", "unreachable health has a distinct status");
    const unreachableStop = await stopGateway({ paths: unreachablePaths });
    equal(unreachableStop.reason, "stale_state_removed", "dead PID state is cleaned without contacting a listener");
  } finally {
    await rm(unreachableDir, { recursive: true, force: true });
  }

  const reusedPidDir = await mkdtemp(path.join(os.tmpdir(), "native-manager-reused-pid-"));
  const reusedPidPaths = gatewayPaths(reusedPidDir);
  await writeFile(reusedPidPaths.state, JSON.stringify({ pid: process.pid, port: 1, token }));
  try {
    const reusedPid = await gatewayStatus({ paths: reusedPidPaths });
    equal(reusedPid.running, false, "a reused PID without the gateway listener is not trusted");
    equal(reusedPid.pid_status, "unreachable", "a foreign process at the state PID is classified as unreachable");
    const refusedReusedPidStop = await stopGateway({ paths: reusedPidPaths });
    equal(refusedReusedPidStop.reason, "health_unreachable", "stop does not act on a reused PID without matching health");
    ok(await readGatewayState(reusedPidPaths), "unreachable state is retained when its PID is still occupied");
  } finally {
    await rm(reusedPidDir, { recursive: true, force: true });
  }
} finally {
  await stopGateway({ paths }).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}

console.log(`PASS ${checks} native manager assertions`);
