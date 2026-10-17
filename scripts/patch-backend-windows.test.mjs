import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const PATCH_SCRIPT = fileURLToPath(new URL('./patch-backend-windows.mjs', import.meta.url));

const SPAWN_STDIO_LINE = "      cwd: agent.cwd, env: {...process.env, ...providerEnvironment(), ...config.env, DSH_CLI: config.cli}, stdio: ['pipe','pipe','pipe'],";
const SPAWN_CLOSE_LINE = '    });';
const WINDOWS_HIDE_LINE = '      windowsHide: true,';
const ORIGINAL_BLOCK = [SPAWN_STDIO_LINE, SPAWN_CLOSE_LINE].join('\n');
const PATCHED_BLOCK = [SPAWN_STDIO_LINE, WINDOWS_HIDE_LINE, SPAWN_CLOSE_LINE].join('\n');

const RUNTIME_SOURCE = `import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {providerEnvironment} from './platform.mjs';

export class Runtime extends EventEmitter {
  constructor(agent, config) {
    this.child = spawn(process.execPath, [config.cli, '--profile', 'codex-subagent', '--patch', agent.preset ? config.patch : config.legacyPatch], {
${ORIGINAL_BLOCK}
  }
}
`;
const PLATFORM_SOURCE = 'export function providerEnvironment() { return {}; }\n';
const LICENSE_TEXT = `MIT License

Copyright (c) 2026 Fixture
`;

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hashFile(file) {
  return sha256(fs.readFileSync(file));
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  visit(root);
  return files;
}

function snapshot(root) {
  const result = new Map();
  for (const file of walkFiles(root)) result.set(path.relative(root, file), hashFile(file));
  return result;
}

function listBackups(home) {
  return walkFiles(path.join(home, 'backups')).filter((file) => file.endsWith('.bak'));
}

function runPatch(home) {
  const env = {...process.env, DSH_SUBAGENT_MCP_HOME: home, LOCALAPPDATA: path.join(path.dirname(home), 'fake-localappdata')};
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, [PATCH_SCRIPT], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
}

function createFixture(t, options = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-patch-backend-windows-'));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));

  const home = path.join(temp, 'dsh-subagent-mcp');
  let packageRoot;
  if (options.outsideManagedRoot) {
    packageRoot = path.join(temp, 'outside-package');
  } else if (options.wrongLayout) {
    packageRoot = path.join(home, 'packages', 'dsh-subagent-mcp');
  } else {
    packageRoot = path.join(home, 'versions', '0.7.0-fixture', 'node_modules', 'dsh-subagent-mcp');
  }

  fs.mkdirSync(path.join(packageRoot, 'src'), {recursive: true});
  const runtimePath = path.join(packageRoot, 'src', 'runtime.mjs');
  fs.writeFileSync(runtimePath, options.runtimeSource ?? RUNTIME_SOURCE);
  fs.writeFileSync(path.join(packageRoot, 'src', 'platform.mjs'), PLATFORM_SOURCE);

  const manifestPath = path.join(packageRoot, 'package.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    name: 'dsh-subagent-mcp',
    version: options.packageVersion ?? '0.7.0',
    license: 'MIT',
    type: 'module',
  }, null, 2)}\n`);

  const licensePath = path.join(packageRoot, 'LICENSE');
  fs.writeFileSync(licensePath, LICENSE_TEXT);

  fs.mkdirSync(path.join(home, 'config'), {recursive: true});
  const installationPath = path.join(home, 'config', 'installation.json');
  fs.writeFileSync(installationPath, `${JSON.stringify({
    version: options.installationVersion ?? '0.7.0',
    root: packageRoot,
    backend: 'background',
  }, null, 2)}\n`);

  fs.mkdirSync(path.join(home, 'state'), {recursive: true});
  const stateSentinel = path.join(home, 'state', 'daemon.lock');
  fs.writeFileSync(stateSentinel, 'state-sentinel\n');
  const outsideSentinel = path.join(temp, 'outside-sentinel.txt');
  fs.writeFileSync(outsideSentinel, 'outside-sentinel\n');

  return {
    temp,
    home,
    packageRoot,
    runtimePath,
    manifestPath,
    licensePath,
    installationPath,
    stateSentinel,
    outsideSentinel,
    fakeLocalAppData: path.join(temp, 'fake-localappdata'),
  };
}

test('patches exactly the Runtime spawn options once and is idempotent', (t) => {
  const fixture = createFixture(t);
  const beforeHome = snapshot(fixture.home);
  const beforeRuntime = fs.readFileSync(fixture.runtimePath);
  const beforeRuntimeDigest = sha256(beforeRuntime);
  const beforeOutside = hashFile(fixture.outsideSentinel);
  const beforeInstallation = hashFile(fixture.installationPath);
  const beforeLicense = hashFile(fixture.licensePath);
  const beforeManifest = hashFile(fixture.manifestPath);

  const first = runPatch(fixture.home);
  assert.equal(first.status, 0, `first patch failed:\n${first.stdout}\n${first.stderr}`);
  assert.match(first.stdout, /status: patched/);
  assert.match(first.stdout, /before: sha256:[0-9a-f]{64}/);
  assert.match(first.stdout, /after:  sha256:[0-9a-f]{64}/);

  const patched = fs.readFileSync(fixture.runtimePath, 'utf8');
  assert.equal(patched, RUNTIME_SOURCE.replace(ORIGINAL_BLOCK, PATCHED_BLOCK));
  assert.ok(!patched.includes(ORIGINAL_BLOCK));
  assert.equal(countOccurrences(patched, 'windowsHide'), 1);
  assert.ok(patched.includes(`spawn(process.execPath, [config.cli, '--profile', 'codex-subagent', '--patch', agent.preset ? config.patch : config.legacyPatch], {\n${PATCHED_BLOCK}`));
  assert.match(patched, /stdio: \['pipe','pipe','pipe'\],\n      windowsHide: true,\n    \}\);/);

  const backups = listBackups(fixture.home);
  assert.equal(backups.length, 1);
  assert.equal(hashFile(backups[0]), beforeRuntimeDigest);
  assert.equal(path.basename(backups[0]), `runtime.mjs.${beforeRuntimeDigest}.bak`);
  assert.ok(backups[0].startsWith(path.join(fixture.home, 'backups') + path.sep));

  const afterHome = snapshot(fixture.home);
  const runtimeRelative = path.relative(fixture.home, fixture.runtimePath);
  for (const [relative, digest] of beforeHome) {
    if (relative === runtimeRelative) continue;
    assert.equal(afterHome.get(relative), digest, `unexpected modification: ${relative}`);
  }
  const added = [...afterHome.keys()].filter((relative) => !beforeHome.has(relative));
  assert.deepEqual(added, [path.relative(fixture.home, backups[0])]);

  assert.equal(hashFile(fixture.outsideSentinel), beforeOutside);
  assert.equal(hashFile(fixture.installationPath), beforeInstallation);
  assert.equal(hashFile(fixture.licensePath), beforeLicense);
  assert.equal(hashFile(fixture.manifestPath), beforeManifest);
  assert.equal(fs.existsSync(fixture.fakeLocalAppData), false);

  const check = spawnSync(process.execPath, ['--check', fixture.runtimePath], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(check.status, 0, check.stderr);

  const second = runPatch(fixture.home);
  assert.equal(second.status, 0, `second patch failed:\n${second.stdout}\n${second.stderr}`);
  assert.match(second.stdout, /status: already patched/);
  assert.match(second.stdout, new RegExp(`digest: sha256:${sha256(Buffer.from(patched, 'utf8'))}`));
  assert.equal(fs.readFileSync(fixture.runtimePath, 'utf8'), patched);
  assert.equal(listBackups(fixture.home).length, 1);
  assert.equal(hashFile(fixture.outsideSentinel), beforeOutside);
  assert.equal(fs.existsSync(fixture.fakeLocalAppData), false);
  assert.deepEqual([...snapshot(fixture.home).entries()].sort(), [...afterHome.entries()].sort());
});

test('rejects a non-0.7.0 managed installation before writing', (t) => {
  const fixture = createFixture(t, {installationVersion: '0.7.1'});
  const beforeRuntime = fs.readFileSync(fixture.runtimePath);
  const beforeOutside = hashFile(fixture.outsideSentinel);

  const result = runPatch(fixture.home);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /installation version is "0\.7\.1", expected 0\.7\.0/);
  assert.ok(fs.readFileSync(fixture.runtimePath).equals(beforeRuntime));
  assert.equal(listBackups(fixture.home).length, 0);
  assert.equal(hashFile(fixture.outsideSentinel), beforeOutside);
});

test('rejects a non-0.7.0 package manifest before writing', (t) => {
  const fixture = createFixture(t, {packageVersion: '0.7.1'});
  const beforeRuntime = fs.readFileSync(fixture.runtimePath);

  const result = runPatch(fixture.home);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package version is "0\.7\.1", expected 0\.7\.0/);
  assert.ok(fs.readFileSync(fixture.runtimePath).equals(beforeRuntime));
  assert.equal(listBackups(fixture.home).length, 0);
});

test('rejects unexpected layouts and spawn shapes without broad replacement', (t) => {
  const wrongLayout = createFixture(t, {wrongLayout: true});
  const wrongLayoutBefore = fs.readFileSync(wrongLayout.runtimePath);
  let result = runPatch(wrongLayout.home);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected managed package layout/);
  assert.ok(fs.readFileSync(wrongLayout.runtimePath).equals(wrongLayoutBefore));
  assert.equal(listBackups(wrongLayout.home).length, 0);

  const outside = createFixture(t, {outsideManagedRoot: true});
  const outsideBefore = fs.readFileSync(outside.runtimePath);
  result = runPatch(outside.home);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /installation root is outside the allowed root/);
  assert.ok(fs.readFileSync(outside.runtimePath).equals(outsideBefore));
  assert.equal(listBackups(outside.home).length, 0);

  const unexpectedSpawn = createFixture(t, {
    runtimeSource: RUNTIME_SOURCE.replace(ORIGINAL_BLOCK, "      cwd: agent.cwd, stdio: ['pipe','pipe','pipe'],\n    });"),
  });
  const unexpectedBefore = fs.readFileSync(unexpectedSpawn.runtimePath);
  result = runPatch(unexpectedSpawn.home);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected layout: expected exactly one Runtime spawn option block, found 0/);
  assert.ok(fs.readFileSync(unexpectedSpawn.runtimePath).equals(unexpectedBefore));
  assert.equal(listBackups(unexpectedSpawn.home).length, 0);
});
