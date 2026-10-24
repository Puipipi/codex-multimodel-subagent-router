import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(path.join(os.tmpdir(), 'native-bootstrap-test-'));
const repo = fileURLToPath(new URL('..', import.meta.url));
const gcc = 'C:/Program Files/mingw64/bin/gcc.exe';
const backend = path.join(root, 'fake backend.exe');
const patched = path.join(root, 'fake patched backend.exe');
const harness = path.join(root, 'codex bootstrap harness.exe');
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
  const fallback = spawnSync(harness, ['app-server', '--listen', 'ws://127.0.0.1:43123'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
    env: { ...process.env, CODEX_BOOTSTRAP_TEST_OFFICIAL: backend, CODEX_BOOTSTRAP_TEST_PACKAGE_VERSION: '26.1021.3705.0', CODEX_BOOTSTRAP_TEST_RUNTIME_ROOT: runtime, CODEX_HOME: root, FAKE_EXIT_CODE: '23', PATCH_MARKER: path.join(root, 'patch-started.marker') },
  });
  assert.equal(fallback.status, 23, fallback.stderr);
  assert.equal(fallback.stdout, 'argc=4|app-server|--listen|ws://127.0.0.1:43123|', 'an early patched startup error falls back to the exact official CLI and forwards the original handshake arguments');
  assert.equal((await readFile(path.join(root, 'patch-started.marker'), 'utf8')), 'started', 'native bootstrap selected the exactly approved patched backend before it failed');
  const status = JSON.parse(await readFile(path.join(runtime, 'upgrade-status.json'), 'utf8'));
  assert.equal(status.state, 'disabled', 'startup fallback degrades child routing while the official CLI stays available');
  assert.match(status.reason, /兼容补丁/);
  console.log('PASS native bootstrap: hidden GUI executable, argv/stdio/exit, exact patch receipt, bounded startup fallback');
} finally {
  await rm(root, { recursive: true, force: true });
}





