import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_RUNTIME_PATCH_SHA256, NATIVE_RUNTIME_SOURCE_COMMIT, NATIVE_RUNTIME_TARGET, NATIVE_RUNTIME_VERSION } from "../scripts/native-runtime.mjs";
import { gatewayPaths, readGatewayIdentity } from "../scripts/native-gateway-manager.mjs";
import { autostartFile, autostartScript } from "../scripts/native-autostart.mjs";
import * as installModule from "../scripts/native-isolated-install.mjs";
const { activate, decodeJournal, encodeJournal, ensureNativeDeepseekDispatch, prepare, rollback, status } = installModule;

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
  const environment = new Map([["CODEX_CLI_PATH", { present: false, value: null }], ["SOL_LUNA_NATIVE_PLAINTEXT_V2", { present: false, value: null }], ["SOL_LUNA_NATIVE_INSTALL_JOURNAL", { present: false, value: null }], ["PATH", { present: true, value: "keep" }]]);
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
  const activateFixture = (options = {}, dependencies = {}) => activate({ journalPath, envAdapter, autostartAdapter, taskAdapter, ...options }, { ensureGateway, gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }), stopGateway, ...dependencies });
  const rollbackFixture = (options = {}) => rollback({ journalPath, envAdapter, autostartAdapter, taskAdapter, ...options }, {
    gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }), stopGateway,
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
    failedJournalSet: false,
    async set(key, value) {
      if (key === "SOL_LUNA_NATIVE_INSTALL_JOURNAL" && !this.failedJournalSet) {
        this.failedJournalSet = true;
        await envFailure.envAdapter.set(key, value);
        throw new Error("journal environment setter failed after mutation");
      }
      return envFailure.envAdapter.set(key, value);
    },
  };
  await rejects(() => envFailure.activateFixture({ envAdapter: failingEnv }), /journal environment setter failed after mutation/i, "third-key environment failure is surfaced");
  equal(await readFile(path.join(envFailure.codexHome, "config.toml"), "utf8"), 'model = "gpt-current"\n', "environment failure rolls back previously applied files");
  equal(envFailure.environment.get("CODEX_CLI_PATH").present, false, "environment failure restores the first environment key");
  equal(envFailure.environment.get("SOL_LUNA_NATIVE_INSTALL_JOURNAL").present, false, "third-key environment failure restores journal path after mutation");

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

  const failedSmokeDetails = await fixture("failed-smoke-details");
  let smokeFailure;
  await assert.rejects(() => prepare({
    ...failedSmokeDetails.common,
    smokeCheck: async () => ({ status: "failed", stage: "model_list", failure: { stage: "model_list", code: -32602 }, checks: { app_server_closed: false } }),
  }, {
    removeSmokeFixture: async (fixtureHome, options) => {
      equal(options.maxRetries, 10, "smoke fixture removal has ten bounded retries");
      equal(options.retryDelay, 350, "smoke fixture removal uses the bounded retry delay");
      await rm(fixtureHome, { recursive: true, force: true });
    },
  }), (error) => {
    smokeFailure = error;
    return error.code === "ISOLATED_CONFIG_SMOKE_FAILED";
  }, "failed smoke preserves its structured safe diagnostic after successful cleanup");
  equal(smokeFailure.smoke.status, "failed", "failed smoke status is preserved");
  equal(smokeFailure.smoke.stage, "model_list", "failed smoke stage is preserved");
  equal(smokeFailure.smoke.failureStage, "model_list", "underlying smoke failure stage is preserved");
  equal(smokeFailure.smoke.failureCode, -32602, "underlying smoke failure code is preserved");
  equal(smokeFailure.smoke.appServerClosed, false, "critical app-server close check is preserved");
  equal(await readFile(failedSmokeDetails.journalPath).catch(() => null), null, "failed smoke with successful cleanup leaves no journal");

  const failedSmokeAndCleanup = await fixture("failed-smoke-cleanup-failure");
  let combinedSmokeFailure;
  await assert.rejects(() => prepare({
    ...failedSmokeAndCleanup.common,
    smokeCheck: async () => ({ status: "failed", stage: "config_read", failure: { stage: "config_read", code: "RPC_TIMEOUT" }, checks: { app_server_closed: false } }),
  }, {
    removeSmokeFixture: async () => { throw Object.assign(new Error("private capability must not leak"), { code: "EBUSY" }); },
  }), (error) => {
    combinedSmokeFailure = error;
    return error.code === "ISOLATED_CONFIG_PREPARE_FAILED";
  }, "smoke failure remains primary when temporary cleanup also fails");
  equal(combinedSmokeFailure.smoke.status, "failed", "cleanup failure retains smoke status");
  equal(combinedSmokeFailure.smoke.stage, "config_read", "cleanup failure retains smoke stage");
  equal(combinedSmokeFailure.smoke.failureCode, "RPC_TIMEOUT", "cleanup failure retains original smoke code");
  equal(combinedSmokeFailure.smoke.appServerClosed, false, "cleanup failure retains app-server close check");
  equal(combinedSmokeFailure.cleanupCode, "EBUSY", "cleanup error is reduced to its safe code");
  equal(combinedSmokeFailure.message.includes("private capability"), false, "cleanup diagnostic does not leak raw error text");
  equal(await readFile(failedSmokeAndCleanup.journalPath).catch(() => null), null, "smoke and cleanup failure leave no journal");
  equal(typeof installModule.formatInstallError, "function", "CLI catch exposes the same safe diagnostic formatter for testing");
  const formattedSmokeFailure = installModule.formatInstallError(combinedSmokeFailure);
  equal(formattedSmokeFailure.includes('"status":"failed"'), true, "CLI diagnostic includes smoke status");
  equal(formattedSmokeFailure.includes('"stage":"config_read"'), true, "CLI diagnostic includes smoke stage");
  equal(formattedSmokeFailure.includes('"failureCode":"RPC_TIMEOUT"'), true, "CLI diagnostic includes safe smoke failure code");
  equal(formattedSmokeFailure.includes('"appServerClosed":false'), true, "CLI diagnostic includes app-server close check");
  equal(formattedSmokeFailure.includes('"cleanupCode":"EBUSY"'), true, "CLI diagnostic includes safe cleanup code");
  equal(formattedSmokeFailure.includes("private capability"), false, "CLI diagnostic omits raw errors and secrets");
  const unsafeDiagnostic = installModule.formatInstallError(Object.assign(new Error("https://private.invalid/token SECRET"), {
    code: "ISOLATED_CONFIG_PREPARE_FAILED",
    primaryCode: "Bearer SECRET",
    cleanupCode: "https://private.invalid/token",
    smoke: { status: "failed", stage: "https://private.invalid/token", failureStage: "Authorization: SECRET", failureCode: "Bearer SECRET", appServerClosed: false },
  }));
  equal(unsafeDiagnostic.includes("private.invalid"), false, "CLI formatter omits URL values from diagnostic fields");
  equal(unsafeDiagnostic.includes("SECRET"), false, "CLI formatter omits token and header values from diagnostic fields");
  equal(unsafeDiagnostic.includes('"stage":"unknown"'), true, "CLI formatter constrains unknown stages to the fixed enum");
  equal(unsafeDiagnostic.includes('"failureCode":"UNKNOWN"'), true, "CLI formatter constrains unknown codes to safe values");
  equal(installModule.formatInstallError(new Error("legacy CLI error text")), "legacy CLI error text", "ordinary CLI errors retain their existing message output");

  const passedSmokeAndCleanup = await fixture("passed-smoke-cleanup-failure");
  let cleanupFailure;
  await assert.rejects(() => prepare({
    ...passedSmokeAndCleanup.common,
    smokeCheck: async () => ({ status: "passed", stage: "complete", checks: { app_server_closed: true } }),
  }, {
    removeSmokeFixture: async () => { throw Object.assign(new Error("private capability must not leak"), { code: "EBUSY" }); },
  }), (error) => {
    cleanupFailure = error;
    return error.code === "TEMP_SMOKE_CLEANUP_FAILED";
  }, "cleanup failure prevents prepare even when smoke passed");
  equal(cleanupFailure.cleanupCode, "EBUSY", "cleanup-only failure reports a safe error code");
  equal(cleanupFailure.smoke.status, "passed", "cleanup-only failure preserves successful smoke status");
  equal(cleanupFailure.smoke.stage, "complete", "cleanup-only failure preserves successful smoke stage");
  equal(cleanupFailure.smoke.appServerClosed, true, "cleanup-only failure preserves successful app-server close check");
  const formattedCleanupFailure = installModule.formatInstallError(cleanupFailure);
  equal(formattedCleanupFailure.includes('"status":"passed"'), true, "CLI diagnostic reports passed smoke before cleanup failure");
  equal(formattedCleanupFailure.includes('"appServerClosed":true'), true, "CLI diagnostic preserves successful close check");
  equal(cleanupFailure.message.includes("private capability"), false, "cleanup-only diagnostic does not leak raw error text");
  equal(await readFile(passedSmokeAndCleanup.journalPath).catch(() => null), null, "passed smoke with cleanup failure leaves no journal");

  if (process.platform === "win32") {
    const lockedFixture = await fixture("locked-smoke-cleanup");
    let lockChild;
    let lockChildExit;
    let lockedHome;
    try {
      const preparedWithLock = await prepare({
        ...lockedFixture.common,
        smokeCheck: async ({ preparedHome }) => {
          lockedHome = preparedHome;
          lockChild = spawn(process.execPath, [
            "-e",
            'process.chdir(process.argv[1]);process.stdout.write("ready\\n");setTimeout(()=>process.exit(0),1500)',
            preparedHome,
          ], { cwd: preparedHome, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
          lockChildExit = new Promise((resolve, reject) => {
            lockChild.once("error", reject);
            lockChild.once("exit", (code, signal) => resolve({ code, signal }));
          });
          await new Promise((resolve, reject) => {
            let output = "";
            lockChild.stdout.setEncoding("utf8");
            lockChild.stdout.on("data", (chunk) => {
              output += chunk;
              if (output.includes("ready\n")) resolve();
            });
            lockChild.once("error", reject);
            lockChild.once("exit", (code) => reject(new Error(`cwd lock child exited before ready (${code})`)));
          });
          return { status: "passed", stage: "complete", checks: { app_server_closed: true } };
        },
      });
      equal(preparedWithLock.phase, "prepared", "prepare waits for an owned Windows cwd lock to release before writing its journal");
      equal((await status({ journalPath: lockedFixture.journalPath })).phase, "prepared", "Windows cwd lock regression leaves a prepared journal");
      equal(await lstat(lockedHome).then(() => true, () => false), false, "Windows cwd lock fixture is removed after the child exits");
    } finally {
      if (lockChild) {
        const exit = await lockChildExit;
        equal(exit.code, 0, "owned Windows cwd lock child exits successfully");
      }
    }
  }

  const setupAndCleanupFailure = await fixture("setup-cleanup-failure");
  const setupFailureTaskAdapter = {
    ...setupAndCleanupFailure.taskAdapter,
    async status(plan) {
      const result = await setupAndCleanupFailure.taskAdapter.status(plan);
      await rm(path.join(setupAndCleanupFailure.codexHome, "models_cache.json"), { force: true });
      return result;
    },
  };
  let combinedSetupFailure;
  await assert.rejects(() => prepare({ ...setupAndCleanupFailure.common, taskAdapter: setupFailureTaskAdapter }, {
    removeSmokeFixture: async () => { throw Object.assign(new Error("private capability must not leak"), { code: "EBUSY" }); },
  }), (error) => {
    combinedSetupFailure = error;
    return error.code === "ISOLATED_CONFIG_PREPARE_FAILED";
  }, "cleanup failure retains an earlier setup error code");
  equal(combinedSetupFailure.primaryCode, "ENOENT", "cleanup failure retains safe pre-smoke error code");
  equal(combinedSetupFailure.cleanupCode, "EBUSY", "cleanup failure also retains cleanup code");
  equal(combinedSetupFailure.smoke, null, "pre-smoke failure does not fabricate smoke evidence");
  const formattedSetupFailure = installModule.formatInstallError(combinedSetupFailure);
  equal(formattedSetupFailure.includes('"primaryCode":"ENOENT"'), true, "CLI diagnostic includes safe pre-smoke code");
  equal(formattedSetupFailure.includes('"cleanupCode":"EBUSY"'), true, "CLI diagnostic includes cleanup code with pre-smoke error");
  equal(formattedSetupFailure.includes("private capability"), false, "CLI diagnostic omits raw pre-smoke and cleanup errors");
  equal(await readFile(setupAndCleanupFailure.journalPath).catch(() => null), null, "pre-smoke and cleanup failure leave no journal");

  const residualLegacy = await fixture("residual-legacy-without-marker");
  const residualConfigPath = path.join(residualLegacy.codexHome, "config.toml");
  const residualConfigBytes = Buffer.from('model = "gpt-current"\nmodel_provider = "openai"\n');
  await writeFile(residualConfigPath, residualConfigBytes);
  const residualAgent = path.join(residualLegacy.codexHome, "agents/native_deepseek.toml");
  const residualCatalog = path.join(residualLegacy.codexHome, "sol-luna-native-models.json");
  const residualAgentBytes = Buffer.from("legacy role bytes\n");
  const residualCatalogBytes = Buffer.from('{"legacy":true}\n');
  await writeFile(residualAgent, residualAgentBytes);
  await writeFile(residualCatalog, residualCatalogBytes);
  const residualManifestPath = path.join(residualLegacy.dir, "legacy-manifest.json");
  await writeFile(residualManifestPath, JSON.stringify({
    agent: residualAgent,
    catalog: residualCatalog,
    prior_root: { openai_base_url: null, model_catalog_json: null },
  }));
  await prepare({ ...residualLegacy.common, legacyManifestPath: residualManifestPath });
  const residualJournal = decodeJournal(await readFile(residualLegacy.journalPath, "utf8"));
  equal(residualJournal.files.legacyMigration, false, "residual old role/catalog without a config marker is not a config migration");
  await residualLegacy.activateFixture();
  const residualActiveConfig = await readFile(residualConfigPath, "utf8");
  equal(residualActiveConfig.includes('model = "gpt-current"'), true, "activation preserves the root main model");
  equal(/^openai_base_url\s*=/m.test(residualActiveConfig), false, "activation leaves no root base URL");
  equal(/^model_catalog_json\s*=/m.test(residualActiveConfig), false, "activation leaves no root catalog setting");
  await residualLegacy.rollbackFixture();
  equal((await readFile(residualConfigPath)).equals(residualConfigBytes), true, "rollback restores exact root config bytes");
  equal(residualLegacy.startup.size, 0, "successful rollback does not resurrect old managed Startup without a config marker");
  equal((await readFile(residualAgent)).equals(residualAgentBytes), true, "rollback restores manifest-owned legacy role bytes");
  equal((await readFile(residualCatalog)).equals(residualCatalogBytes), true, "rollback restores manifest-owned legacy catalog bytes");

  const noStartup = await fixture("no-prior-startup");
  noStartup.startup.clear();
  await prepare(noStartup.common);
  const noStartupJournal = decodeJournal(await readFile(noStartup.journalPath, "utf8"));
  equal(noStartupJournal.autostart.retiredLegacy, false, "absent Startup is not classified as a retired legacy file");
  await noStartup.activateFixture();
  await noStartup.rollbackFixture();
  equal(noStartup.startup.size, 0, "rollback does not create a Startup file when none existed");

  const unknownStartup = await fixture("unknown-prior-startup");
  const unknownStartupBytes = Buffer.from("user startup bytes\n");
  unknownStartup.startup.set(autostartFile(unknownStartup.startupDir), unknownStartupBytes);
  await rejects(() => prepare(unknownStartup.common), /unowned Startup VBS exists/i, "prepare refuses an unknown Startup file");
  equal(await readFile(unknownStartup.journalPath).catch(() => null), null, "unknown Startup refusal writes no journal");
  equal(unknownStartup.startup.get(autostartFile(unknownStartup.startupDir)).equals(unknownStartupBytes), true, "unknown Startup refusal preserves user bytes");

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

  const migratedRollback = await fixture("legacy-active-rollback");
  await writeFile(path.join(migratedRollback.codexHome, "config.toml"), legacyText);
  const migratedManifestPath = path.join(migratedRollback.dir, "legacy-manifest.json");
  await writeFile(migratedManifestPath, JSON.stringify({ prior_root: { openai_base_url: "https://api.openai.com/v1", model_catalog_json: null } }));
  await prepare({ ...migratedRollback.common, legacyManifestPath: migratedManifestPath });
  const migratedJournalBeforeActivation = decodeJournal(await readFile(migratedRollback.journalPath, "utf8"));
  ok(migratedJournalBeforeActivation.files.files["config.toml"].uninstallPrior?.exists, "journal serializes the distinct migrated uninstall target");
  equal(migratedJournalBeforeActivation.files.files["config.toml"].prior.bytes.toString("utf8"), legacyText, "journal retains exact legacy bytes for activation-failure recovery");
  equal(decodeJournal(encodeJournal(migratedJournalBeforeActivation)).files.files["config.toml"].uninstallPrior.bytes.toString("utf8").includes("sol-luna-native-gateway begin"), false,
    "journal roundtrip preserves the clean uninstall target without the retired gateway block");
  const oldJournalPath = path.join(migratedRollback.dir, "journal", "old-format.json");
  const oldJournal = { ...migratedJournalBeforeActivation, files: { ...migratedJournalBeforeActivation.files, files: { ...migratedJournalBeforeActivation.files.files } } };
  oldJournal.files.files["config.toml"] = { ...oldJournal.files.files["config.toml"] };
  delete oldJournal.files.files["config.toml"].uninstallPrior;
  delete oldJournal.files.legacyMigration;
  await mkdir(path.dirname(oldJournalPath), { recursive: true });
  await writeFile(oldJournalPath, encodeJournal(oldJournal));
  await rejects(() => rollback({ journalPath: oldJournalPath, envAdapter: migratedRollback.envAdapter, autostartAdapter: migratedRollback.autostartAdapter, taskAdapter: migratedRollback.taskAdapter }),
    /legacy migration uninstall target is missing/i, "an old migration journal without a clean uninstall target is refused before mutation");
  equal(migratedRollback.startup.size, 1, "old migration journal refusal leaves the managed Startup snapshot unchanged");
  await migratedRollback.activateFixture();
  await migratedRollback.rollbackFixture();
  const migratedAfterRollback = await readFile(path.join(migratedRollback.codexHome, "config.toml"), "utf8");
  equal(migratedAfterRollback.includes("sol-luna-native-gateway begin"), false, "active migration rollback does not revive the retired localhost block");
  equal(migratedAfterRollback.includes('openai_base_url = "https://api.openai.com/v1"'), true, "active migration rollback restores the manifest prior root");
  equal(migratedRollback.startup.size, 0, "active migration rollback does not restore retired managed Startup VBS");

  const migratedActivationFailure = await fixture("legacy-activation-failure");
  await writeFile(path.join(migratedActivationFailure.codexHome, "config.toml"), legacyText);
  const failedMigrationManifest = path.join(migratedActivationFailure.dir, "legacy-manifest.json");
  await writeFile(failedMigrationManifest, JSON.stringify({ prior_root: { openai_base_url: "https://api.openai.com/v1", model_catalog_json: null } }));
  await prepare({ ...migratedActivationFailure.common, legacyManifestPath: failedMigrationManifest });
  const failingMigrationEnv = {
    ...migratedActivationFailure.envAdapter,
    async set(key, value) {
      if (key === "SOL_LUNA_NATIVE_PLAINTEXT_V2") throw new Error("migration activation environment failure");
      return migratedActivationFailure.envAdapter.set(key, value);
    },
  };
  await rejects(() => migratedActivationFailure.activateFixture({ envAdapter: failingMigrationEnv }), /migration activation environment failure/i,
    "migration activation failure is surfaced after files and Startup were changed");
  equal(await readFile(path.join(migratedActivationFailure.codexHome, "config.toml"), "utf8"), legacyText,
    "failed migration activation restores the exact legacy config because the old gateway remains available");
  equal(migratedActivationFailure.startup.size, 1, "failed migration activation restores the previous managed Startup VBS");

  const migratedLaterEdit = await fixture("legacy-later-edit");
  await writeFile(path.join(migratedLaterEdit.codexHome, "config.toml"), legacyText);
  const laterEditManifest = path.join(migratedLaterEdit.dir, "legacy-manifest.json");
  await writeFile(laterEditManifest, JSON.stringify({ prior_root: { openai_base_url: "https://api.openai.com/v1", model_catalog_json: null } }));
  await prepare({ ...migratedLaterEdit.common, legacyManifestPath: laterEditManifest });
  await migratedLaterEdit.activateFixture();
  await writeFile(path.join(migratedLaterEdit.codexHome, "config.toml"), "later user edit\n");
  await rejects(() => migratedLaterEdit.rollbackFixture(), /file changed since activation/i, "migrated uninstall refuses to overwrite a later config edit");
  equal(migratedLaterEdit.environment.get("SOL_LUNA_NATIVE_PLAINTEXT_V2").value, "1", "migrated uninstall refusal preserves other active stages");

  const legacyUserLocalhost = await fixture("legacy-user-localhost-prior");
  await writeFile(path.join(legacyUserLocalhost.codexHome, "config.toml"), legacyText);
  const userLocalhostManifest = path.join(legacyUserLocalhost.dir, "legacy-manifest.json");
  const userLocalhostUrl = "http://127.0.0.1:59999/user-owned/v1";
  await writeFile(userLocalhostManifest, JSON.stringify({ prior_root: { openai_base_url: userLocalhostUrl, model_catalog_json: null } }));
  await prepare({ ...legacyUserLocalhost.common, legacyManifestPath: userLocalhostManifest });
  await legacyUserLocalhost.activateFixture();
  await legacyUserLocalhost.rollbackFixture();
  equal((await readFile(path.join(legacyUserLocalhost.codexHome, "config.toml"), "utf8")).includes(userLocalhostUrl), true,
    "active migration rollback preserves a user localhost URL already present in prior_root");

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

  const nonStrictActivation = await fixture("non-strict-activation");
  await prepare(nonStrictActivation.common);
  await rejects(() => nonStrictActivation.activateFixture({}, {
    gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: false, relay_allowed: true }),
  }), /does not enforce DeepSeek-only routing/i, "activation refuses a healthy gateway that permits GPT relay");
  equal((await status({ journalPath: nonStrictActivation.journalPath })).phase, "activation_failed", "a mismatched strict health response is recorded as failed activation");

  const readyActivation = await fixture("ready-task-activation");
  await prepare(readyActivation.common);
  const readyAdapter = {
    ...readyActivation.taskAdapter,
    async status(plan) { const result = await readyActivation.taskAdapter.status(plan); return { ...result, state: "Ready" }; },
  };
  await rejects(() => readyActivation.activateFixture({ taskAdapter: readyAdapter }), /Task Scheduler gateway task is not Running/i,
    "activation refuses a healthy gateway while the owned Task is only Ready");

  const success = await fixture("success");
  const preparedSuccess = await prepare(success.common);
  const preparedJournal = decodeJournal(await readFile(success.journalPath, "utf8"));
  equal(preparedJournal.environment.next.SOL_LUNA_NATIVE_INSTALL_JOURNAL?.value, path.resolve(success.journalPath), "prepare plans the exact resolved journal path");
  const activated = await success.activateFixture();
  equal(activated.phase, "active", "activation reports completion only after all stages");
  equal(activated.restartNeeded, true, "configuration requires a desktop restart before runtime use can be observed");
  equal(activated.desktopAccepted, false, "configuration does not claim desktop acceptance");
  equal(success.environment.get("PATH").value, "keep", "activation preserves unrelated environment values");
  equal(success.environment.get("SOL_LUNA_NATIVE_INSTALL_JOURNAL").value, path.resolve(success.journalPath), "activation publishes journal path for future chats");
  equal(success.startup.size, 0, "activation removes the older managed Startup VBS after gateway health");
  const configPath = path.join(success.codexHome, "config.toml");
  const activatedConfig = await readFile(configPath);
  const changedMainConfig = activatedConfig.toString("utf8").replace('model = "gpt-current"', 'model = "new-sol-model"');
  await writeFile(configPath, changedMainConfig);
  const dispatch = await ensureNativeDeepseekDispatch({ journalPath: success.journalPath, envAdapter: success.envAdapter, taskAdapter: success.taskAdapter }, {
    ensureGateway: success.common.ensureGateway,
    readGatewayIdentity,
    gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }),
  });
  equal(dispatch.ready, true, "DeepSeek dispatch gate confirms configured files, owned task and healthy isolated gateway");
  equal((await readFile(configPath, "utf8")).includes('model = "new-sol-model"'), true, "dispatch permits a later user-selected main model without freezing the parent catalog");
  success.environment.set("SOL_LUNA_NATIVE_INSTALL_JOURNAL", { present: true, value: "later-user-journal.json" });
  await rejects(() => ensureNativeDeepseekDispatch({ journalPath: success.journalPath, envAdapter: success.envAdapter, taskAdapter: success.taskAdapter }, {}), /environment changed.*SOL_LUNA_NATIVE_INSTALL_JOURNAL/i, "dispatch rejects journal environment drift");
  success.environment.set("SOL_LUNA_NATIVE_INSTALL_JOURNAL", { present: true, value: path.resolve(success.journalPath) });
  const stopsBeforeNonStrict = success.stopCalls.length;
  await rejects(() => ensureNativeDeepseekDispatch({ journalPath: success.journalPath, envAdapter: success.envAdapter, taskAdapter: success.taskAdapter }, {
    ensureGateway: async () => ({ state: { ...success.state, port: (await readGatewayIdentity(gatewayPaths(success.gatewayDir))).port, token: (await readGatewayIdentity(gatewayPaths(success.gatewayDir))).token }, started: false }),
    readGatewayIdentity,
    gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: false, relay_allowed: true }),
  }), /does not enforce DeepSeek-only routing/i, "a healthy legacy/direct gateway is refused for native dispatch");
  equal(success.stopCalls.length, stopsBeforeNonStrict, "dispatch refuses a non-strict gateway without stopping its PID");
  const readyTaskAdapter = { ...success.taskAdapter, async status() { return { exists: true, owned: true, specMatches: true, enabled: true, state: "Ready" }; } };
  await rejects(() => ensureNativeDeepseekDispatch({ journalPath: success.journalPath, envAdapter: success.envAdapter, taskAdapter: readyTaskAdapter }, {
    ensureGateway: async () => ({ state: { ...success.state, port: (await readGatewayIdentity(gatewayPaths(success.gatewayDir))).port, token: (await readGatewayIdentity(gatewayPaths(success.gatewayDir))).token }, started: false }),
    readGatewayIdentity,
    gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }),
  }), /Task Scheduler task is not Running/i, "a Ready task with an external healthy server is refused");
  const editedProviderConfig = changedMainConfig.replace('wire_api = "responses"', 'wire_api = "chat_completions"');
  await writeFile(configPath, editedProviderConfig);
  const ensureBeforeMissingTask = success.ensureCalls.length;
  await rejects(() => ensureNativeDeepseekDispatch({ journalPath: success.journalPath, envAdapter: success.envAdapter, taskAdapter: success.taskAdapter }, {
    ensureGateway: success.common.ensureGateway, readGatewayIdentity, gatewayHealth: async (value) => ({ reachable: true, pid: value.pid, deepseek_only: true, relay_allowed: false }),
  }), /provider or role block changed/i, "dispatch rejects edits to the isolated provider wiring");
  equal(success.ensureCalls.length, ensureBeforeMissingTask, "edited provider wiring is rejected before task launch");
  await writeFile(configPath, activatedConfig);
  await rejects(() => ensureNativeDeepseekDispatch({ journalPath: success.journalPath, envAdapter: success.envAdapter, taskAdapter: { ...success.taskAdapter, async status() { return { exists: false, owned: false, specMatches: false, enabled: false }; } } }, {
    ensureGateway: success.common.ensureGateway, readGatewayIdentity, gatewayHealth: async () => ({ reachable: true, deepseek_only: true, relay_allowed: false }),
  }), /task is missing, changed, or disabled/i, "dispatch gate fails closed without registering or falling back when task is missing");
  equal(success.ensureCalls.length, ensureBeforeMissingTask, "missing task is rejected before any direct gateway launch or health request");
  await success.rollbackFixture();
  equal(await readFile(path.join(success.codexHome, "config.toml"), "utf8"), 'model = "gpt-current"\n', "rollback restores original config bytes");
  equal(success.environment.get("CODEX_CLI_PATH").present, false, "rollback restores original environment state");
  equal(success.environment.get("SOL_LUNA_NATIVE_INSTALL_JOURNAL").present, false, "rollback restores original journal environment state");
  equal(success.startup.size, 0, "successful rollback does not restore the retired managed Startup VBS");
  equal(success.stopCalls.length, 1, "rollback stops only the gateway started by this transaction after identity health verification");

  const oldEnvironmentJournal = await fixture("old-two-key-environment-journal");
  oldEnvironmentJournal.environment.set("SOL_LUNA_NATIVE_INSTALL_JOURNAL", { present: true, value: "user-owned-journal.json" });
  await prepare(oldEnvironmentJournal.common);
  const oldEnvironmentJournalData = decodeJournal(await readFile(oldEnvironmentJournal.journalPath, "utf8"));
  delete oldEnvironmentJournalData.environment.prior.SOL_LUNA_NATIVE_INSTALL_JOURNAL;
  delete oldEnvironmentJournalData.environment.next.SOL_LUNA_NATIVE_INSTALL_JOURNAL;
  await writeFile(oldEnvironmentJournal.journalPath, encodeJournal(oldEnvironmentJournalData));
  let oldJournalKeyReads = 0;
  let oldJournalKeyWrites = 0;
  const oldTwoKeyAdapter = {
    async get(key) {
      if (key === "SOL_LUNA_NATIVE_INSTALL_JOURNAL") oldJournalKeyReads += 1;
      return oldEnvironmentJournal.envAdapter.get(key);
    },
    async set(key, value) {
      if (key === "SOL_LUNA_NATIVE_INSTALL_JOURNAL") oldJournalKeyWrites += 1;
      return oldEnvironmentJournal.envAdapter.set(key, value);
    },
  };
  oldJournalKeyReads = 0;
  await oldEnvironmentJournal.activateFixture({ envAdapter: oldTwoKeyAdapter });
  equal(oldJournalKeyReads, 0, "activating an old two-key journal never reads the new journal environment key");
  equal(oldJournalKeyWrites, 0, "activating an old two-key journal never writes the new journal environment key");
  equal(oldEnvironmentJournal.environment.get("SOL_LUNA_NATIVE_INSTALL_JOURNAL").value, "user-owned-journal.json", "old journal activation preserves the unrelated user journal value");
  oldJournalKeyReads = 0;
  oldJournalKeyWrites = 0;
  await oldEnvironmentJournal.rollbackFixture({ envAdapter: oldTwoKeyAdapter });
  equal(oldJournalKeyReads, 0, "rolling back an old two-key journal never reads the new journal environment key");
  equal(oldJournalKeyWrites, 0, "rolling back an old two-key journal never writes the new journal environment key");
  equal(oldEnvironmentJournal.environment.get("SOL_LUNA_NATIVE_INSTALL_JOURNAL").value, "user-owned-journal.json", "old journal rollback preserves the unrelated user journal value");

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
