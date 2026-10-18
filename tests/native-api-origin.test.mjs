import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApiProfile, saveRouterSettings } from "../scripts/native-api-settings.mjs";
import { activate, nativeApiPaths, prepare, rollback } from "../scripts/native-api-install.mjs";

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };

function fakeTaskAdapter() {
  let record = { exists: false, owned: false, specMatches: true, enabled: false, state: "Missing" };
  return {
    async status() { return { ...record }; },
    async register() { record = { exists: true, owned: true, specMatches: true, enabled: true, state: "Ready" }; },
    async start() { record.state = "Running"; return { started: true }; },
    async unregister() { record = { exists: false, owned: false, specMatches: true, enabled: false, state: "Missing" }; return { removed: true }; },
  };
}

const definition = {
  protocol: "responses",
  baseUrl: "https://api.example.invalid/v1",
  reasoning: { supported: ["none"], default: "none", parameter: "none" },
  credential: { type: "env", name: "API_KEY" },
};

async function fixture(label) {
  const root = path.join(await mkdtemp(path.join(os.tmpdir(), `native-api-origin-${label}-`)));
  const apiDir = path.join(root, "native-api");
  const codexHome = path.join(root, "codex-home");
  const paths = nativeApiPaths(apiDir);
  const a = createApiProfile({ ...definition, model: "model-a" });
  const b = createApiProfile({ ...definition, model: "model-b" });
  const settings = { schemaVersion: 1, mode: "fixed", fixedExecutor: a.profileId, profiles: { [a.profileId]: a, [b.profileId]: b } };
  await mkdir(path.join(codexHome, "agents"), { recursive: true });
  await writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-6.1-sol"\nmodel_provider = "openai"\n');
  await saveRouterSettings(paths.settings, settings);
  const script = path.join(root, "native-api-serve.mjs");
  await writeFile(script, "// fixture\n");
  const tasks = fakeTaskAdapter();
  const identity = { version: 1, token: "origin-token-1234567890", port: 46_124 };
  const dependencies = {
    verifyRuntimeVersion: async () => ({ exePath: path.join(root, "codex.exe") }),
    prepareGatewayIdentity: async ({ paths: service }) => {
      await mkdir(service.dir, { recursive: true });
      await writeFile(service.identity, `${JSON.stringify(identity)}\n`);
      return identity;
    },
    resolveApiCredential: async () => ({ headers: { authorization: "Bearer fixture" } }),
    taskAdapter: tasks,
  };
  return { root, apiDir, codexHome, paths, a, b, settings, script, tasks, dependencies };
}

async function install(f, profile) {
  const journal = f.paths.journal(profile.profileId);
  await prepare({
    profileId: profile.profileId,
    settingsPath: f.paths.settings,
    apiDir: f.apiDir,
    codexHome: f.codexHome,
    versionDir: path.join(f.root, "runtime"),
    journalPath: journal,
    gatewayScriptPath: f.script,
  }, f.dependencies);
  await activate({ journalPath: journal }, f.dependencies);
  return journal;
}

const roots = [];
try {
  for (const order of ["AB", "BA"]) {
    const f = await fixture(order);
    roots.push(f.root);
    const first = order === "AB" ? f.a : f.b;
    const second = order === "AB" ? f.b : f.a;
    const firstJournal = await install(f, first);
    const secondJournal = await install(f, second);
    await rollback({ journalPath: order === "AB" ? firstJournal : secondJournal }, f.dependencies);
    await rollback({ journalPath: order === "AB" ? secondJournal : firstJournal }, f.dependencies);
    equal((await f.tasks.status()).exists, false, `${order}: final rollback leaves no API task`);
    await assert.rejects(readFile(path.join(f.paths.service.dir, "api-task.vbs")), /ENOENT/);
    await assert.rejects(readFile(f.paths.gatewayOrigin), /ENOENT/);
    checks += 2;
  }

  const foreign = await fixture("foreign");
  roots.push(foreign.root);
  await mkdir(foreign.paths.service.dir, { recursive: true });
  await writeFile(path.join(foreign.paths.service.dir, "api-task.vbs"), "unowned launcher");
  await assert.rejects(prepare({
    profileId: foreign.a.profileId,
    settingsPath: foreign.paths.settings,
    apiDir: foreign.apiDir,
    codexHome: foreign.codexHome,
    versionDir: path.join(foreign.root, "runtime"),
    journalPath: foreign.paths.journal(foreign.a.profileId),
    gatewayScriptPath: foreign.script,
  }, foreign.dependencies), /unowned native API task launcher/);
  checks += 1;

  const conflict = await fixture("settings");
  roots.push(conflict.root);
  await install(conflict, conflict.a);
  const otherSettings = path.join(conflict.root, "other-router.json");
  await saveRouterSettings(otherSettings, conflict.settings);
  await assert.rejects(prepare({
    profileId: conflict.b.profileId,
    settingsPath: otherSettings,
    apiDir: conflict.apiDir,
    codexHome: conflict.codexHome,
    versionDir: path.join(conflict.root, "runtime"),
    journalPath: conflict.paths.journal(conflict.b.profileId),
    gatewayScriptPath: conflict.script,
  }, conflict.dependencies), /task plan differs from the shared gateway origin/);
  checks += 1;
  console.log(`PASS ${checks} native API shared origin assertions`);
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true });
}
