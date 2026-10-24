import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(path.join(os.tmpdir(), 'native-bootstrap-test-'));
const repo = fileURLToPath(new URL('..', import.meta.url));
const gcc = 'C:/Program Files/mingw64/bin/gcc.exe';
const backend = path.join(root, 'fake backend.exe');
const patched = path.join(root, 'fake patched backend.exe');
const harness = path.join(root, 'codex bootstrap harness.exe');
const release = path.join(root, 'codex bootstrap release.exe');
const runtime = path.join(root, 'runtime with spaces');
try {
  await mkdir(runtime, { recursive: true });
  const build = (args) => spawnSync(gcc, args, { encoding: 'utf8', windowsHide: true });
  let result = build(['-municode', '-mconsole', path.join(repo, 'tests', 'native-bootstrap-fake-backend.c'), '-o', backend]);
  assert.equal(result.status, 0, result.stderr);
  result = build(['-DPATCHED_FAKE', '-municode', '-mconsole', path.join(repo, 'tests', 'native-bootstrap-fake-backend.c'), '-o', patched]);
  assert.equal(result.status, 0, result.stderr);
  const patchedSha256 = createHash('sha256').update(await readFile(patched)).digest('hex');
  result = build([`-DAPPROVED_PATCH_SHA256=\"${patchedSha256}\"`, '-DTEST_HARNESS', '-municode', '-mwindows', '-O2', path.join(repo, 'native', 'bootstrap', 'bootstrap.c'), '-o', harness, '-lbcrypt', '-lshell32']);
  assert.equal(result.status, 0, result.stderr);
  result = build(['-municode', '-mwindows', '-O2', path.join(repo, 'native', 'bootstrap', 'bootstrap.c'), '-o', release, '-lbcrypt', '-lshell32']);
  assert.equal(result.status, 0, result.stderr);
  const releaseStrings = (await readFile(release)).toString('latin1');
  assert.doesNotMatch(releaseStrings, /CODEX_BOOTSTRAP_TEST_(?:OFFICIAL|PARENT_IMAGE)/, 'release build excludes all test-only backend/parent bypasses');

  const packageRoot = path.join(root, 'test package', 'WindowsApps', 'OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0', 'app');
  const parentImage = path.join(packageRoot, 'Codex.exe');
  const packageCli = path.join(packageRoot, 'resources', 'codex.exe');
  await mkdir(path.dirname(packageCli), { recursive: true });
  await copyFile(backend, packageCli);
  await copyFile(backend, parentImage);
  const parentProbe = spawnSync(harness, [], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_BOOTSTRAP_TEST_PARENT_IMAGE: parentImage } });
  assert.equal(parentProbe.status, 0, parentProbe.stderr);
  assert.equal(parentProbe.stdout, `package=26.1021.3705.0|exe=${packageCli}`, 'test-only injected desktop image metadata resolves the matching packaged official CLI');

  const original = spawnSync(harness, ['argument with spaces', '中文路径'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
    env: { ...process.env, CODEX_BOOTSTRAP_TEST_OFFICIAL: backend, CODEX_BOOTSTRAP_TEST_PACKAGE_VERSION: '26.1021.3705.0', CODEX_BOOTSTRAP_TEST_RUNTIME_ROOT: runtime, CODEX_HOME: root, FAKE_EXIT_CODE: '23', PATCH_MARKER: path.join(root, 'patch-started.marker') },
  });
  assert.equal(original.status, 23, original.stderr);
  assert.equal(original.stdout, 'argc=3|argument with spaces|中文路径|', 'native bootstrap preserves arguments and stdout without protocol text');
  assert.equal(original.stderr, '', 'native bootstrap keeps diagnostics off stderr');

  const officialSha256 = createHash('sha256').update(await readFile(backend)).digest('hex');
  await writeFile(path.join(runtime, 'codex-patched.exe'), await readFile(patched));
  await writeFile(path.join(runtime, 'compatibility.json'), JSON.stringify({
    schemaVersion: 1, officialSha256, officialVersion: '0.164.0-alpha.11.1', desktopPackageVersion: '26.1021.3705.0',
    patchedPath: path.join(runtime, 'codex-patched.exe'), patchedSha256,
    compatibility: { status: 'passed', probe: 'app-server-initialize', cliVersion: '0.164.0-alpha.11.1' },
  }));
  const request = '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}\n{"id":2,"method":"config/read","params":{"includeLayers":true}}\n';
  const officialResponse = '{"id":1,"result":{"userAgent":"official"}}\n{"id":2,"result":{"config":{}}}\n';
  for (const mode of ['exit', 'garbage', 'malformed', 'hang', 'error', 'wrong-version']) {
    const started = Date.now();
    const fallback = spawnSync(harness, ['app-server'], {
      input: request, encoding: 'utf8', windowsHide: true, timeout: 7000,
      env: { ...process.env, CODEX_BOOTSTRAP_TEST_OFFICIAL: backend, CODEX_BOOTSTRAP_TEST_PACKAGE_VERSION: '26.1021.3705.0', CODEX_BOOTSTRAP_TEST_RUNTIME_ROOT: runtime, CODEX_HOME: root, PATCHED_MODE: mode, PATCH_MARKER: path.join(root, 'patch-started.marker'), PROBE_HOME_MARKER: path.join(root, 'probe-home.txt') },
    });
    assert.equal(fallback.status, 0, `${mode}: ${fallback.stderr}`);
    assert.equal(fallback.stdout.replaceAll('\r\n', '\n'), officialResponse, `${mode} probe must not consume the desktop requests or leak patched stdout`);
    assert.equal(fallback.stderr, '', `${mode} probe must not leak diagnostics to desktop stderr`);
    assert.ok(Date.now() - started < 5000, `${mode} probe must be bounded`);
    const status = JSON.parse(await readFile(path.join(runtime, 'upgrade-status.json'), 'utf8'));
    assert.equal(status.state, 'disabled', `${mode} failure disables child routing`);
  }
  const healthy = spawnSync(harness, ['app-server'], {
    input: request, encoding: 'utf8', windowsHide: true, timeout: 7000,
    env: { ...process.env, CODEX_BOOTSTRAP_TEST_OFFICIAL: backend, CODEX_BOOTSTRAP_TEST_PACKAGE_VERSION: '26.1021.3705.0', CODEX_BOOTSTRAP_TEST_RUNTIME_ROOT: runtime, CODEX_HOME: root, PATCHED_MODE: 'success', PATCH_MARKER: path.join(root, 'patch-started.marker'), PROBE_HOME_MARKER: path.join(root, 'probe-home.txt') },
  });
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.equal(healthy.stdout.replaceAll('\r\n', '\n'), '{"id":1,"result":{"origin":"patched"}}\n{"id":2,"result":{"config":{}}}\n', 'successful isolated initialize/config-read probe selects patched CLI for untouched desktop stream');
  assert.ok((await readFile(path.join(root, 'probe-home.txt'), 'utf8')).startsWith(os.tmpdir()), 'preflight reads only a throwaway CODEX_HOME');
  const liveFailure = spawnSync(harness, ['app-server'], {
    input: request, encoding: 'utf8', windowsHide: true, timeout: 7000,
    env: { ...process.env, CODEX_BOOTSTRAP_TEST_OFFICIAL: backend, CODEX_BOOTSTRAP_TEST_PACKAGE_VERSION: '26.1021.3705.0', CODEX_BOOTSTRAP_TEST_RUNTIME_ROOT: runtime, CODEX_HOME: root, PATCHED_MODE: 'live-exit', PATCH_MARKER: path.join(root, 'patch-started.marker'), PROBE_HOME_MARKER: path.join(root, 'probe-home.txt') },
  });
  assert.equal(liveFailure.status, 2, 'a failure after successful probe exits normally instead of replaying requests to official');
  assert.equal(liveFailure.stdout.replaceAll('\r\n', '\n'), 'patched stream already consumed\n', 'formal patched stream is never followed by an official duplicate response');
  assert.equal(JSON.parse(await readFile(path.join(runtime, 'upgrade-status.json'), 'utf8')).state, 'disabled', 'late process failure disables future child routing');
  assert.equal((await readFile(path.join(root, 'patch-started.marker'), 'utf8')).trim().split(/\r?\n/).length, 10, 'failed probes never start a formal patched process; only healthy probes do');
  console.log('PASS native bootstrap: isolated app-server probe, clean official fallback, untouched desktop request');
} finally {
  await rm(root, { recursive: true, force: true });
}





