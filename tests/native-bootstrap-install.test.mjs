import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyBootstrapEnvironment, planBootstrapEnvironment, rollbackBootstrapEnvironment } from '../scripts/native-bootstrap-install.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'bootstrap-environment-test-'));
try {
  const bootstrapPath = path.join(root, 'native launcher.exe');
  const journalPath = path.join(root, 'router-runtime', 'install.json');
  await mkdir(path.dirname(journalPath), { recursive: true });
  await writeFile(bootstrapPath, 'test native exe bytes');
  const officialPath = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
  const env = new Map([
    ['CODEX_CLI_PATH', { present: true, value: officialPath }],
    ['SOL_LUNA_NATIVE_PLAINTEXT_V2', { present: false, value: null }],
    ['SOL_LUNA_NATIVE_INSTALL_JOURNAL', { present: false, value: null }],
  ]);
  const adapter = { async get(k) { return env.get(k); }, async set(k, v) { env.set(k, v); } };
  const plan = await planBootstrapEnvironment({ bootstrapPath, currentEnvironment: Object.fromEntries(env), journalPath });
  assert.equal(plan.prior.CODEX_CLI_PATH.value, officialPath, 'the installed WindowsApps CLI is retained as the prior value');
  assert.equal(plan.next.CODEX_CLI_PATH.value, bootstrapPath, 'new installs point only to the native bootstrap');
  const snapshot = await applyBootstrapEnvironment(plan, adapter);
  assert.equal(env.get('CODEX_CLI_PATH').value, bootstrapPath);
  await rollbackBootstrapEnvironment(snapshot, adapter, { isRegularFile: async () => true });
  assert.equal(env.get('CODEX_CLI_PATH').value, officialPath, 'CAS rollback restores the original official CLI path');

  const userOwned = await planBootstrapEnvironment({ bootstrapPath, currentEnvironment: { CODEX_CLI_PATH: 'C:\\Tools\\private-codex.exe' }, journalPath }).then(() => null, (error) => error);
  assert.match(userOwned?.message ?? '', /user-managed backend/i, 'a manual nonowned CODEX_CLI_PATH is never overwritten');
  const changed = await planBootstrapEnvironment({ bootstrapPath, currentEnvironment: Object.fromEntries(env), journalPath });
  const applied = await applyBootstrapEnvironment(changed, adapter);
  env.set('CODEX_CLI_PATH', { present: true, value: 'C:\\Tools\\new-user-value.exe' });
  await assert.rejects(() => rollbackBootstrapEnvironment(applied, adapter), /environment changed since bootstrap apply/);
  assert.equal(env.get('CODEX_CLI_PATH').value, 'C:\\Tools\\new-user-value.exe', 'rollback preserves later user edits');
  const source = path.join(root, 'plugin source.exe');
  const persistent = path.join(root, 'codex-home', 'router-runtime', 'bootstrap', 'abc123.exe');
  await writeFile(source, 'versioned native bootstrap');
  env.set('CODEX_CLI_PATH', { present: true, value: officialPath });
  const persistentPlan = await planBootstrapEnvironment({ bootstrapPath: persistent, bootstrapSourcePath: source, currentEnvironment: Object.fromEntries(env), journalPath });
  const deployed = await applyBootstrapEnvironment(persistentPlan, adapter);
  assert.equal(await readFile(persistent, 'utf8'), 'versioned native bootstrap', 'installer stages bootstrap under persistent CODEX_HOME runtime');
  await rollbackBootstrapEnvironment(deployed, adapter);
  await assert.rejects(() => readFile(persistent), { code: 'ENOENT' }, 'CAS rollback removes only the bootstrap it deployed');

  const movedOldPath = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
  const movedNewPath = 'D:\\Apps\\WindowsApps\\OpenAI.Codex_26.1024.5000.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe';
  env.set('CODEX_CLI_PATH', { present: true, value: movedOldPath });
  const movedPlan = await planBootstrapEnvironment({ bootstrapPath, currentEnvironment: Object.fromEntries(env), journalPath });
  const movedSnapshot = await applyBootstrapEnvironment(movedPlan, adapter);
  await rollbackBootstrapEnvironment(movedSnapshot, adapter, {
    isRegularFile: async (candidate) => candidate === movedNewPath,
    resolveCurrentOfficialPath: async () => movedNewPath,
  });
  assert.equal(env.get('CODEX_CLI_PATH').value, movedNewPath, 'rollback resolves the currently registered official package when the prior package moved');

  env.set('CODEX_CLI_PATH', { present: true, value: movedOldPath });
  const missingPlan = await planBootstrapEnvironment({ bootstrapPath, currentEnvironment: Object.fromEntries(env), journalPath });
  const missingSnapshot = await applyBootstrapEnvironment(missingPlan, adapter);
  await rollbackBootstrapEnvironment(missingSnapshot, adapter, { isRegularFile: async () => false });
  assert.deepEqual(env.get('CODEX_CLI_PATH'), { present: false, value: null }, 'rollback unsets its owned override instead of restoring a removed package path');
  console.log('PASS bootstrap environment ownership, prior snapshot and CAS rollback');
} finally {
  await rm(root, { recursive: true, force: true });
}
