import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeJournal, encodeJournal, inspectNativeDeepseekDispatchState } from "./native-isolated-install.mjs";
import { gatewaySourceEntry, stageGatewaySource, verifyGatewaySource } from "./native-gateway-source.mjs";
import { rebaseGatewayTaskSnapshot } from "./native-gateway-task.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const SCRIPT_NAMES = Object.freeze([
  "native-credentials.mjs", "native-gateway.mjs", "native-relay.mjs", "native-routing.mjs", "native-usage.mjs",
]);
const normalized = (value) => process.platform === "win32" ? value.toLowerCase() : value;

async function readRegular(file, label) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  const canonical = await realpath(file);
  if (normalized(canonical) !== normalized(path.resolve(file))) throw new Error(`${label} must not traverse a reparse point`);
  return readFile(file);
}

async function atomicWrite(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.gateway-source-migrate-${randomUUID()}.tmp`);
  let ownsTemporary = false;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    ownsTemporary = true;
    await rename(temporary, file);
    ownsTemporary = false;
  } finally {
    if (ownsTemporary) await rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeBackup(file, bytes) {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

function launcherBytes(content) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]);
}

function gatewayPathLiteral(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("gateway script path must be absolute");
  return `"${path.resolve(value).replaceAll('"', '""')}"`.replaceAll('"', '""');
}

async function requireSourceParity(oldEntry, pluginRoot) {
  if (typeof pluginRoot !== "string" || !path.isAbsolute(pluginRoot)) throw new Error("pluginRoot must be absolute for source migration");
  const root = path.resolve(pluginRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || normalized(await realpath(root)) !== normalized(root)) {
    throw new Error("pluginRoot must be a regular canonical directory");
  }
  const oldScripts = path.dirname(oldEntry);
  const pluginScripts = path.join(root, "scripts");
  const scriptsInfo = await lstat(pluginScripts);
  if (!scriptsInfo.isDirectory() || scriptsInfo.isSymbolicLink() || normalized(await realpath(pluginScripts)) !== normalized(pluginScripts)) {
    throw new Error("plugin scripts directory must be regular and canonical");
  }
  for (const name of SCRIPT_NAMES) {
    const [oldBytes, newBytes] = await Promise.all([
      readRegular(path.join(oldScripts, name), "active gateway source module"),
      readRegular(path.join(pluginScripts, name), "plugin gateway source module"),
    ]);
    if (!oldBytes.equals(newBytes)) throw new Error(`plugin gateway source differs from the active source: ${name}`);
  }
}

async function requireStagedBundleParity(oldEntry, sourceBundle, runtimeRoot) {
  const stagedEntry = gatewaySourceEntry(sourceBundle, runtimeRoot);
  const stagedScripts = path.dirname(stagedEntry);
  const activeScripts = path.dirname(oldEntry);
  for (const name of SCRIPT_NAMES) {
    const [activeBytes, stagedBytes] = await Promise.all([
      readRegular(path.join(activeScripts, name), "active gateway source module"),
      readRegular(path.join(stagedScripts, name), "staged gateway source module"),
    ]);
    if (!activeBytes.equals(stagedBytes)) throw new Error(`staged gateway source differs from the active source: ${name}`);
  }
}

function cloneJournal(journal) {
  return decodeJournal(encodeJournal(journal));
}

async function inspect(options, dependencies) {
  const verifier = dependencies.readinessVerifier || inspectNativeDeepseekDispatchState;
  return verifier({
    journalPath: options.journalPath,
    envAdapter: options.envAdapter,
    taskAdapter: options.taskAdapter,
    requireRunning: true,
  }, {
    ...(dependencies.gatewayAdapter || {}),
    ...(options.taskAdapter ? { taskAdapter: options.taskAdapter } : {}),
  });
}

async function lockExclusive(file) {
  const bytes = Buffer.from(JSON.stringify({ schema: "sol-luna-gateway-source-migration-lock/v1", nonce: randomUUID() }) + "\n");
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return bytes;
}

async function releaseLock(file, bytes) {
  const current = await readRegular(file, "gateway source migration lock");
  if (!current.equals(bytes)) throw new Error("gateway source migration lock changed; refusing to remove it");
  await rm(file);
}

export async function migrateActiveGatewaySource({ journalPath, pluginRoot, envAdapter, taskAdapter } = {}, dependencies = {}) {
  if (typeof journalPath !== "string" || !path.isAbsolute(journalPath)) throw new Error("journalPath must be absolute");
  const resolvedJournalPath = path.resolve(journalPath);
  const originalBytes = await readRegular(resolvedJournalPath, "install journal");
  const originalJournal = decodeJournal(originalBytes.toString("utf8"));
  if (originalJournal?.version !== 1 || originalJournal.phase !== "active"
      || Object.values(originalJournal.completed || {}).some((value) => value !== true)) {
    throw new Error("gateway source migration requires a fully active version 1 journal");
  }
  await inspect({ journalPath: resolvedJournalPath, envAdapter, taskAdapter }, dependencies);
  if (originalJournal.gateway?.sourceBundle) {
    const root = originalJournal.paths?.gatewaySourceRoot;
    if (!root || !path.isAbsolute(root)) throw new Error("active source bundle root is missing");
    await verifyGatewaySource(originalJournal.gateway.sourceBundle, { runtimeRoot: root });
    return { status: "already_migrated", sourceDigest: originalJournal.gateway.sourceBundle.contentDigest };
  }

  const gatewayDir = originalJournal.paths?.gatewayDir;
  const oldEntry = originalJournal.paths?.gatewayScript;
  if (typeof gatewayDir !== "string" || !path.isAbsolute(gatewayDir) || typeof oldEntry !== "string" || !path.isAbsolute(oldEntry)) {
    throw new Error("active journal has no absolute gateway source paths");
  }
  const runtimeRoot = path.dirname(path.resolve(gatewayDir));
  const launcherPath = originalJournal.gateway?.launcher?.path;
  const oldLauncherBytes = await readRegular(launcherPath, "gateway task launcher");
  if (!oldLauncherBytes.equals(Buffer.from(originalJournal.gateway.launcher.next))) throw new Error("gateway task launcher changed before source migration");
  const oldPlan = originalJournal.gateway.taskPlan;
  if (!oldPlan?.launcher?.content || !originalJournal.gateway.taskSnapshot) throw new Error("active journal is missing its gateway Task plan snapshot");
  await requireSourceParity(oldEntry, pluginRoot);

  const lockPath = `${resolvedJournalPath}.gateway-source-migration.lock`;
  const lockBytes = await lockExclusive(lockPath);
  let lockOwned = true;
  let backupPath;
  let transitionBytes;
  let finalBytes;
  let newLauncherBytes;
  let stageRef;
  try {
    const beforeLockBytes = await readRegular(resolvedJournalPath, "install journal");
    if (!beforeLockBytes.equals(originalBytes)) throw new Error("install journal changed while acquiring migration lock");
    const checked = await inspect({ journalPath: resolvedJournalPath, envAdapter, taskAdapter }, dependencies);
    const checkedBytes = await readRegular(resolvedJournalPath, "install journal");
    if (!checkedBytes.equals(originalBytes)) throw new Error("install journal changed during migration preflight");
    if (checked.journal.gateway?.sourceBundle) throw new Error("install journal gained a source bundle during migration preflight");
    await requireSourceParity(oldEntry, pluginRoot);

    stageRef = await (dependencies.stageSource || stageGatewaySource)({ pluginRoot, runtimeRoot });
    await (dependencies.verifySource || verifyGatewaySource)(stageRef, { runtimeRoot });
    await requireStagedBundleParity(oldEntry, stageRef, runtimeRoot);
    await requireSourceParity(oldEntry, pluginRoot);

    const newEntry = gatewaySourceEntry(stageRef, runtimeRoot);
    const oldLiteral = gatewayPathLiteral(oldEntry);
    const newLiteral = gatewayPathLiteral(newEntry);
    const oldContent = oldPlan.launcher.content;
    if (oldContent.split(oldLiteral).length - 1 !== 1) throw new Error("gateway Task launcher does not contain one exact source path");
    const newPlan = {
      ...oldPlan,
      launcher: { ...oldPlan.launcher, content: oldContent.replace(oldLiteral, newLiteral) },
    };
    const newSnapshot = rebaseGatewayTaskSnapshot(originalJournal.gateway.taskSnapshot, oldPlan, newPlan, {
      fromScriptPath: oldEntry,
      toScriptPath: newEntry,
    });
    newLauncherBytes = launcherBytes(newPlan.launcher.content);
    if (!oldLauncherBytes.equals(launcherBytes(oldContent))) throw new Error("launcher bytes do not match the journaled Task plan");
    const prewriteJournal = await readRegular(resolvedJournalPath, "install journal");
    if (!prewriteJournal.equals(originalBytes)) throw new Error("install journal changed before migration writes");
    const prewriteLauncher = await readRegular(launcherPath, "gateway task launcher");
    if (!prewriteLauncher.equals(oldLauncherBytes)) throw new Error("gateway task launcher changed before migration writes");
    await requireSourceParity(oldEntry, pluginRoot);

    backupPath = `${resolvedJournalPath}.gateway-source-${randomUUID()}.backup`;
    await writeBackup(backupPath, originalBytes);
    const migrationJournal = cloneJournal(originalJournal);
    migrationJournal.phase = "gateway_source_migrating";
    migrationJournal.gateway.sourceMigration = {
      schema: "sol-luna-gateway-source-migration/v1",
      status: "in_progress",
      backupSha256: sha256(originalBytes),
      backupPath,
      sourceDigest: stageRef.contentDigest,
    };
    transitionBytes = Buffer.from(encodeJournal(migrationJournal), "utf8");
    await (dependencies.atomicWrite || atomicWrite)(resolvedJournalPath, transitionBytes);

    const launcherNow = await readRegular(launcherPath, "gateway task launcher");
    if (!launcherNow.equals(oldLauncherBytes)) throw new Error("gateway task launcher changed during migration");
    await (dependencies.atomicWrite || atomicWrite)(launcherPath, newLauncherBytes);

    const migratedJournal = cloneJournal(originalJournal);
    migratedJournal.phase = "active";
    migratedJournal.paths.gatewayScript = newEntry;
    migratedJournal.paths.gatewaySourceRoot = runtimeRoot;
    migratedJournal.gateway.sourceBundle = stageRef;
    migratedJournal.gateway.taskPlan = newPlan;
    migratedJournal.gateway.taskSnapshot = newSnapshot;
    migratedJournal.gateway.launcher.next = newLauncherBytes;
    migratedJournal.gateway.sourceMigration = {
      schema: "sol-luna-gateway-source-migration/v1",
      status: "complete",
      backupSha256: sha256(originalBytes),
      backupPath,
      sourceDigest: stageRef.contentDigest,
    };
    finalBytes = Buffer.from(encodeJournal(migratedJournal), "utf8");
    await (dependencies.atomicWrite || atomicWrite)(resolvedJournalPath, finalBytes);
    const finalJournalBytes = await readRegular(resolvedJournalPath, "install journal");
    if (!finalJournalBytes.equals(finalBytes)) throw new Error("final migrated journal read-back does not match the intended bytes");
    const finalLauncherBytes = await readRegular(launcherPath, "gateway task launcher");
    if (!finalLauncherBytes.equals(newLauncherBytes)) throw new Error("final migrated launcher read-back does not match the intended bytes");
    await (dependencies.verifySource || verifyGatewaySource)(stageRef, { runtimeRoot });
    await requireStagedBundleParity(oldEntry, stageRef, runtimeRoot);
    await inspect({ journalPath: resolvedJournalPath, envAdapter, taskAdapter }, dependencies);
    return { status: "migrated", sourceDigest: stageRef.contentDigest, backupSha256: sha256(originalBytes) };
  } catch (error) {
    let recoveryError;
    try {
      const currentLauncher = await readRegular(launcherPath, "gateway task launcher");
      if (newLauncherBytes && currentLauncher.equals(newLauncherBytes)) {
        await (dependencies.atomicWrite || atomicWrite)(launcherPath, oldLauncherBytes);
      } else if (!currentLauncher.equals(oldLauncherBytes)) {
        throw new Error("gateway task launcher has third-party bytes; refusing to restore it");
      }
    } catch (restoreError) { recoveryError = restoreError; }
    try {
      const currentJournal = await readRegular(resolvedJournalPath, "install journal");
      if ((transitionBytes && currentJournal.equals(transitionBytes)) || (finalBytes && currentJournal.equals(finalBytes))) {
        if (recoveryError) {
          const failed = decodeJournal(currentJournal.toString("utf8"));
          failed.phase = "gateway_source_migration_recovery_failed";
          failed.gateway.sourceMigration = { ...failed.gateway.sourceMigration, status: "recovery_failed" };
          await (dependencies.atomicWrite || atomicWrite)(resolvedJournalPath, Buffer.from(encodeJournal(failed), "utf8"));
        } else {
          await (dependencies.atomicWrite || atomicWrite)(resolvedJournalPath, originalBytes);
        }
      } else if (!currentJournal.equals(originalBytes)) {
        throw new Error("install journal has third-party bytes; refusing to restore it");
      }
    } catch (restoreError) { recoveryError ||= restoreError; }
    if (recoveryError) {
      const wrapped = new Error("gateway source migration failed and requires recovery");
      wrapped.code = "GATEWAY_SOURCE_MIGRATION_RECOVERY_FAILED";
      wrapped.cause = error;
      wrapped.recoveryCause = recoveryError;
      throw wrapped;
    }
    throw error;
  } finally {
    if (lockOwned) {
      await releaseLock(lockPath, lockBytes);
      lockOwned = false;
    }
  }
}

async function main(argv) {
  const value = (name) => { const at = argv.indexOf(`--${name}`); return at < 0 ? undefined : argv[at + 1]; };
  const journalPath = value("journal-path");
  const pluginRoot = value("plugin-root");
  if (!journalPath) throw new Error("--journal-path is required");
  const result = await migrateActiveGatewaySource({ journalPath, pluginRoot });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : "GATEWAY_SOURCE_MIGRATION_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
    process.exitCode = 1;
  });
}
