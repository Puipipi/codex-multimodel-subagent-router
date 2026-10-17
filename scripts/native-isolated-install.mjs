import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apply as applyFiles, plan as planFiles, rollback as rollbackFiles } from "./native-isolated-files.mjs";
import { autostartFile, autostartScript } from "./native-autostart.mjs";
import { withTemporaryRootModelCatalog } from "./native-isolated-config.mjs";
import { runIsolatedConfigSmoke } from "./native-isolated-smoke.mjs";
import { ensureGateway, gatewayPaths, readGatewayState, stopGateway } from "./native-gateway-manager.mjs";
import { createWindowsUserEnvironmentAdapter, apply as applyEnvironment, plan as planEnvironment, rollback as rollbackEnvironment } from "./native-runtime-env.mjs";
import { verifyRuntimeVersion } from "./native-runtime.mjs";

const JOURNAL_VERSION = 1;

function encodeValue(value) {
  if (Buffer.isBuffer(value)) return { $native_buffer_base64: value.toString("base64") };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)]));
  return value;
}

function decodeValue(value) {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && typeof value.$native_buffer_base64 === "string") return Buffer.from(value.$native_buffer_base64, "base64");
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeValue(item)]));
  }
  return value;
}

export function encodeJournal(value) { return JSON.stringify(encodeValue(value), null, 2) + "\n"; }
export function decodeJournal(value) { return decodeValue(JSON.parse(value)); }

async function regularOrAbsent(file, label) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${file}`);
    return await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.native-install-${randomUUID()}.tmp`);
  let created = false;
  try {
    await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
    created = true;
    await rename(temp, file);
    created = false;
  } finally {
    if (created) await rm(temp, { force: true }).catch(() => {});
  }
}

async function defaultAutostartAdapter() {
  return {
    async get(file) { return regularOrAbsent(file, "autostart file"); },
    async set(file, bytes) {
      if (bytes === null) {
        const existing = await regularOrAbsent(file, "autostart file");
        if (existing !== null) await unlink(file);
      } else await atomicWrite(file, bytes);
    },
  };
}

async function readJournal(journalPath) {
  const bytes = await regularOrAbsent(path.resolve(journalPath), "install journal");
  if (bytes === null) throw new Error(`install journal is missing: ${path.resolve(journalPath)}`);
  const journal = decodeJournal(bytes.toString("utf8"));
  if (journal?.version !== JOURNAL_VERSION || !journal.paths || !journal.files || !journal.environment || !journal.autostart) {
    throw new Error("install journal has an unsupported or incomplete format");
  }
  return journal;
}

async function writeJournal(journalPath, journal) {
  await atomicWrite(path.resolve(journalPath), Buffer.from(encodeJournal(journal), "utf8"));
}

async function canonicalForCompare(value) {
  const resolved = path.resolve(value);
  try { return await realpath(resolved); } catch (error) { if (error.code === "ENOENT") return resolved; throw error; }
}

async function requireExplicitPaths({ versionDir, codexHome, gatewayDir, startupDir, journalPath }) {
  for (const [name, value] of Object.entries({ versionDir, codexHome, gatewayDir, startupDir, journalPath })) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be provided explicitly`);
  }
  const [isolatedGateway, legacyGateway] = await Promise.all([canonicalForCompare(gatewayDir), canonicalForCompare(gatewayPaths().dir)]);
  const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  if (normalize(isolatedGateway) === normalize(legacyGateway)) throw new Error("gatewayDir must be separate from the legacy/default gateway directory");
}

function stateSummary(journal) {
  const configured = journal.phase === "active";
  return {
    phase: journal.phase,
    configured,
    runtimeObserved: false,
    desktopAccepted: false,
    restartNeeded: configured,
    indeterminateStages: journal.indeterminateStages || [],
    codexHome: journal.paths.codexHome,
    versionDir: journal.paths.versionDir,
    gatewayDir: journal.paths.gatewayDir,
    startupFile: journal.autostart.file,
    journalPath: journal.paths.journalPath,
  };
}

async function snapshotEnvironment(adapter) {
  const currentEnvironment = {};
  for (const key of ["CODEX_CLI_PATH", "SOL_LUNA_NATIVE_PLAINTEXT_V2"]) currentEnvironment[key] = await adapter.get(key);
  return currentEnvironment;
}

async function snapshotStartup(adapter, file) { return adapter.get(file); }

function sameBytes(actual, expected) {
  if (actual === null || expected === null) return actual === expected;
  return Buffer.from(actual).equals(Buffer.from(expected));
}

async function restoreStartupIfNext(autostart, adapter) {
  const current = await adapter.get(autostart.file);
  if (sameBytes(current, Buffer.from(autostart.next, "utf8"))) await adapter.set(autostart.file, autostart.prior);
}

async function restoreStartupChecked(autostart, adapter) {
  const current = await adapter.get(autostart.file);
  if (!sameBytes(current, Buffer.from(autostart.next, "utf8"))) throw new Error("autostart file changed since activation; preserving the later change");
  await adapter.set(autostart.file, autostart.prior);
}

function withRecovery(primary, recoveryErrors, label) {
  return recoveryErrors.length ? new AggregateError([primary, ...recoveryErrors], `${label}; recovery also failed`) : primary;
}

export async function prepare(options = {}, dependencies = {}) {
  const { versionDir, codexHome, gatewayDir, startupDir, journalPath, legacyManifestPath, expectedMainModel, expectedMainProvider, expectedRootBaseUrl } = options;
  const smokeCheck = dependencies.smokeCheck ?? (Object.hasOwn(options, "smokeCheck") ? options.smokeCheck : runIsolatedConfigSmoke);
  await requireExplicitPaths({ versionDir, codexHome, gatewayDir, startupDir, journalPath });
  if (typeof smokeCheck !== "function") throw new Error("a real read-only smoke check is required before gateway startup");
  if (typeof expectedMainModel !== "string" || !expectedMainModel) throw new Error("expectedMainModel must be provided explicitly");
  if (!(typeof expectedMainProvider === "string" && expectedMainProvider) && expectedMainProvider !== null) throw new Error("expectedMainProvider must be a provider id or null");
  if (!Object.hasOwn(options, "expectedRootBaseUrl") || (expectedRootBaseUrl !== null && (typeof expectedRootBaseUrl !== "string" || !expectedRootBaseUrl))) {
    throw new Error("expectedRootBaseUrl must be explicitly provided as a URL or null");
  }
  await verifyRuntimeVersion(versionDir);
  const envAdapter = dependencies.envAdapter || options.envAdapter || createWindowsUserEnvironmentAdapter();
  const autostartAdapter = dependencies.autostartAdapter || options.autostartAdapter || await defaultAutostartAdapter();
  const paths = gatewayPaths(gatewayDir);
  const journal = path.resolve(journalPath);
  const startupFile = autostartFile(startupDir);
  if (await regularOrAbsent(journal, "install journal") !== null) throw new Error(`install journal already exists: ${journal}`);

  // Read-only preflight before starting the isolated service.
  const envPlan = await planEnvironment({ versionDir, currentEnvironment: await snapshotEnvironment(envAdapter) });
  const startupPrior = await snapshotStartup(autostartAdapter, startupFile);
  let legacyManifest = null;
  if (legacyManifestPath) {
    const manifestBytes = await regularOrAbsent(path.resolve(legacyManifestPath), "legacy install manifest");
    if (manifestBytes === null) throw new Error(`legacy install manifest is missing: ${path.resolve(legacyManifestPath)}`);
    legacyManifest = JSON.parse(manifestBytes.toString("utf8"));
  }
  const preflightFiles = await planFiles({ codexHome, baseUrl: "http://127.0.0.1:1/v1", versionDir, legacyManifest });

  let gateway;
  let smokeEvidence;
  try {
    gateway = await (dependencies.ensureGateway || options.ensureGateway || ensureGateway)({ paths });
    const state = gateway?.state;
    if (!state?.port || !state?.token || !Number.isInteger(state?.pid)) throw new Error("isolated gateway did not return a verified running identity");
    const baseUrl = `http://127.0.0.1:${state.port}/${state.token}/v1`;
    const realFiles = await planFiles({ codexHome, baseUrl, versionDir, legacyManifest });

    const fixtureHome = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "native-isolated-smoke-")));
    try {
      await mkdir(path.join(fixtureHome, "agents"), { recursive: true });
      const cacheBytes = await readFile(path.join(codexHome, "models_cache.json"));
      await writeFile(path.join(fixtureHome, "models_cache.json"), cacheBytes, { flag: "wx", mode: 0o600 });
      const previousConfig = preflightFiles.files["config.toml"].prior;
      if (previousConfig.exists) await writeFile(path.join(fixtureHome, "config.toml"), previousConfig.bytes, { flag: "wx", mode: 0o600 });
      const smokeFiles = await planFiles({ codexHome: fixtureHome, baseUrl, versionDir, legacyManifest });
      await applyFiles(smokeFiles);
      const smokeConfigPath = path.join(fixtureHome, "config.toml");
      const smokeConfig = withTemporaryRootModelCatalog(await readFile(smokeConfigPath, "utf8"), path.join(fixtureHome, "models_cache.json"));
      await writeFile(smokeConfigPath, smokeConfig, { mode: 0o600 });
      const smokeResult = await smokeCheck({
        exePath: realFiles.runtimeExePath,
        preparedHome: fixtureHome,
        expectedMainModel,
        expectedMainProvider,
        expectedRootBaseUrl,
      });
      if (smokeResult?.status !== "passed") throw new Error("isolated config smoke check did not report status=passed");
      smokeEvidence = { status: "passed", checks: smokeResult.checks ?? {} };
    } finally {
      const resolvedFixture = path.resolve(fixtureHome);
      if (resolvedFixture.startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(resolvedFixture, { recursive: true, force: true });
    }

    const journalData = {
      version: JOURNAL_VERSION,
      phase: "prepared",
      paths: { versionDir: path.resolve(versionDir), codexHome: path.resolve(codexHome), gatewayDir: paths.dir, startupDir: path.resolve(startupDir), journalPath: journal },
      files: realFiles,
      environment: envPlan,
      autostart: { file: startupFile, prior: startupPrior, next: autostartScript({ gatewayDir: paths.dir }) },
      smoke: smokeEvidence,
      completed: { files: false, environment: false, autostart: false },
    };
    await writeJournal(journal, journalData);
    return { prepared: true, phase: journalData.phase, journalPath: journal, codexHome: path.resolve(codexHome), versionDir: path.resolve(versionDir), gatewayDir: paths.dir };
  } catch (error) {
    const cleanupErrors = [];
    if (gateway?.started === true && gateway.state?.pid && gateway.state?.token) {
      try {
        const current = await (dependencies.readGatewayState || options.readGatewayState || readGatewayState)(paths);
        if (current?.pid === gateway.state.pid && current?.token === gateway.state.token) {
          await (dependencies.stopGateway || options.stopGateway || stopGateway)({ paths });
        }
      } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    throw withRecovery(error, cleanupErrors, "prepare failed");
  }
}

export async function activate({ journalPath, envAdapter = createWindowsUserEnvironmentAdapter(), autostartAdapter } = {}, dependencies = {}) {
  if (typeof journalPath !== "string" || !journalPath) throw new Error("journalPath must be provided explicitly");
  const journal = await readJournal(journalPath);
  if (journal.phase !== "prepared") throw new Error(`cannot activate install transaction in phase ${journal.phase}`);
  const startup = autostartAdapter || await defaultAutostartAdapter();
  const applied = { files: false, environment: false, autostart: false };
  let stage = "journal_start";
  journal.phase = "activating";
  await writeJournal(journalPath, journal);
  try {
    stage = "files";
    await applyFiles(journal.files);
    applied.files = true; journal.completed.files = true; stage = "journal_files"; await writeJournal(journalPath, journal);
    stage = "environment";
    const envSnapshot = await applyEnvironment(journal.environment, envAdapter);
    journal.environmentSnapshot = envSnapshot;
    applied.environment = true; journal.completed.environment = true; stage = "journal_environment"; await writeJournal(journalPath, journal);
    stage = "autostart";
    if (!sameBytes(await startup.get(journal.autostart.file), journal.autostart.prior)) throw new Error("autostart file changed since prepare");
    try { await startup.set(journal.autostart.file, Buffer.from(journal.autostart.next, "utf8")); }
    catch (error) {
      try { await restoreStartupIfNext(journal.autostart, startup); }
      catch (restoreError) { throw withRecovery(error, [restoreError], "autostart write failed"); }
      throw error;
    }
    applied.autostart = true; journal.completed.autostart = true;
    journal.phase = "active";
    stage = "journal_active";
    await writeJournal(journalPath, journal);
    return stateSummary(journal);
  } catch (error) {
    const recoveryErrors = [];
    const indeterminate = [];
    if (["files", "environment", "autostart"].includes(stage) && error instanceof AggregateError) {
      journal.completed[stage] = null;
      indeterminate.push(stage);
    }
    if (applied.autostart) try { await restoreStartupIfNext(journal.autostart, startup); journal.completed.autostart = false; } catch (item) { recoveryErrors.push(item); }
    if (applied.environment) try { await rollbackEnvironment(journal.environmentSnapshot, envAdapter); journal.completed.environment = false; } catch (item) { journal.completed.environment = null; indeterminate.push("environment"); recoveryErrors.push(item); }
    if (applied.files) try { await rollbackFiles(journal.files); journal.completed.files = false; } catch (item) { journal.completed.files = null; indeterminate.push("files"); recoveryErrors.push(item); }
    journal.indeterminateStages = [...new Set(indeterminate)];
    journal.phase = recoveryErrors.length || indeterminate.length ? "activation_recovery_failed" : "activation_failed";
    journal.recoveryErrors = recoveryErrors.map((item) => item.message);
    await writeJournal(journalPath, journal).catch((item) => recoveryErrors.push(item));
    throw withRecovery(error, recoveryErrors, "activation failed");
  }
}

export async function rollback({ journalPath, envAdapter = createWindowsUserEnvironmentAdapter(), autostartAdapter } = {}) {
  if (typeof journalPath !== "string" || !journalPath) throw new Error("journalPath must be provided explicitly");
  const journal = await readJournal(journalPath);
  if (journal.indeterminateStages?.length) throw new Error(`transaction has indeterminate stages requiring manual recovery: ${journal.indeterminateStages.join(", ")}`);
  if (!journal.completed?.files && !journal.completed?.environment && !journal.completed?.autostart) throw new Error(`nothing to roll back in phase ${journal.phase}`);
  const startup = autostartAdapter || await defaultAutostartAdapter();
  // Check all owned state before mutating any of it.
  if (journal.completed.autostart && !sameBytes(await startup.get(journal.autostart.file), Buffer.from(journal.autostart.next, "utf8"))) throw new Error("autostart file changed since activation; preserving the later change");
  if (journal.completed.environment) {
    for (const key of ["CODEX_CLI_PATH", "SOL_LUNA_NATIVE_PLAINTEXT_V2"]) {
      const current = await envAdapter.get(key);
      const expected = journal.environmentSnapshot.next[key];
      if (current?.present !== expected?.present || (current?.present && current.value !== expected.value)) throw new Error(`environment changed since activation: ${key}`);
    }
  }
  if (journal.completed.files) {
    for (const item of Object.values(journal.files.files)) {
      const current = await regularOrAbsent(item.path, "managed file");
      if (!current || !current.equals(Buffer.from(item.next, "utf8"))) throw new Error(`file changed since activation: ${item.path}`);
    }
  }

  const errors = [];
  journal.phase = "rolling_back"; await writeJournal(journalPath, journal);
  const indeterminate = [];
  if (journal.completed.autostart) try { await restoreStartupChecked(journal.autostart, startup); journal.completed.autostart = false; } catch (error) { journal.completed.autostart = null; indeterminate.push("autostart"); errors.push(error); }
  if (journal.completed.environment) try { await rollbackEnvironment(journal.environmentSnapshot, envAdapter); journal.completed.environment = false; } catch (error) { journal.completed.environment = null; indeterminate.push("environment"); errors.push(error); }
  if (journal.completed.files) try { await rollbackFiles(journal.files); journal.completed.files = false; } catch (error) { journal.completed.files = null; indeterminate.push("files"); errors.push(error); }
  journal.indeterminateStages = [...new Set([...(journal.indeterminateStages || []), ...indeterminate])];
  journal.phase = errors.length ? "rollback_failed" : "rolled_back";
  journal.recoveryErrors = errors.map((item) => item.message);
  await writeJournal(journalPath, journal).catch((error) => errors.push(error));
  if (errors.length) throw new AggregateError(errors, "rollback did not fully restore the isolated install transaction");
  return stateSummary(journal);
}

export async function status({ journalPath } = {}) {
  if (typeof journalPath !== "string" || !journalPath) throw new Error("journalPath must be provided explicitly");
  return stateSummary(await readJournal(journalPath));
}

async function main(argv) {
  const command = argv[0];
  const value = (name) => { const at = argv.indexOf(`--${name}`); return at < 0 ? undefined : argv[at + 1]; };
  const journalPath = value("journal-path");
  if (!journalPath) throw new Error("--journal-path is required");
  if (command === "status") process.stdout.write(`${JSON.stringify(await status({ journalPath }))}\n`);
  else if (command === "activate") process.stdout.write(`${JSON.stringify(await activate({ journalPath }))}\n`);
  else if (command === "rollback") process.stdout.write(`${JSON.stringify(await rollback({ journalPath }))}\n`);
  else if (command === "prepare") {
    const options = Object.fromEntries(["version-dir", "codex-home", "gateway-dir", "startup-dir", "journal-path", "legacy-manifest-path", "expected-main-model", "expected-main-provider", "expected-root-base-url"].map((name) => [name, value(name)]).filter(([, item]) => item !== undefined));
    const nullable = (item) => item === "null" ? null : item;
    process.stdout.write(`${JSON.stringify(await prepare({ versionDir: options["version-dir"], codexHome: options["codex-home"], gatewayDir: options["gateway-dir"], startupDir: options["startup-dir"], journalPath: options["journal-path"], legacyManifestPath: options["legacy-manifest-path"], expectedMainModel: options["expected-main-model"], expectedMainProvider: nullable(options["expected-main-provider"]), expectedRootBaseUrl: nullable(options["expected-root-base-url"]) }))}\n`);
  } else throw new Error("usage: native-isolated-install.mjs <prepare|activate|rollback|status> --journal-path PATH [--version-dir PATH --codex-home PATH --gateway-dir PATH --startup-dir PATH --expected-main-model SLUG --expected-main-provider ID|null --expected-root-base-url URL|null]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
