import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`PASS ${checks} native manager assertions`);
