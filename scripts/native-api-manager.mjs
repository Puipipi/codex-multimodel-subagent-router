import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureGateway,
  gatewayHealth,
  gatewayPaths,
  gatewayStatus,
  readGatewayIdentity,
  readGatewayState,
  stopGateway,
} from "./native-gateway-manager.mjs";
import {
  createOwnedGatewayTaskLauncher,
  createWindowsTaskSchedulerAdapter,
  gatewayTaskPlan,
  statusOwnedGatewayTask,
} from "./native-gateway-task.mjs";

export function defaultNativeApiDir(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "sol-luna-deepseek-router", "native-api");
}

export function apiServicePaths(apiDir = defaultNativeApiDir()) {
  return gatewayPaths(path.join(path.resolve(apiDir), "gateway"));
}

export function apiTaskPlan({ apiDir = defaultNativeApiDir(), gatewayScriptPath, nodePath = process.execPath, wscriptPath } = {}) {
  return gatewayTaskPlan({
    paths: apiServicePaths(apiDir),
    gatewayScriptPath,
    nodePath,
    wscriptPath,
    service: "api",
  });
}

export async function verifyApiHealth(state) {
  const health = await gatewayHealth(state);
  if (health.reachable !== true || health.pid !== state?.pid) throw new Error("native API gateway is not healthy");
  if (health.api_only !== true || health.relay_allowed !== false) {
    throw new Error("native API gateway health is not api_only=true relay_allowed=false");
  }
  return health;
}

export async function ensureApiGateway({ apiDir = defaultNativeApiDir(), taskAdapter, gatewayScriptPath, paths = apiServicePaths(apiDir) } = {}) {
  if (typeof gatewayScriptPath !== "string" || !path.isAbsolute(gatewayScriptPath)) throw new Error("gatewayScriptPath must be absolute");
  const tasks = taskAdapter || createWindowsTaskSchedulerAdapter();
  const plan = apiTaskPlan({ apiDir, gatewayScriptPath });
  const task = await statusOwnedGatewayTask(plan, tasks);
  if (!task.exists || !task.owned || task.specMatches !== true || !task.enabled) {
    throw new Error("native API Task Scheduler task is missing, changed, or disabled");
  }
  const launchImpl = createOwnedGatewayTaskLauncher(plan, tasks);
  const ensured = await ensureGateway({ paths, launchImpl });
  const identity = await readGatewayIdentity(paths);
  const state = ensured.state;
  if (!state?.token || state.token !== identity?.token || state.port !== identity?.port || !Number.isInteger(state.pid)) {
    throw new Error("native API gateway state does not match its private identity");
  }
  await verifyApiHealth(state);
  const currentTask = await statusOwnedGatewayTask(plan, tasks);
  if (currentTask.state !== "Running") throw new Error("native API Task Scheduler task is not Running");
  return { state, started: ensured.started, taskName: plan.name, gatewayDir: paths.dir };
}

export async function stopApiGateway({ apiDir = defaultNativeApiDir(), paths = apiServicePaths(apiDir) } = {}) {
  return stopGateway({ paths });
}

export async function apiStatus({ apiDir = defaultNativeApiDir(), paths = apiServicePaths(apiDir) } = {}) {
  const state = await readGatewayState(paths);
  if (!state) return { running: false, state: null, api_only: null, relay_allowed: null };
  const health = await gatewayHealth(state);
  return {
    ...(await gatewayStatus({ paths })),
    api_only: health.api_only,
    relay_allowed: health.relay_allowed,
  };
}

async function main(argv) {
  const command = argv[0] || "status";
  const value = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at < 0 ? undefined : argv[at + 1];
  };
  const apiDir = value("api-dir") || defaultNativeApiDir();
  const gatewayScriptPath = value("gateway-script");
  if (command === "start" || command === "ensure") {
    const result = await ensureApiGateway({ apiDir, gatewayScriptPath });
    process.stdout.write(`${JSON.stringify({ started: result.started, pid: result.state.pid, port: result.state.port, task: result.taskName })}\n`);
    return;
  }
  if (command === "stop") {
    process.stdout.write(`${JSON.stringify(await stopApiGateway({ apiDir }))}\n`);
    return;
  }
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(await apiStatus({ apiDir }))}\n`);
    return;
  }
  throw new Error("usage: native-api-manager.mjs <start|ensure|stop|status> [--api-dir PATH] [--gateway-script PATH]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
