#!/usr/bin/env node
/**
 * Idempotent Windows console-window fix for the task-managed
 * dsh-subagent-mcp 0.7.0 install.
 *
 * Upstream commit 2ca7933 adds `windowsHide: true` to Runtime's
 * spawn(process.execPath, ..., {stdio: ['pipe','pipe','pipe']}) call.
 * This script changes only that one options object; it does not touch
 * global settings, the service lifecycle, package.json, or the license.
 *
 * The managed root is resolved from config/installation.json. A test-only
 * DSH_SUBAGENT_MCP_HOME override is supported so fixtures never touch the
 * real install.
 */
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const EXPECTED_NAME = 'dsh-subagent-mcp';
const EXPECTED_VERSION = '0.7.0';
const SPAWN_STDIO_LINE = "      cwd: agent.cwd, env: {...process.env, ...providerEnvironment(), ...config.env, DSH_CLI: config.cli}, stdio: ['pipe','pipe','pipe'],";
const SPAWN_CLOSE_LINE = '    });';
const WINDOWS_HIDE_LINE = '      windowsHide: true,';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  throw new Error(message);
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function requireInside(parent, candidate, label) {
  if (!isInside(parent, candidate)) fail(`${label} is outside the allowed root: ${candidate}`);
}

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    fail(`cannot read ${label}: ${error.message}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail(`invalid ${label}: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`invalid ${label}: expected an object`);
  return value;
}

function countOccurrences(haystack, needle) {
  if (needle.length === 0) fail('internal error: empty search string');
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function resolveHome() {
  const override = process.env.DSH_SUBAGENT_MCP_HOME;
  let base;
  if (override) {
    base = path.resolve(override);
  } else {
    if (!process.env.LOCALAPPDATA) fail('LOCALAPPDATA is not set; cannot locate the managed installation');
    base = path.join(process.env.LOCALAPPDATA, 'dsh-subagent-mcp');
  }
  if (!fs.existsSync(base)) fail(`managed root not found: ${base}`);
  const home = fs.realpathSync.native(base);
  if (!fs.statSync(home).isDirectory()) fail(`managed root is not a directory: ${home}`);
  return home;
}

function resolvePackage(home) {
  const installationPath = path.join(home, 'config', 'installation.json');
  if (!fs.existsSync(installationPath)) fail(`managed installation metadata not found: ${installationPath}`);
  const installation = readJson(installationPath, 'installation.json');

  if (installation.version !== EXPECTED_VERSION) {
    fail(`managed installation version is ${JSON.stringify(installation.version)}, expected ${EXPECTED_VERSION}`);
  }
  if (typeof installation.root !== 'string' || installation.root.trim() === '' || !path.isAbsolute(installation.root)) {
    fail('installation.json root is not an absolute path');
  }

  let packageRoot;
  try {
    packageRoot = fs.realpathSync.native(path.resolve(installation.root));
  } catch (error) {
    fail(`installation root does not resolve: ${error.message}`);
  }
  requireInside(home, packageRoot, 'installation root');

  const relative = path.relative(home, packageRoot);
  const parts = relative.split(path.sep);
  if (parts.length !== 4 || parts[0] !== 'versions' || parts[2] !== 'node_modules' || parts[3] !== EXPECTED_NAME) {
    fail(`unexpected managed package layout: ${packageRoot}`);
  }
  if (parts[1] !== EXPECTED_VERSION && !parts[1].startsWith(`${EXPECTED_VERSION}-`)) {
    fail(`unexpected managed version directory: ${parts[1]}`);
  }

  const manifestPath = path.join(packageRoot, 'package.json');
  if (!fs.existsSync(manifestPath)) fail(`package.json not found: ${manifestPath}`);
  const manifest = readJson(manifestPath, 'package.json');
  if (manifest.name !== EXPECTED_NAME) fail(`unexpected package name: ${JSON.stringify(manifest.name)}`);
  if (manifest.version !== EXPECTED_VERSION) fail(`package version is ${JSON.stringify(manifest.version)}, expected ${EXPECTED_VERSION}`);

  const runtimePath = path.join(packageRoot, 'src', 'runtime.mjs');
  let runtimeReal;
  try {
    runtimeReal = fs.realpathSync.native(runtimePath);
  } catch (error) {
    fail(`runtime.mjs does not resolve: ${error.message}`);
  }
  requireInside(packageRoot, runtimeReal, 'runtime.mjs');
  if (!fs.statSync(runtimeReal).isFile()) fail(`runtime.mjs is not a regular file: ${runtimeReal}`);
  if (isInside(REPO_ROOT, runtimeReal)) fail('refusing to patch a runtime.mjs inside the repository');

  return {installationPath, packageRoot, runtimePath: runtimeReal, versionTag: parts[1], license: manifest.license};
}

function runNodeCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) fail(`node --check could not run: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(`node --check failed for ${file} (exit ${result.status})${detail ? `: ${detail}` : ''}`);
  }
}

function atomicWrite(file, data, mode) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, data, {mode});
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Already renamed or never created.
    }
  }
}

function apply() {
  const home = resolveHome();
  const {installationPath, packageRoot, runtimePath, versionTag, license} = resolvePackage(home);

  const original = fs.readFileSync(runtimePath);
  const beforeDigest = sha256(original);
  const installationDigest = sha256(fs.readFileSync(installationPath));
  const licensePath = path.join(packageRoot, 'LICENSE');
  const licenseDigest = fs.existsSync(licensePath) ? sha256(fs.readFileSync(licensePath)) : null;
  const source = original.toString('utf8');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  if (eol === '\r\n' && /(^|[^\r])\n/.test(source)) fail('runtime.mjs has mixed line endings');

  const originalBlock = [SPAWN_STDIO_LINE, SPAWN_CLOSE_LINE].join(eol);
  const patchedBlock = [SPAWN_STDIO_LINE, WINDOWS_HIDE_LINE, SPAWN_CLOSE_LINE].join(eol);
  const patchedOccurrences = countOccurrences(source, patchedBlock);
  const originalOccurrences = countOccurrences(source, originalBlock);
  const hideOccurrences = countOccurrences(source, 'windowsHide');

  if (patchedOccurrences === 1 && hideOccurrences === 1) {
    runNodeCheck(runtimePath);
    console.log(`target: ${runtimePath}`);
    console.log(`digest: sha256:${beforeDigest}`);
    console.log('change: none (windowsHide: true is already present in the Runtime spawn options)');
    console.log('check: node --check (exit 0)');
    console.log('status: already patched');
    return;
  }
  if (patchedOccurrences !== 0) fail(`unexpected layout: found ${patchedOccurrences} already-patched spawn option blocks`);
  if (hideOccurrences !== 0) fail(`unexpected layout: runtime.mjs already contains ${hideOccurrences} windowsHide reference(s)`);
  if (originalOccurrences !== 1) {
    fail(`unexpected layout: expected exactly one Runtime spawn option block, found ${originalOccurrences}`);
  }

  const patchedSource = source.replace(originalBlock, patchedBlock);
  if (patchedSource.length !== source.length + eol.length + WINDOWS_HIDE_LINE.length) {
    fail('internal error: patch changed more than the spawn options');
  }
  if (countOccurrences(patchedSource, 'windowsHide') !== 1 || countOccurrences(patchedSource, patchedBlock) !== 1) {
    fail('internal error: patched content verification failed');
  }

  const backupDir = path.join(home, 'backups', versionTag);
  fs.mkdirSync(backupDir, {recursive: true});
  const backupDirReal = fs.realpathSync.native(backupDir);
  requireInside(home, backupDirReal, 'backup directory');
  if (isInside(REPO_ROOT, backupDirReal)) fail('refusing to write a backup inside the repository');
  const backupPath = path.join(backupDirReal, `runtime.mjs.${beforeDigest}.bak`);
  requireInside(backupDirReal, backupPath, 'backup file');

  if (fs.existsSync(backupPath)) {
    if (sha256(fs.readFileSync(backupPath)) !== beforeDigest) fail(`existing backup does not match runtime.mjs: ${backupPath}`);
  } else {
    fs.writeFileSync(backupPath, original, {flag: 'wx', mode: 0o600});
    if (sha256(fs.readFileSync(backupPath)) !== beforeDigest) fail(`backup verification failed: ${backupPath}`);
  }

  const stat = fs.statSync(runtimePath);
  const tempPath = path.join(path.dirname(runtimePath), `.runtime.${process.pid}.${crypto.randomBytes(6).toString('hex')}.check.mjs`);
  try {
    fs.writeFileSync(tempPath, patchedSource, {mode: stat.mode});
    fs.chmodSync(tempPath, stat.mode);
    runNodeCheck(tempPath);
    if (sha256(fs.readFileSync(runtimePath)) !== beforeDigest) fail('runtime.mjs changed while patching; aborting');
    fs.renameSync(tempPath, runtimePath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Already renamed or never created.
    }
  }

  const patchedBytes = fs.readFileSync(runtimePath);
  const afterDigest = sha256(patchedBytes);
  if (afterDigest !== sha256(Buffer.from(patchedSource, 'utf8'))) fail('written runtime.mjs does not match the intended patch');
  try {
    runNodeCheck(runtimePath);
  } catch (error) {
    atomicWrite(runtimePath, original, stat.mode);
    fail(`patched runtime failed validation and was restored: ${error.message}`);
  }
  if (sha256(fs.readFileSync(backupPath)) !== beforeDigest) fail(`backup no longer matches the original: ${backupPath}`);
  if (sha256(fs.readFileSync(installationPath)) !== installationDigest) fail('installation metadata changed unexpectedly');
  if (licenseDigest !== null && sha256(fs.readFileSync(licensePath)) !== licenseDigest) fail('LICENSE changed unexpectedly');

  console.log(`target: ${runtimePath}`);
  console.log(`package: ${packageRoot}`);
  console.log(`backup: ${backupPath}`);
  console.log(`license: ${license ?? 'unknown'} (unchanged)`);
  console.log(`before: sha256:${beforeDigest}`);
  console.log(`after:  sha256:${afterDigest}`);
  console.log('change: Runtime spawn(process.execPath, ...) options += windowsHide: true');
  console.log('check: node --check (exit 0)');
  console.log('status: patched');
}

try {
  apply();
} catch (error) {
  console.error(`patch-backend-windows: FAIL: ${error.message}`);
  process.exitCode = 1;
}
