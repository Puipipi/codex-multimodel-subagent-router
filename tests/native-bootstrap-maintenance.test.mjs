import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { armApiBootstrap, disarmOwnedBootstrap, observeApiBackend } from '../scripts/native-bootstrap-maintenance.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'native-bootstrap-maintenance-test-'));
try {
  const officialPath = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
  const runtimeDir = path.join(root, 'runtime', 'versions', 'approved');
  const bootstrapSourcePath = path.join(root, 'bootstrap-source.exe');
  const journalPath = path.join(root, 'runtime', 'bootstrap-install.json');
  await writeFile(bootstrapSourcePath, 'approved bootstrap fixture');
  await mkdir(runtimeDir, { recursive: true });
  const manifest = { version: '0.164.0-alpha.11.1', source_commit: '6905ecede7816e91373e9eabda3f6b0368fc747b', patch_sha256: '87007c7188d32b7e4c4cd45cb86fbf41fa122fc48a998d99ab2f2536ce73100d', target: 'x86_64-pc-windows-msvc', stock_cli_version: '0.164.0-alpha.11.1', binary_sha256: 'a'.repeat(64), files: { 'codex.exe': 'a'.repeat(64) } };
  const verified = { exePath: path.join(runtimeDir, 'codex.exe'), manifest };
  const capability = { schemaVersion: 1, testBuild: false, runtimeVersion: manifest.version, sourceCommit: manifest.source_commit, approvedPatchHashes: [manifest.patch_sha256] };
  const current = new Map([
    ['CODEX_CLI_PATH', { present: false, value: null }],
    ['SOL_LUNA_NATIVE_PLAINTEXT_V2', { present: false, value: null }],
  ]);
  let writes = 0;
  let failCliAfterWrite = false;
  const adapter = {
    async get(key) { return current.get(key); },
    async set(key, value) {
      writes += 1;
      current.set(key, value);
      if (failCliAfterWrite && key === 'CODEX_CLI_PATH' && value.present) throw new Error('injected env failure');
    },
  };
  const runBootstrap = async (_exe, mode) => {
    if (mode === '--bootstrap-capabilities') return capability;
    if (mode === '--bootstrap-resolve-official-cli') return { exePath: officialPath };
    if (mode === '--bootstrap-observe-backend') return { schemaVersion: 1, observed: true, exePath: officialPath, exeSha256: 'b'.repeat(64) };
    throw new Error(`unexpected bootstrap mode ${mode}`);
  };
  const common = {
    bootstrapPath: bootstrapSourcePath,
    runtimeDir,
    verifyRuntimeVersion: async () => verified,
    runBootstrap,
  };

  const stock = await observeApiBackend({ ...common, hashFile: async () => 'b'.repeat(64), runBootstrap: async (_exe, mode) => mode === '--bootstrap-capabilities' ? capability : { schemaVersion: 1, observed: true, exePath: officialPath, exeSha256: 'b'.repeat(64) } });
  assert.equal(stock.state, 'restart-required', 'stock ancestor reports restart required rather than API ready');
  assert.equal(stock.restartRequired, true);
  const active = await observeApiBackend({ ...common, hashFile: async () => manifest.binary_sha256, runBootstrap: async (_exe, mode) => mode === '--bootstrap-capabilities' ? capability : { schemaVersion: 1, observed: true, exePath: verified.exePath, exeSha256: manifest.binary_sha256 } });
  assert.equal(active.state, 'running-approved', 'only the exact approved binary in the live ancestor chain is ready');

  const emptyAllowlist = await observeApiBackend({ ...common, runBootstrap: async () => ({ ...capability, approvedPatchHashes: [] }) });
  assert.equal(emptyAllowlist.state, 'unavailable', 'bootstrap without approved patch capability is rejected');
  writes = 0;
  await assert.rejects(() => armApiBootstrap({ ...common, bootstrapSourcePath, runtimeRoot: path.join(root, 'runtime'), journalPath, adapter, runBootstrap: async () => ({ ...capability, approvedPatchHashes: [] }) }), /does not approve/i);
  assert.equal(writes, 0, 'empty allowlist refuses before writing user environment');
  await assert.rejects(() => armApiBootstrap({ ...common, bootstrapSourcePath, runtimeRoot: path.join(root, 'runtime'), journalPath, adapter, verifyRuntimeVersion: async () => { throw new Error('provenance rejected'); } }), /provenance rejected/);
  assert.equal(writes, 0, 'invalid runtime provenance refuses before writing user environment');

  const writeReceipt = async (args) => {
    await writeFile(args.receiptPath, JSON.stringify({ schemaVersion: 1, officialSha256: 'c'.repeat(64), officialVersion: manifest.version, desktopPackageVersion: '26.1021.3705.0', patchedPath: verified.exePath, patchedSha256: manifest.binary_sha256, compatibility: { status: 'passed', probe: 'app-server-initialize', cliVersion: manifest.version } }));
    return { status: 'passed', probe: 'app-server-initialize', cliVersion: manifest.version };
  };
  const success = await armApiBootstrap({
    ...common, bootstrapSourcePath, runtimeRoot: path.join(root, 'runtime'), journalPath, adapter,
    readCodexCliVersion: () => manifest.version,
    readDesktopPackageVersion: () => '26.1021.3705.0',
    hashFile: async (file) => file === verified.exePath ? manifest.binary_sha256 : 'c'.repeat(64),
    probeAndWriteCompatibilityReceipt: writeReceipt,
  });
  assert.equal(success.state, 'armed');
  assert.equal(success.restartRequired, true, 'arming from a maintenance/MCP process never claims the model host already uses the new backend');
  assert.equal(current.get('CODEX_CLI_PATH').value, success.bootstrapPath);
  assert.equal(current.has('SOL_LUNA_NATIVE_INSTALL_JOURNAL'), false, 'API bootstrap does not write the legacy DeepSeek journal');
  assert.deepEqual(current.get('SOL_LUNA_NATIVE_PLAINTEXT_V2'), { present: false, value: null }, 'API bootstrap maintenance only owns CODEX_CLI_PATH');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(journal.owner, 'sol-luna-native-api-bootstrap');
  assert.equal(journal.schemaVersion, 1);
  assert.equal(journal.phase, 'applied');

  const manualValue = { present: true, value: 'D:\\Tools\\manual-codex.exe' };
  current.set('CODEX_CLI_PATH', manualValue);
  const disarmConflict = await disarmOwnedBootstrap({ journalPath, adapter });
  assert.equal(disarmConflict.disarmed, false, 'off preserves a later user-owned environment edit');
  assert.deepEqual(current.get('CODEX_CLI_PATH'), manualValue);
  current.set('CODEX_CLI_PATH', journal.environment.next.CODEX_CLI_PATH);
  assert.equal((await disarmOwnedBootstrap({ journalPath, adapter })).disarmed, true);
  assert.deepEqual(current.get('CODEX_CLI_PATH'), { present: false, value: null });

  current.set('CODEX_CLI_PATH', { present: true, value: officialPath });
  failCliAfterWrite = true;
  const failureRoot = path.join(root, 'runtime');
  const failureJournal = journalPath;
  await assert.rejects(() => armApiBootstrap({
    ...common, bootstrapSourcePath, runtimeRoot: failureRoot, journalPath: failureJournal, adapter,
    readCodexCliVersion: () => manifest.version,
    readDesktopPackageVersion: () => '26.1021.3705.0',
    hashFile: async (file) => file === verified.exePath ? manifest.binary_sha256 : 'c'.repeat(64),
    probeAndWriteCompatibilityReceipt: writeReceipt,
  }), /injected env failure/);
  assert.deepEqual(current.get('CODEX_CLI_PATH'), { present: false, value: null }, 'failed application clears a restored WindowsApps prior pin instead of leaving the old kernel selected');
  assert.equal(await readFile(failureJournal, 'utf8').then(() => true, () => false), false, 'failed transaction removes its prepared journal after rollback');
  assert.deepEqual(await readdir(path.join(failureRoot, 'bootstrap')).catch(() => []), [], 'failed transaction removes its newly deployed owned bootstrap file');
  console.log('PASS API bootstrap maintenance state, capability gate, CAS and rollback seams');
} finally {
  await rm(root, { recursive: true, force: true });
}
