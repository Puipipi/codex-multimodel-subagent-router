import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_RUNTIME_PATCH_SHA256, NATIVE_RUNTIME_SOURCE_COMMIT, NATIVE_RUNTIME_TARGET, NATIVE_RUNTIME_VERSION } from "../scripts/native-runtime.mjs";
import { gatewayPaths, readGatewayIdentity } from "../scripts/native-gateway-manager.mjs";
import { autostartFile, autostartScript } from "../scripts/native-autostart.mjs";
import { activate, decodeJournal, encodeJournal, ensureNativeDeepseekDispatch, prepare, rollback, status } from "../scripts/native-isolated-install.mjs";

let checks = 0;
const equal = (a, b, m) => { assert.equal(a, b, m); checks += 1; };
const ok = (v, m) => { assert.ok(v, m); checks += 1; };
const rejects = async (f, p, m) => { await assert.rejects(f, p, m); checks += 1; };
const sha = (value) => createHash("sha256").update(value).digest("hex");
const root = await mkdtemp(path.join(os.tmpdir(), "native-isolated-install-test-"));

async function fixture(label) {
  const dir = path.join(root, label);
  const versionDir = path.join(dir, "runtime", "versions", "approved");
  const codexHome = path.join(dir, "codex-home");
  const gatewayDir = path.join(dir, "isolated-gateway");
  const startupDir = path.join(dir, "startup");
  const journalPath = path.join(dir, "journal", "install.json");
  await mkdir(versionDir, { recursive: true });
  await mkdir(path.join(codexHome, "agents"), { recursive: true });
  await mkdir(startupDir, { recursive: true });
  const files = {
    "codex.exe": Buffer.from("staged fixture bytes"),
    "provenance.json": Buffer.from(JSON.stringify({ source_commit: NATIVE_RUNTIME_SOURCE_COMMIT, patch_sha256: NATIVE_RUNTIME_PATCH_SHA256, target: NATIVE_RUNTIME_TARGET }) + "\n"),
    "codex-code-mode-host.exe": Buffer.from("host"),
    "codex-command-runner.exe": Buffer.from("runner"),
    "codex-windows-sandbox-setup.exe": Buffer.from("sandbox"),
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(versionDir, name), bytes);
  await writeFile(path.join(versionDir, "runtime-manifest.json"), `${JSON.stringify({
    version: NATIVE_RUNTIME_VERSION, source_commit: NATIVE_RUNTIME_SOURCE_COMMIT,
    patch_sha256: NATIVE_RUNTIME_PATCH_SHA256, target: NATIVE_RUNTIME_TARGET,
    stock_cli_version: NATIVE_RUNTIME_VERSION, binary_sha256: sha(files["codex.exe"]),
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)])),
  }, null, 2)}\n`);
  await writeFile(path.join(codexHome, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-current", visibility: "list", context_window: 1000 }] }));
  await writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-current"\n');
  const environment = new Map([["CODEX_CLI_PATH", { present: false, value: null }], ["SOL_LUNA_NATIVE_PLAINTEXT_V2", { present: false, value: null }], ["PATH", { present: true, value: "keep" }]]);
  const envAdapter = {
    async get(key) { return structuredClone(environment.get(key) ?? { present: false, value: null }); },
    async set(key, value) { environment.set(key, structuredClone(value)); },
  };
  const startup = new Map([[autostartFile(startupDir), Buffer.from(autostartScript({ gatewayDir }), "utf8")]]);
  const autostartAdapter = {
    async get(file) { const bytes = startup.get(file); return bytes ? Buffer.from(bytes) : null; },
    async set(file, bytes) { if (bytes === null) startup.delete(file); else startup.set(file, Buffer.from(bytes)); },
  };
  const state = { pid: 12345 };
  const ensureCalls = [];
  const taskCalls = [];
  let taskState = { exists: false, owned: false, specMatches: false, enabled: false, state: "Missing", lastTaskResult: null };
  const taskAdapter = {
    async status(plan) { taskCalls.push(["status", plan.name]); return { ...taskState }; },
    async register(plan) { taskCalls.push(["register", plan.name]); taskState = { exists: true, owned: true, specMatches: true, enabled: true, state: "Ready", lastTaskResult: 0 }; },
    async start(plan) { taskCalls.push(["start", plan.name]); if (!taskState.exists || !taskState.owned) throw new Error("missing owned task"); taskState.state = "Running"; return { started: true }; },
    async unregister(plan) { taskCalls.push(["unregister", plan.name]); if (!taskState.owned) throw new Error("missing owned task"); taskState = { exists: false, owned: false, specMatches: false, enabled: false, state: "Missing", lastTaskResult: null }; return { removed: true }; },
  };
  const ensureGateway = async ({ paths, launchImpl }) => {
    ensureCalls.push(paths);
    const identity = await readGatewayIdentity(paths);
    await launchImpl({ paths, identity });
    const launchedState = { pid: state.pid, port: identity.port, token: identity.token };
    await writeFile(paths.state, JSON.stringify(launchedState));
    return { state: launchedState, started: true };
  };
  const stopCalls = [];
  const stopGateway = async ({ paths }) => { stopCalls.push({ paths }); await rm(paths.state, { force: true }); };
  const smokeCheck = async ({ preparedHome, exePath, expectedMainModel, expectedMainProvider, expectedRootBaseUrl }) => {
    equal(exePath, path.join(versionDir, "codex.exe"), "smoke receives verified staged executable");
    equal(expectedMainModel, "gpt-current", "smoke receives explicitly selected main model");
    equal(expectedMainProvider, null, "smoke receives an explicit unset provider");
    equal(expectedRootBaseUrl, null, "smoke explicitly verifies the root URL remains unset");
    ok(await readFile(path.join(preparedHome, "agents/native_deepseek.toml"), "utf8"), "smoke fixture contains the generated role file");
    const fixtureConfig = await readFile(path.join(preparedHome, "config.toml"), "utf8");
    ok(fixtureConfig.includes(JSON.stringify(path.join(preparedHome, "models_cache.json"))), "smoke root catalog points at the temporary full model cache");
    return { status: "passed", checks: ["fixture" ] };
  };
  const gatewayScriptPath = fileURLToPath(new URL("../scripts/native-gateway.mjs", import.meta.url));
  const common = { versionDir, codexHome, gatewayDir, startupDir, journalPath, gatewayScriptPath, expectedMainModel: "gpt-current", expectedMainProvider: null, expectedRootBaseUrl: null, envAdapter, autostartAdapter, taskAdapter, ensureGateway, stopGateway, smokeCheck };
  const activateFixture = (options = {}, dependencies = {}) => activate({ journalPath, envAdapter, autostartAdapter, taskAdapter, ...options }, { ensureGateway, gatewayHealth: async (value) => ({ reachable: true, pid: value.pid }), stopGateway, ...dependencies });
  const rollbackFixture = (options = {}) => rollback({ journalPath, envAdapter, autostartAdapter, taskAdapter, ...options }, {
    gatewayHealth: async (value) => ({ reachable: true, pid: value.pid }), stopGateway,
    readGatewayIdentity, readGatewayState: async (paths) => JSON.parse(await readFile(paths.state, "utf8")),
  });
  return { dir, versionDir, codexHome, gatewayDir, startupDir, journalPath, environment, envAdapter, startup, autostartAdapter, taskAdapter, state, ensureCalls, taskCalls, stopCalls, common, activateFixture, rollbackFixture };
}

try {
  const bytes = Buffer.from([0, 255, 1, 2, 128]);
  const encoded = encodeJournal({ sample: bytes, absent: null });
  const decoded = decodeJournal(encoded);
  equal(decoded.sample.toString("base64"), bytes.toString("base64"), "journal preserves arbitrary Buffer bytes through base64");
  equal(decoded.absent, null, "journal preserves absent snapshot values");

  const missingSmoke = await fixture("missing-smoke");
  let forbiddenEnsureCalls = 0;
  await rejects(() => prepare({ ...missingSmoke.common, smokeCheck: undefined }, { ensureGateway: async () => { forbiddenEnsureCalls += 1; } }), /smoke.*required/i, "prepare rejects when real smoke is not configured");
  equal(forbiddenEnsureCalls, 0, "missing smoke is rejected before starting any gateway");
  await rejects(() => prepare({ ...missingSmoke.common, gatewayScriptPath: "scripts/native-gateway.mjs" }), /must be absolute/i, "prepare rejects relative gateway script paths");
  if (process.platform === "win32") {
    const upperDefault = gatewayPaths().dir.toUpperCase();
    await rejects(() => prepare({ ...missingSmoke.common, gatewayDir: upperDefault, smokeCheck: () => ({ status: "passed" }) }), /separate from the legacy\/default gateway directory/i, "Windows case-only path alias cannot target the old gateway directory");
  }

  const f = await fixture("startup-failure");
  const prepared = await prepare(f.common);
  equal(f.ensureCalls.length, 0, "prepare does not start a gateway process");
  const preparedText = JSON.stringify(prepared);
  equal(preparedText.includes(f.state.token), false, "prepare output does not expose gateway token");
  equal(preparedText.includes("model_provider"), false, "prepare output does not expose full config content");
  if (process.platform !== "win32") equal((await lstat(f.journalPath)).mode & 0o777, 0o600, "journal is created with private permissions");
  const before = await status({ journalPath: f.journalPath });
  equal(before.phase, "prepared", "status reports prepared before activation");
  equal(before.configured, false, "prepared journal is not reported configured");
  equal(before.runtimeObserved, false, "prepared journal makes no runtime observation");
  const callStart = f.taskCalls.length;
  const failingAutostart = { ...f.autostartAdapter, async set() { throw new Error("startup write failed"); } };
  await rejects(() => f.activateFixture({ autostartAdapter: failingAutostart }), /startup write failed/i, "startup failure is surfaced after owned task and gateway startup");
  equal(await readFile(path.join(f.codexHome, "config.toml"), "utf8"), 'model = "gpt-current"\n', "startup failure rolls back files");
  equal(f.environment.get("CODEX_CLI_PATH").present, false, "startup failure rolls back environment");
  equal((await status({ journalPath: f.journalPath })).configured, false, "failed activation is not reported configured");
  const activationCalls = f.taskCalls.slice(callStart).map(([operation]) => operation);
  ok(activationCalls.indexOf("register") >= 0 && activationCalls.indexOf("start") > activationCalls.indexOf("register"), "activation registers the owned task before asking it to start the gateway");

  const envFailure = await fixture("environment-failure");
  await prepare(envFailure.common);
  const failingEnv = {
    ...envFailure.envAdapter,
    async set(key, value) {
      if (key === "SOL_LUNA_NATIVE_PLAINTEXT_V2") throw new Error("environment setter failed");
      return envFailure.envAdapter.set(key, value);
    },
  };
  await rejects(() => envFailure.activateFixture({ envAdapter: failingEnv }), /environment setter failed/i, "environment failure is surfaced");
  equal(await readFile(path.join(envFailure.codexHome, "config.toml"), "utf8"), 'model = "gpt-current"\n', "environment failure rolls back previously applied files");
  equal(envFailure.environment.get("CODEX_CLI_PATH").present, false, "environment failure restores the first environment key");

  const uncertainEnv = await fixture("environment-recovery-failure");
  await prepare(uncertainEnv.common);
  let setterCall = 0;
  const indeterminateEnv = {
    ...uncertainEnv.envAdapter,
    async set(key, value) {
      setterCall += 1;
      if (setterCall === 2) {
        await uncertainEnv.envAdapter.set(key, value);
        throw new Error("primary environment mutation failure");
      }
      if (setterCall === 3) throw new Error("environment restore failure");
      return uncertainEnv.envAdapter.set(key, value);
    },
  };
  await rejects(() => uncertainEnv.activateFixture({ envAdapter: indeterminateEnv }), (error) => {
    const messages = [];
    const collect = (item) => { messages.push(item?.message ?? String(item)); for (const nested of item?.errors ?? []) collect(nested); };
    collect(error);
    const details = messages.join(" | ");
    return /primary environment mutation failure/i.test(details) && /environment restore failure/i.test(details);
  }, "failed internal environment recovery is reported with both errors");
  const uncertainStatus = await status({ journalPath: uncertainEnv.journalPath });
  equal(uncertainStatus.phase, "activation_recovery_failed", "internal recovery failure is not mislabeled clean failure");
  equal(uncertainStatus.indeterminateStages.includes("environment"), true, "status names the stage whose state is uncertain");
  await rejects(() => uncertainEnv.rollbackFixture(), /indeterminate stages requiring manual recovery/i, "rollback refuses to guess at an indeterminate stage");

  const failedSmoke = await fixture("failed-smoke");
  await rejects(() => prepare({ ...failedSmoke.common, smokeCheck: async () => ({ status: "failed", checks: [] }) }), /status=passed/i, "failed smoke prevents a journal and activation");
  equal(failedSmoke.ensureCalls.length, 0, "failed prepare smoke never starts a gateway process");
  equal(await readFile(failedSmoke.journalPath).catch(() => null), null, "failed smoke leaves no install journal");

  const legacy = await fixture("legacy-migration");
  const legacyText = [
    '# sol-luna-native-gateway begin',
    'openai_base_url = "http://127.0.0.1:43127/secret/v1"',
    'model_catalog_json = "old-shared-catalog.json"',
    '# sol-luna-native-gateway end',
    'model = "gpt-current"',
    'model_provider = "openai"',
    '',
  ].join("\n");
  await writeFile(path.join(legacy.codexHome, "config.toml"), legacyText);
  const legacyManifestPath = path.join(legacy.dir, "legacy-manifest.json");
  await writeFile(legacyManifestPath, JSON.stringify({ prior_root: { openai_base_url: "https://api.openai.com/v1", model_catalog_json: null } }));
  let smokeSawMigrated = false;
  await prepare({ ...legacy.common, legacyManifestPath }, { smokeCheck: async ({ preparedHome }) => {
    const text = await readFile(path.join(preparedHome, "config.toml"), "utf8");
    smokeSawMigrated = !text.includes("sol-luna-native-gateway begin") && text.includes('openai_base_url = "https://api.openai.com/v1"')
      && text.includes(JSON.stringify(path.join(preparedHome, "models_cache.json")));
    return { status: smokeSawMigrated ? "passed" : "failed" };
  } });
  equal(smokeSawMigrated, true, "legacy smoke fixture migrates prior root settings and uses a temporary local main catalog");

  const startFailure = await fixture("task-start-failure");
  await prepare(startFailure.common);
  await rejects(() => startFailure.activateFixture({}, {
    ensureGateway: async (request) => {
      await startFailure.common.ensureGateway(request);
      throw new Error("gateway health failure after task start");
    },
  }), /gateway health failure after task start/i, "Task Scheduler gateway failure is surfaced without fallback");
  equal(startFailure.stopCalls.length, 1, "failed activation stops only the matching gateway started in this transaction");
  equal(startFailure.taskCalls.some(([operation]) => operation === "unregister"), true, "failed activation unregisters only its newly owned task");
  equal((await status({ journalPath: startFailure.journalPath })).phase, "activation_failed", "successfully recovered task startup failure is recorded as clean activation failure");

  const taskReject = await fixture("task-reject");
  await prepare(taskReject.common);
  const rejectedTaskAdapter = { ...taskReject.taskAdapter, async start() { throw new Error("Task Scheduler rejected start"); } };
  await rejects(() => taskReject.activateFixture({ taskAdapter: rejectedTaskAdapter }), /Task Scheduler rejected start/i, "a definite Task Scheduler start rejection is surfaced");
  equal((await status({ journalPath: taskReject.journalPath })).phase, "activation_failed", "a rejected start with no process state is a cleanly recovered failure");
  equal(taskReject.taskCalls.some(([operation]) => operation === "unregister"), true, "a definite start rejection removes only the newly owned task");

  const uncertainStart = await fixture("uncertain-task-start");
  await prepare(uncertainStart.common);
  await rejects(() => uncertainStart.activateFixture({}, { gatewayHealth: async () => ({ reachable: false, pid: null }) }), (error) => {
    const messages = [];
    const collect = (item) => { messages.push(item?.message ?? String(item)); for (const nested of item?.errors ?? []) collect(nested); };
    collect(error);
    return messages.some((message) => /health PID could not be verified/i.test(message));
  }, "an unhealthy post-start gateway is surfaced");
  const uncertainStartStatus = await status({ journalPath: uncertainStart.journalPath });
  equal(uncertainStartStatus.phase, "activation_recovery_failed", "an accepted but unverified task start is not called a clean rollback");
  equal(uncertainStartStatus.indeterminateStages.includes("gateway"), true, "uncertain gateway startup is explicitly recorded");
  equal(uncertainStart.taskCalls.some(([operation]) => operation === "unregister"), false, "uncertain gateway startup retains its task for manual recovery");
  ok(await readFile(path.join(uncertainStart.gatewayDir, "gateway-task.vbs")).catch(() => null), "uncertain gateway startup retains its launcher");
  equal(await readFile(path.join(uncertainStart.codexHome, "config.toml"), "utf8"), 'model = "gpt-current"\n', "uncertain gateway startup does not alter the user's config files");
  equal(uncertainStart.startup.size, 1, "uncertain gateway startup preserves the previous Startup entry");

  const success = await fixture("success");
  await prepare(success.common);
  const activated = await success.activateFixture();
  equal(activated.phase, "active", "activation reports completion only after all stages");
  equal(activated.restartNeeded, true, "configuration requires a desktop restart before runtime use can be observed");
  equal(activated.desktopAccepted, false, "configuration does not claim desktop acceptance");
  equal(success.environment.get("PATH").value, "keep", "activation preserves unrelated environment values");
  equal(success.startup.size, 0, "activation removes the older managed Startup VBS after gateway health");
  const configPath = path.join(success.codexHome, "config.toml");
  const activatedConfig = await readFile(configPath);
  const changedMainConfig = activatedConfig.toString("utf8").replace('model = "gpt-current"', 'model = "new-sol-model"');
  await writeFile(configPath, changedMainConfig);
  const dispatch = await ensureNativeDeepseekDispatch({ journalPath: success.journalPath, envAdapter: success.envAdapter, taskAdapter: success.taskAdapter }, {
    ensureGateway: success.common.ensureGateway,
    readGatewayIdentity,
    gatewayHealth: async (value) => ({ reachable: true, pid: value.pid }),
  });
  equal(dispatch.ready, true, "DeepSeek dispatch gate confirms configured files, owned task and healthy isolated gateway");
  equal((await readFile(configPath, "utf8")).includes('model = "new-sol-model"'), true, "dispatch permits a later user-selected main model without freezing the parent catalog");
  const editedProviderConfig = changedMainConfig.replace('wire_api = "responses"', 'wire_api = "chat_completions"');
  await writeFile(configPath, editedProviderConfig);
  const ensureBeforeMissingTask = success.ensureCalls.length;
  await rejects(() => ensureNativeDeepseekDispatch({ journalPath: success.journalPath, envAdapter: success.envAdapter, taskAdapter: success.taskAdapter }, {
    ensureGateway: success.common.ensureGateway, readGatewayIdentity, gatewayHealth: async (value) => ({ reachable: true, pid: value.pid }),
  }), /provider or role block changed/i, "dispatch rejects edits to the isolated provider wiring");
  equal(success.ensureCalls.length, ensureBeforeMissingTask, "edited provider wiring is rejected before task launch");
  await writeFile(configPath, activatedConfig);
  await rejects(() => ensureNativeDeepseekDispatch({ journalPath: success.journalPath, envAdapter: success.envAdapter, taskAdapter: { ...success.taskAdapter, async status() { return { exists: false, owned: false, specMatches: false, enabled: false }; } } }, {
    ensureGateway: success.common.ensureGateway, readGatewayIdentity, gatewayHealth: async () => ({ reachable: true }),
  }), /task is missing, changed, or disabled/i, "dispatch gate fails closed without registering or falling back when task is missing");
  equal(success.ensureCalls.length, ensureBeforeMissingTask, "missing task is rejected before any direct gateway launch or health request");
  await success.rollbackFixture();
  equal(await readFile(path.join(success.codexHome, "config.toml"), "utf8"), 'model = "gpt-current"\n', "rollback restores original config bytes");
  equal(success.environment.get("CODEX_CLI_PATH").present, false, "rollback restores original environment state");
  equal(success.startup.size, 1, "rollback restores the previously managed Startup VBS snapshot");
  equal(success.stopCalls.length, 1, "rollback stops only the gateway started by this transaction after identity health verification");

  const changedAfterActivation = await fixture("later-edit");
  await prepare(changedAfterActivation.common);
  await changedAfterActivation.activateFixture();
  await writeFile(path.join(changedAfterActivation.codexHome, "config.toml"), "later user config\n");
  await rejects(() => changedAfterActivation.rollbackFixture(), /file changed since activation/i, "rollback refuses later file edits before changing other owned state");
  equal(changedAfterActivation.environment.get("SOL_LUNA_NATIVE_PLAINTEXT_V2").value, "1", "rollback preflight preserves environment when a file changed later");

  const stale = await fixture("stale");
  await prepare(stale.common);
  await writeFile(path.join(stale.codexHome, "config.toml"), "user later edit\n");
  await rejects(() => stale.activateFixture(), /file changed since plan/i, "activation rejects a changed managed file");
  equal(await readFile(path.join(stale.codexHome, "config.toml"), "utf8"), "user later edit\n", "stale activation preserves user file edit");

  const envStale = await fixture("env-stale");
  await prepare(envStale.common);
  envStale.environment.set("CODEX_CLI_PATH", { present: true, value: "user-new.exe" });
  await rejects(() => envStale.activateFixture(), /environment changed since plan/i, "activation rejects an environment edit after prepare");
  equal(envStale.environment.get("CODEX_CLI_PATH").value, "user-new.exe", "stale activation preserves user's environment edit");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`PASS ${checks} native isolated installer assertions`);
