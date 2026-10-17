import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NATIVE_RUNTIME_PATCH_SHA256, NATIVE_RUNTIME_SOURCE_COMMIT, NATIVE_RUNTIME_TARGET, NATIVE_RUNTIME_VERSION } from "../scripts/native-runtime.mjs";
import { gatewayPaths } from "../scripts/native-gateway-manager.mjs";
import { activate, decodeJournal, encodeJournal, prepare, rollback, status } from "../scripts/native-isolated-install.mjs";

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
  const startup = new Map();
  const autostartAdapter = {
    async get(file) { const bytes = startup.get(file); return bytes ? Buffer.from(bytes) : null; },
    async set(file, bytes) { if (bytes === null) startup.delete(file); else startup.set(file, Buffer.from(bytes)); },
  };
  const state = { pid: 12345, port: 43127, token: "fixture-secret-token" };
  const ensureCalls = [];
  const ensureGateway = async ({ paths }) => { ensureCalls.push(paths); return { state, started: true }; };
  const stopCalls = [];
  const stopGateway = async ({ paths, expected }) => { stopCalls.push({ paths, expected }); };
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
  const common = { versionDir, codexHome, gatewayDir, startupDir, journalPath, expectedMainModel: "gpt-current", expectedMainProvider: null, expectedRootBaseUrl: null, envAdapter, autostartAdapter, ensureGateway, stopGateway, smokeCheck };
  return { dir, versionDir, codexHome, gatewayDir, startupDir, journalPath, environment, envAdapter, startup, autostartAdapter, state, ensureCalls, stopCalls, common };
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
  if (process.platform === "win32") {
    const upperDefault = gatewayPaths().dir.toUpperCase();
    await rejects(() => prepare({ ...missingSmoke.common, gatewayDir: upperDefault, smokeCheck: () => ({ status: "passed" }) }), /separate from the legacy\/default gateway directory/i, "Windows case-only path alias cannot target the old gateway directory");
  }

  const f = await fixture("startup-failure");
  const prepared = await prepare(f.common);
  equal(f.ensureCalls[0].dir, path.resolve(f.gatewayDir), "prepare uses the explicitly isolated gateway directory");
  const preparedText = JSON.stringify(prepared);
  equal(preparedText.includes(f.state.token), false, "prepare output does not expose gateway token");
  equal(preparedText.includes("model_provider"), false, "prepare output does not expose full config content");
  if (process.platform !== "win32") equal((await lstat(f.journalPath)).mode & 0o777, 0o600, "journal is created with private permissions");
  const before = await status({ journalPath: f.journalPath });
  equal(before.phase, "prepared", "status reports prepared before activation");
  equal(before.configured, false, "prepared journal is not reported configured");
  equal(before.runtimeObserved, false, "prepared journal makes no runtime observation");
  const failingAutostart = { ...f.autostartAdapter, async set() { throw new Error("startup write failed"); } };
  await rejects(() => activate({ journalPath: f.journalPath, envAdapter: f.envAdapter, autostartAdapter: failingAutostart }), /startup write failed/i, "startup failure is surfaced after earlier stages");
  equal(await readFile(path.join(f.codexHome, "config.toml"), "utf8"), 'model = "gpt-current"\n', "startup failure rolls back files");
  equal(f.environment.get("CODEX_CLI_PATH").present, false, "startup failure rolls back environment");
  equal((await status({ journalPath: f.journalPath })).configured, false, "failed activation is not reported configured");

  const envFailure = await fixture("environment-failure");
  await prepare(envFailure.common);
  const failingEnv = {
    ...envFailure.envAdapter,
    async set(key, value) {
      if (key === "SOL_LUNA_NATIVE_PLAINTEXT_V2") throw new Error("environment setter failed");
      return envFailure.envAdapter.set(key, value);
    },
  };
  await rejects(() => activate({ journalPath: envFailure.journalPath, envAdapter: failingEnv, autostartAdapter: envFailure.autostartAdapter }), /environment setter failed/i, "environment failure is surfaced");
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
  await rejects(() => activate({ journalPath: uncertainEnv.journalPath, envAdapter: indeterminateEnv, autostartAdapter: uncertainEnv.autostartAdapter }), (error) => {
    const details = [error.message, ...(error.errors ?? []).map((item) => item.message)].join(" | ");
    return /primary environment mutation failure/i.test(details) && /environment restore failure/i.test(details);
  }, "failed internal environment recovery is reported with both errors");
  const uncertainStatus = await status({ journalPath: uncertainEnv.journalPath });
  equal(uncertainStatus.phase, "activation_recovery_failed", "internal recovery failure is not mislabeled clean failure");
  equal(uncertainStatus.indeterminateStages.includes("environment"), true, "status names the stage whose state is uncertain");
  await rejects(() => rollback({ journalPath: uncertainEnv.journalPath, envAdapter: uncertainEnv.envAdapter, autostartAdapter: uncertainEnv.autostartAdapter }), /indeterminate stages requiring manual recovery/i, "rollback refuses to guess at an indeterminate stage");

  const failedSmoke = await fixture("failed-smoke");
  let cleanupCalls = 0;
  await rejects(() => prepare({ ...failedSmoke.common, smokeCheck: async () => ({ status: "failed", checks: [] }), readGatewayState: async () => failedSmoke.state, stopGateway: async ({ paths }) => { equal(paths.dir, path.resolve(failedSmoke.gatewayDir), "cleanup targets only isolated gateway directory"); cleanupCalls += 1; } }), /status=passed/i, "failed smoke prevents a journal and activation");
  equal(cleanupCalls, 1, "failed smoke cleans up only the gateway started by this prepare call");
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

  const success = await fixture("success");
  await prepare(success.common);
  const activated = await activate({ journalPath: success.journalPath, envAdapter: success.envAdapter, autostartAdapter: success.autostartAdapter });
  equal(activated.phase, "active", "activation reports completion only after all stages");
  equal(activated.restartNeeded, true, "configuration requires a desktop restart before runtime use can be observed");
  equal(activated.desktopAccepted, false, "configuration does not claim desktop acceptance");
  equal(success.environment.get("PATH").value, "keep", "activation preserves unrelated environment values");
  const installedStartup = [...success.startup.values()][0].toString("utf8");
  ok(installedStartup.includes(path.resolve(success.gatewayDir)), "autostart points to the isolated gateway directory");
  await rollback({ journalPath: success.journalPath, envAdapter: success.envAdapter, autostartAdapter: success.autostartAdapter });
  equal(await readFile(path.join(success.codexHome, "config.toml"), "utf8"), 'model = "gpt-current"\n', "rollback restores original config bytes");
  equal(success.environment.get("CODEX_CLI_PATH").present, false, "rollback restores original environment state");
  equal(success.startup.size, 0, "rollback removes the transaction-owned autostart file");

  const changedAfterActivation = await fixture("later-edit");
  await prepare(changedAfterActivation.common);
  await activate({ journalPath: changedAfterActivation.journalPath, envAdapter: changedAfterActivation.envAdapter, autostartAdapter: changedAfterActivation.autostartAdapter });
  await writeFile(path.join(changedAfterActivation.codexHome, "config.toml"), "later user config\n");
  await rejects(() => rollback({ journalPath: changedAfterActivation.journalPath, envAdapter: changedAfterActivation.envAdapter, autostartAdapter: changedAfterActivation.autostartAdapter }), /file changed since activation/i, "rollback refuses later file edits before changing other owned state");
  equal(changedAfterActivation.environment.get("SOL_LUNA_NATIVE_PLAINTEXT_V2").value, "1", "rollback preflight preserves environment when a file changed later");

  const stale = await fixture("stale");
  await prepare(stale.common);
  await writeFile(path.join(stale.codexHome, "config.toml"), "user later edit\n");
  await rejects(() => activate({ journalPath: stale.journalPath, envAdapter: stale.envAdapter, autostartAdapter: stale.autostartAdapter }), /changed since plan/i, "activation rejects a changed managed file");
  equal(await readFile(path.join(stale.codexHome, "config.toml"), "utf8"), "user later edit\n", "stale activation preserves user file edit");

  const envStale = await fixture("env-stale");
  await prepare(envStale.common);
  envStale.environment.set("CODEX_CLI_PATH", { present: true, value: "user-new.exe" });
  await rejects(() => activate({ journalPath: envStale.journalPath, envAdapter: envStale.envAdapter, autostartAdapter: envStale.autostartAdapter }), /environment changed since plan/i, "activation rejects an environment edit after prepare");
  equal(envStale.environment.get("CODEX_CLI_PATH").value, "user-new.exe", "stale activation preserves user's environment edit");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`PASS ${checks} native isolated installer assertions`);
