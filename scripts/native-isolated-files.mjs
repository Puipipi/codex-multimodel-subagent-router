import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildChildCatalog, readCatalogCache } from "./native-catalog.mjs";
import { composeIsolatedConfig, hasIsolatedConfigMarker, isolatedAgentToml } from "./native-isolated-config.mjs";
import { verifyRuntimeVersion } from "./native-runtime.mjs";

const FILES = ["config.toml", "agents/native_deepseek.toml", "sol-luna-native-models.json"];

function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function requireDirectory(directory, label) {
  let info;
  try { info = await lstat(directory); } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} is missing: ${directory}`);
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory: ${directory}`);
}

async function requireRegularOrAbsent(file, label) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${file}`);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function validateHome(codexHome) {
  if (typeof codexHome !== "string" || !codexHome) throw new Error("codexHome is required");
  const home = path.resolve(codexHome);
  await requireDirectory(home, "Codex home");
  const agents = path.join(home, "agents");
  try { await requireDirectory(agents, "agents directory"); } catch (error) {
    if (error.message.endsWith(`is missing: ${agents}`)) return home;
    throw error;
  }
  return home;
}

function targetPath(home, relative) {
  if (!FILES.includes(relative)) throw new Error(`unmanaged isolated file: ${relative}`);
  const file = path.resolve(home, relative);
  if (!within(home, file)) throw new Error(`isolated file path escapes Codex home: ${relative}`);
  return file;
}

async function snapshot(file) {
  const exists = await requireRegularOrAbsent(file, "managed file");
  return exists ? { exists: true, bytes: await readFile(file) } : { exists: false, bytes: null };
}

function sameSnapshot(actual, expected) {
  return actual.exists === expected.exists && (!actual.exists || actual.bytes.equals(expected.bytes));
}

async function currentMatches(file, expected) {
  const actual = await snapshot(file);
  return sameSnapshot(actual, expected);
}

async function defaultAtomicWrite(file, bytes) {
  const parent = path.dirname(file);
  await mkdir(parent, { recursive: true });
  const temp = path.join(parent, `.native-isolated-${randomUUID()}.tmp`);
  let created = false;
  try {
    await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
    created = true;
    await rename(temp, file);
    created = false;
  } finally {
    if (created && path.basename(temp).startsWith(".native-isolated-") && path.dirname(temp) === parent) {
      await rm(temp, { force: true }).catch(() => {});
    }
  }
}

async function writeNext(file, next, writer) {
  await writer(file, Buffer.from(next, "utf8"));
}

async function restorePrior(file, prior, writer) {
  if (prior.exists) await writer(file, prior.bytes);
  else {
    await requireRegularOrAbsent(file, "managed file before removal");
    await unlink(file).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

function aggregateFailure(primary, others, label) {
  return others.length ? new AggregateError([primary, ...others], `${label}; one or more recovery operations also failed`) : primary;
}

function manifestOwnsPath(legacyManifest, field, expectedPath) {
  const candidate = legacyManifest?.[field];
  return typeof candidate === "string" && path.resolve(candidate) === path.resolve(expectedPath);
}

async function restoreIfStillNext(transaction, writer, names) {
  const errors = [];
  for (const name of [...names].reverse()) {
    const item = transaction.files[name];
    try {
      if (await currentMatches(item.path, { exists: true, bytes: Buffer.from(item.next, "utf8") })) {
        await restorePrior(item.path, item.prior, writer);
      }
    } catch (error) { errors.push(new Error(`failed to restore ${name}: ${error.message}`, { cause: error })); }
  }
  return errors;
}

function assertPlan(transaction) {
  if (!transaction?.codexHome || !transaction?.versionDir || !transaction?.files) throw new Error("a valid isolated file plan is required");
  const names = Object.keys(transaction.files).sort();
  if (names.join("\n") !== [...FILES].sort().join("\n")) throw new Error("isolated file plan must contain exactly the three managed files");
}

export async function plan({ codexHome, baseUrl, versionDir, legacyManifest } = {}) {
  const verified = await verifyRuntimeVersion(versionDir);
  const home = await validateHome(codexHome);
  const cacheFile = path.join(home, "models_cache.json");
  if (!await requireRegularOrAbsent(cacheFile, "models_cache.json") ) throw new Error(`Codex models_cache.json is missing at ${cacheFile}`);
  const cache = readCatalogCache(home);
  const catalog = buildChildCatalog(cache);
  const agentFile = targetPath(home, "agents/native_deepseek.toml");
  const configFile = targetPath(home, "config.toml");
  const catalogFile = targetPath(home, "sol-luna-native-models.json");
  const snapshots = Object.fromEntries(await Promise.all(FILES.map(async (name) => [name, await snapshot(targetPath(home, name))])));
  const next = {
    "config.toml": composeIsolatedConfig(snapshots["config.toml"].exists ? snapshots["config.toml"].bytes.toString("utf8") : "", {
      baseUrl,
      agentConfigPath: agentFile,
      legacyManifest,
    }),
    "agents/native_deepseek.toml": isolatedAgentToml(),
    "sol-luna-native-models.json": `${JSON.stringify(catalog, null, 2)}\n`,
  };
  const managedConfig = hasIsolatedConfigMarker(snapshots["config.toml"].exists ? snapshots["config.toml"].bytes.toString("utf8") : "");
  for (const name of ["agents/native_deepseek.toml", "sol-luna-native-models.json"]) {
    const prior = snapshots[name];
    if (!prior.exists || prior.bytes.equals(Buffer.from(next[name], "utf8")) || managedConfig) continue;
    const manifestField = name === "agents/native_deepseek.toml" ? "agent" : "catalog";
    if (!manifestOwnsPath(legacyManifest, manifestField, targetPath(home, name))) {
      throw new Error(`unowned ${name} already exists; refusing to overwrite it`);
    }
  }
  return {
    codexHome: home,
    versionDir: path.resolve(versionDir),
    runtimeExePath: verified.exePath,
    files: Object.fromEntries(FILES.map((name) => [name, {
      path: targetPath(home, name),
      prior: snapshots[name],
      next: next[name],
    }])),
  };
}

export async function apply(transaction, { writeFileAtomic = defaultAtomicWrite } = {}) {
  assertPlan(transaction);
  await verifyRuntimeVersion(transaction.versionDir);
  const home = await validateHome(transaction.codexHome);
  const writer = writeFileAtomic;
  for (const name of FILES) {
    const item = transaction.files[name];
    const expectedPath = targetPath(home, name);
    if (path.resolve(item.path) !== expectedPath) throw new Error(`isolated file plan path mismatch: ${name}`);
    if (!await currentMatches(expectedPath, item.prior)) throw new Error(`file changed since plan: ${name}`);
  }
  const attempted = [];
  try {
    for (const name of FILES) {
      const item = transaction.files[name];
      if (!await currentMatches(item.path, item.prior)) throw new Error(`file changed since plan: ${name}`);
      attempted.push(name);
      await writeNext(item.path, item.next, writer);
    }
  } catch (error) {
    const recoveryErrors = await restoreIfStillNext(transaction, writer, attempted);
    throw aggregateFailure(error, recoveryErrors, "isolated file apply failed");
  }
  return transaction;
}

export async function rollback(transaction, { writeFileAtomic = defaultAtomicWrite } = {}) {
  assertPlan(transaction);
  const home = await validateHome(transaction.codexHome);
  for (const name of FILES) {
    const item = transaction.files[name];
    if (path.resolve(item.path) !== targetPath(home, name)) throw new Error(`isolated file plan path mismatch: ${name}`);
    if (!await currentMatches(item.path, { exists: true, bytes: Buffer.from(item.next, "utf8") })) {
      throw new Error(`file changed since apply: ${name}`);
    }
  }
  const attempted = [];
  try {
    for (const name of [...FILES].reverse()) {
      const item = transaction.files[name];
      if (!await currentMatches(item.path, { exists: true, bytes: Buffer.from(item.next, "utf8") })) throw new Error(`file changed since apply: ${name}`);
      attempted.push(name);
      await restorePrior(item.path, item.prior, writeFileAtomic);
    }
  } catch (error) {
    const recoveryErrors = [];
    for (const name of [...attempted].reverse()) {
      const item = transaction.files[name];
      try {
        if (await currentMatches(item.path, item.prior)) await writeNext(item.path, item.next, writeFileAtomic);
      } catch (recoveryError) { recoveryErrors.push(new Error(`failed to restore applied ${name}: ${recoveryError.message}`, { cause: recoveryError })); }
    }
    throw aggregateFailure(error, recoveryErrors, "isolated file rollback failed");
  }
  return { restored: true };
}

export const NATIVE_ISOLATED_FILES = [...FILES];
