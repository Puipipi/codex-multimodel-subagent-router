import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withFileLock } from "./plugin-state.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GATEWAY_SCRIPT = path.join(REPO_ROOT, "scripts", "native-gateway.mjs");
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 8_000;

export function gatewayPaths(explicitDir) {
  const base = explicitDir || process.env.SOL_LUNA_NATIVE_GATEWAY_DIR
    || (process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "sol-luna-deepseek-router", "native-gateway")
      : path.join(os.homedir(), ".local", "state", "sol-luna-deepseek-router", "native-gateway"));
  return {
    dir: path.resolve(base),
    state: path.join(path.resolve(base), "gateway.json"),
    identity: path.join(path.resolve(base), "identity.json"),
    log: path.join(path.resolve(base), "gateway.log"),
    lock: path.join(path.resolve(base), "gateway.start.lock"),
  };
}

export function gatewaySpawnOptions(env = process.env) {
  return { cwd: REPO_ROOT, detached: true, windowsHide: true, stdio: "ignore", env: { ...env } };
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

export async function readGatewayState(paths = gatewayPaths()) {
  return readJson(paths.state);
}

export async function readGatewayIdentity(paths = gatewayPaths()) {
  return readJson(paths.identity);
}

async function writeJsonPrivate(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await import("node:fs/promises").then(({ rename }) => rename(temp, file));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

export async function gatewayHealth(state, timeoutMs = 2_000) {
  if (!state?.port || !state?.token) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/${state.token}/_health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(paths, timeoutMs) {
  const started = Date.now();
  for (;;) {
    const state = await readGatewayState(paths);
    if (state && await gatewayHealth(state)) return state;
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`Native gateway did not become healthy; inspect ${paths.log} and ${paths.state}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

export async function ensureGateway({ paths = gatewayPaths(), spawnImpl = spawn } = {}) {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const existing = await readGatewayState(paths);
  if (existing && await gatewayHealth(existing)) return { state: existing, started: false };

  return withFileLock(paths.lock, async () => {
    const again = await readGatewayState(paths);
    if (again && await gatewayHealth(again)) return { state: again, started: false };
    if (again && isAlive(again.pid)) {
      throw new Error(`Native gateway state exists for a live PID ${again.pid} but health failed; refusing to start a second instance. Inspect ${paths.log}.`);
    }
    if (again) rmSync(paths.state, { force: true });

    let identity = await readGatewayIdentity(paths);
    if (!identity?.token || !identity?.port) {
      identity = {
        version: 1,
        token: randomBytes(32).toString("base64url"),
        port: await freePort(),
        created_at: new Date().toISOString(),
      };
      await writeJsonPrivate(paths.identity, identity);
    }
    const child = spawnImpl(process.execPath, [
      GATEWAY_SCRIPT, "--serve", "--state", paths.state, "--identity", paths.identity, "--log", paths.log,
    ], gatewaySpawnOptions());
    child.unref();
    const state = await waitForHealth(paths, START_TIMEOUT_MS);
    return { state, started: true, pid: child.pid };
  }, { timeoutMs: 30_000 });
}

export async function stopGateway({ paths = gatewayPaths() } = {}) {
  const state = await readGatewayState(paths);
  if (!state) return { stopped: false, reason: "not_running" };
  if (!isAlive(state.pid)) {
    rmSync(paths.state, { force: true });
    return { stopped: false, reason: "stale_state_removed" };
  }
  const response = await fetch(`http://127.0.0.1:${state.port}/${state.token}/_shutdown`, {
    method: "POST",
    headers: { "x-sol-luna-token": state.token },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Native gateway shutdown was rejected with HTTP ${response.status}`);
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await gatewayHealth(state))) {
      const current = await readGatewayState(paths);
      if (current?.token === state.token) rmSync(paths.state, { force: true });
      return { stopped: true, pid: state.pid };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Native gateway PID ${state.pid} did not stop; it was not force-killed.`);
}

export async function gatewayStatus({ paths = gatewayPaths() } = {}) {
  const state = await readGatewayState(paths);
  if (!state) return { running: false, state: null };
  return {
    running: await gatewayHealth(state),
    pid: state.pid,
    port: state.port,
    model: state.model || null,
    started_at: state.started_at || null,
    log: state.log || paths.log,
  };
}

async function main(argv) {
  const command = argv[0] || "status";
  const json = argv.includes("--json");
  const dirAt = argv.indexOf("--dir");
  const paths = gatewayPaths(dirAt >= 0 ? argv[dirAt + 1] : undefined);
  if (command === "start" || command === "ensure") {
    const result = await ensureGateway({ paths });
    process.stdout.write(json ? `${JSON.stringify({ started: result.started, pid: result.state.pid, port: result.state.port, model: result.state.model })}\n` : `native gateway ${result.started ? "started" : "already running"}\n`);
    return;
  }
  if (command === "stop") {
    const result = await stopGateway({ paths });
    process.stdout.write(json ? `${JSON.stringify(result)}\n` : `native gateway ${result.stopped ? "stopped" : result.reason}\n`);
    return;
  }
  if (command === "status") {
    const result = await gatewayStatus({ paths });
    process.stdout.write(json ? `${JSON.stringify(result)}\n` : `native gateway ${result.running ? "healthy" : "not running"}\n`);
    return;
  }
  throw new Error("usage: native-gateway-manager.mjs <start|ensure|stop|status> [--dir PATH] [--json]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
