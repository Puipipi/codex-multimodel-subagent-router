import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureGateway, gatewayPaths, gatewaySpawnOptions, gatewayStatus, prepareGatewayIdentity, readGatewayIdentity, readGatewayState, stopGateway,
} from "../scripts/native-gateway-manager.mjs";

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };

const dir = await mkdtemp(path.join(os.tmpdir(), "native-manager-"));
const paths = gatewayPaths(dir);
try {
  const identityDir = await mkdtemp(path.join(os.tmpdir(), "native-manager-identity-only-"));
  try {
    const identityPaths = gatewayPaths(identityDir);
    const preparedIdentities = await Promise.all([
      prepareGatewayIdentity({ paths: identityPaths }),
      prepareGatewayIdentity({ paths: identityPaths }),
    ]);
    ok(preparedIdentities[0].token.length >= 32, "identity-only preparation creates a private gateway capability");
    equal(preparedIdentities[0].token, preparedIdentities[1].token, "concurrent identity-only preparation is stable under the gateway lock");
    equal(preparedIdentities[0].port, preparedIdentities[1].port, "concurrent identity-only preparation reserves one stable port");
    equal((await readGatewayState(identityPaths)), null, "identity preparation does not start the gateway server");
    equal((await readGatewayIdentity(identityPaths)).token, preparedIdentities[0].token, "identity-only preparation persists the matching private identity");
  } finally { await rm(identityDir, { recursive: true, force: true }); }

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

  const taskLaunchDir = await mkdtemp(path.join(os.tmpdir(), "native-manager-task-launch-"));
  const taskLaunchPaths = gatewayPaths(taskLaunchDir);
  let taskToken;
  const taskServer = createServer((req, res) => {
    if (req.url === `/${taskToken}/_health`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  let taskLaunches = 0;
  let forbiddenSpawnCalls = 0;
  const taskLaunch = async ({ paths: receivedPaths, identity }) => {
    taskLaunches += 1;
    taskToken = identity.token;
    await new Promise((resolve, reject) => {
      taskServer.once("error", reject);
      taskServer.listen(identity.port, "127.0.0.1", resolve);
    });
    await writeFile(receivedPaths.state, JSON.stringify({
      pid: process.pid, port: identity.port, token: identity.token,
    }));
  };
  const forbiddenSpawn = () => { forbiddenSpawnCalls += 1; throw new Error("unexpected direct spawn fallback"); };
  try {
    const [taskFirst, taskConcurrent] = await Promise.all([
      ensureGateway({ paths: taskLaunchPaths, launchImpl: taskLaunch, spawnImpl: forbiddenSpawn }),
      ensureGateway({ paths: taskLaunchPaths, launchImpl: taskLaunch, spawnImpl: forbiddenSpawn }),
    ]);
    equal(taskLaunches, 1, "concurrent ensure starts the task only once under the gateway lock");
    equal(forbiddenSpawnCalls, 0, "explicit task launch never falls back to direct spawning");
    equal(taskFirst.state.pid, process.pid, "task launch waits for health and returns the verified fresh PID");
    equal(taskConcurrent.state.pid, process.pid, "concurrent ensure observes the task-launched listener");
    const launchedTask = [taskFirst, taskConcurrent].find((item) => item.started);
    ok(launchedTask, "one concurrent ensure reports the gateway as newly started");
    equal(launchedTask.pid, process.pid, "launch result derives PID from health rather than a child handle");
  } finally {
    if (taskServer.listening) await new Promise((resolve) => taskServer.close(resolve));
    await rm(taskLaunchDir, { recursive: true, force: true });
  }

  const taskTimeoutDir = await mkdtemp(path.join(os.tmpdir(), "native-manager-task-timeout-"));
  const taskTimeoutPaths = gatewayPaths(taskTimeoutDir);
  let failedTaskLaunches = 0;
  let timeoutFallbackCalls = 0;
  try {
    await assert.rejects(
      ensureGateway({
        paths: taskTimeoutPaths,
        startTimeoutMs: 25,
        launchImpl: async () => { failedTaskLaunches += 1; },
        spawnImpl: () => { timeoutFallbackCalls += 1; throw new Error("unexpected direct spawn fallback"); },
      }),
      /did not become healthy/,
    );
    equal(failedTaskLaunches, 1, "task launcher is requested once before the bounded health wait");
    equal(timeoutFallbackCalls, 0, "task startup timeout never falls back to detached direct spawning");
  } finally {
    await rm(taskTimeoutDir, { recursive: true, force: true });
  }

  const taskFailureDir = await mkdtemp(path.join(os.tmpdir(), "native-manager-task-failure-"));
  const taskFailurePaths = gatewayPaths(taskFailureDir);
  let launchFailureFallbackCalls = 0;
  try {
    await assert.rejects(
      ensureGateway({
        paths: taskFailurePaths,
        launchImpl: async () => { throw new Error("Task Scheduler launch failed"); },
        spawnImpl: () => { launchFailureFallbackCalls += 1; throw new Error("unexpected direct spawn fallback"); },
      }),
      /Task Scheduler launch failed/,
    );
    equal(launchFailureFallbackCalls, 0, "task launch errors propagate without direct-spawn fallback");
  } finally {
    await rm(taskFailureDir, { recursive: true, force: true });
  }

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
