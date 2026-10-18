import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApiProfile, readRouterSettingsSnapshot, saveRouterSettings } from "../scripts/native-api-settings.mjs";
import {
  activate,
  inspectNativeApiDispatchState,
  nativeApiPaths,
  prepare,
  rollback,
  status,
} from "../scripts/native-api-install.mjs";

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const rejects = async (fn, pattern, message) => { await assert.rejects(fn, pattern, message); checks += 1; };

function fakeTaskAdapter() {
  let record = { exists: false, owned: false, specMatches: true, enabled: false, state: "Missing" };
  let starts = 0;
  let registers = 0;
  return {
    get starts() { return starts; },
    get registers() { return registers; },
    async status() { return { ...record }; },
    async register() {
      registers += 1;
      record = { exists: true, owned: true, specMatches: true, enabled: true, state: "Ready" };
    },
    async start() { starts += 1; record.state = "Running"; return { started: true }; },
    async unregister() {
      record = { exists: false, owned: false, specMatches: true, enabled: false, state: "Missing" };
      return { removed: true };
    },
  };
}

const definitionA = {
  protocol: "responses",
  baseUrl: "https://api.example.invalid/v1",
  model: "exact/model-a",
  reasoning: { supported: ["low", "high"], default: "high", parameter: "reasoning_effort" },
  credential: { type: "env", name: "API_A_KEY" },
};
const definitionB = {
  protocol: "chat_completions",
  baseUrl: "https://api.example.invalid/v1",
  model: "exact/model-b",
  reasoning: { supported: ["medium"], default: "medium", parameter: "reasoning_effort" },
  credential: { type: "env", name: "API_B_KEY" },
  contextWindow: 8_192,
};

const root = await mkdtemp(path.join(os.tmpdir(), "native-api-install-"));
try {
  const apiDir = path.join(root, "native-api");
  const codexHome = path.join(root, "codex-home");
  const paths = nativeApiPaths(apiDir);
  const settings = {
    schemaVersion: 1,
    mode: "fixed",
    fixedExecutor: null,
    profiles: {},
  };
  const profileA = createApiProfile(definitionA, { label: "A" });
  const profileB = createApiProfile(definitionB, { label: "B" });
  settings.profiles[profileA.profileId] = profileA;
  settings.profiles[profileB.profileId] = profileB;
  settings.fixedExecutor = profileA.profileId;
  await mkdir(codexHome, { recursive: true });
  await mkdir(path.join(codexHome, "agents"), { recursive: true });
  await saveRouterSettings(paths.settings, settings);
  const priorConfig = [
    'model = "gpt-6.1-sol"',
    'model_provider = "openai"',
    "",
    "[model_providers.deepseek-native]",
    'base_url = "http://127.0.0.1:1/token/v1"',
    "",
    "[foreign]",
    'value = "preserve"',
    "",
  ].join("\n");
  await writeFile(path.join(codexHome, "config.toml"), priorConfig, "utf8");
  const gatewayScript = path.join(root, "native-api-serve.mjs");
  await writeFile(gatewayScript, "// fixture\n", "utf8");
  const tasks = fakeTaskAdapter();
  const identity = { version: 1, token: "test-token-1234567890", port: 46_123 };
  const dependencies = {
    verifyRuntimeVersion: async () => ({ exePath: path.join(root, "codex.exe") }),
    prepareGatewayIdentity: async ({ paths: servicePaths }) => {
      await mkdir(servicePaths.dir, { recursive: true });
      await writeFile(servicePaths.identity, `${JSON.stringify(identity)}\n`, "utf8");
      return identity;
    },
    resolveApiCredential: async () => ({ headers: { authorization: "Bearer in-memory-only" } }),
    taskAdapter: tasks,
  };
  const journalA = paths.journal(profileA.profileId);
  const preparedA = await prepare({
    profileId: profileA.profileId,
    settingsPath: paths.settings,
    apiDir,
    codexHome,
    versionDir: path.join(root, "runtime"),
    journalPath: journalA,
    gatewayScriptPath: gatewayScript,
  }, dependencies);
  equal(preparedA.prepared, true, "prepare writes a transaction journal");
  equal((await readFile(path.join(codexHome, "config.toml"), "utf8")), priorConfig, "prepare does not change config");
  await rejects(() => prepare({
    profileId: profileA.profileId,
    settingsPath: paths.settings,
    apiDir,
    codexHome,
    versionDir: path.join(root, "runtime"),
    journalPath: journalA,
    gatewayScriptPath: gatewayScript,
  }, dependencies), /journal already exists/);

  const activatedA = await activate({ journalPath: journalA }, dependencies);
  equal(activatedA.activated, true, "activate commits the profile artifacts");
  equal(activatedA.restartNeeded, true, "new role installation requires a full restart");
  equal(tasks.registers, 1, "activation registers one owned API task");
  equal(tasks.starts, 0, "activation does not start an unused API service");
  const configA = await readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(configA, new RegExp(`\\[model_providers\\.api-native-${profileA.profileId}\\]`));
  assert.match(configA, /\[foreign\]/);
  assert.match(configA, /\[model_providers\.deepseek-native\]/);
  const roleA = await readFile(path.join(codexHome, "agents", `native_api_${profileA.profileId}.toml`), "utf8");
  assert.match(roleA, /unbounded_connection_retries = false/);
  assert.doesNotMatch(roleA, /API_A_KEY|in-memory-only/);
  checks += 1;
  const catalogA = JSON.parse(await readFile(path.join(codexHome, `sol-luna-native-models-${profileA.profileId}.json`), "utf8"));
  equal(catalogA.models.length, 1, "installed catalog contains exactly one model");
  equal(catalogA.models[0].slug, profileA.model, "installed catalog uses the exact model");
  equal((await status({ journalPath: journalA })).phase, "active", "status reports the activated phase");

  const inspected = await inspectNativeApiDispatchState({
    profileId: profileA.profileId,
    apiDir,
    settingsPath: paths.settings,
    taskAdapter: tasks,
  }, dependencies);
  equal(inspected.ready, true, "static dispatch gate accepts complete owned artifacts");

  const journalB = paths.journal(profileB.profileId);
  await prepare({
    profileId: profileB.profileId,
    settingsPath: paths.settings,
    apiDir,
    codexHome,
    versionDir: path.join(root, "runtime"),
    journalPath: journalB,
    gatewayScriptPath: gatewayScript,
  }, dependencies);
  await activate({ journalPath: journalB }, dependencies);
  const configAB = await readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(configAB, new RegExp(`api-native-${profileB.profileId}`));
  equal(tasks.registers, 1, "adding a second profile reuses the owned API task");
  const rolledBackB = await rollback({ journalPath: journalB }, dependencies);
  equal(rolledBackB.remainingProfiles.includes(profileA.profileId), true, "rolling back B preserves A");
  await rejectMissing(path.join(codexHome, "agents", `native_api_${profileB.profileId}.toml`), "B role is removed");
  ok((await readFile(path.join(codexHome, "agents", `native_api_${profileA.profileId}.toml`), "utf8")).includes("unbounded_connection_retries"), "A role remains installed");
  const configAfterB = await readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(configAfterB, new RegExp(`api-native-${profileA.profileId}`));
  assert.doesNotMatch(configAfterB, new RegExp(`api-native-${profileB.profileId}`));
  assert.match(configAfterB, /\[foreign\]/);
  checks += 1;
  equal((await status({ journalPath: journalA })).phase, "active", "old profile journal stays active");
  const rolledBackA = await rollback({ journalPath: journalA }, dependencies);
  equal(rolledBackA.remainingProfiles.length, 0, "rolling back the last profile leaves no API selection");
  const finalConfig = await readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.doesNotMatch(finalConfig, /sol-luna-native-api/);
  assert.match(finalConfig, /\[foreign\]/);
  assert.match(finalConfig, /\[model_providers\.deepseek-native\]/);
  equal((await tasks.status()).exists, false, "rolling back the last profile unregisters the owned task");
  checks += 2;

  // A failed activation must restore config, role, catalog, registry, and task.
  const profileC = createApiProfile({ ...definitionA, model: "exact/model-c" });
  settings.profiles[profileC.profileId] = profileC;
  const settingsSnapshot = await readRouterSettingsSnapshot(paths.settings);
  await saveRouterSettings(paths.settings, settings, { expectedSha256: settingsSnapshot.sha256 });
  const failingTasks = fakeTaskAdapter();
  failingTasks.register = async () => { throw new Error("simulated task registration failure"); };
  const journalC = paths.journal(profileC.profileId);
  await prepare({
    profileId: profileC.profileId,
    settingsPath: paths.settings,
    apiDir,
    codexHome,
    versionDir: path.join(root, "runtime"),
    journalPath: journalC,
    gatewayScriptPath: gatewayScript,
  }, { ...dependencies, taskAdapter: failingTasks });
  const beforeFailure = await readFile(path.join(codexHome, "config.toml"), "utf8");
  await rejects(() => activate({ journalPath: journalC }, { ...dependencies, taskAdapter: failingTasks }), /simulated task registration failure/);
  equal(await readFile(path.join(codexHome, "config.toml"), "utf8"), beforeFailure, "failed activation restores config");
  await rejectMissing(path.join(codexHome, "agents", `native_api_${profileC.profileId}.toml`), "failed activation removes the new role");

  const foreignHome = path.join(root, "foreign-home");
  await mkdir(path.join(foreignHome, "agents"), { recursive: true });
  await writeFile(path.join(foreignHome, "config.toml"), priorConfig, "utf8");
  await writeFile(path.join(foreignHome, "agents", `native_api_${profileC.profileId}.toml`), "user-owned role\n", "utf8");
  await rejects(() => prepare({
    profileId: profileC.profileId,
    settingsPath: paths.settings,
    apiDir: path.join(root, "foreign-api"),
    codexHome: foreignHome,
    versionDir: path.join(root, "runtime"),
    journalPath: path.join(root, "foreign-api", "journal.json"),
    gatewayScriptPath: gatewayScript,
  }, dependencies), /unowned native API role/);

  console.log(`PASS ${checks} native API install assertions`);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function rejectMissing(file, message) {
  await assert.rejects(readFile(file, "utf8"), /ENOENT/, message);
  checks += 1;
}
