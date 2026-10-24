import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {resolveOwnedGatewayBootstrap, observeOwnedGatewayBackend, assertGatewayBackendReady, armOrReuseApiBootstrap} from '../scripts/native-api-bootstrap-gate.mjs';
import {prepareGatewayDispatch, resolveNativeAgent} from '../scripts/native-agent.mjs';
import {NativeTasks} from '../scripts/native-state.mjs';
import {discoverApplyCompatibleRuntime} from '../scripts/native-api-install.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'native-api-bootstrap-gate-'));
try {
  const codexHome = path.join(root, 'codex-home');
  const runtimeRoot = path.join(codexHome, 'router-runtime');
  const runtimeDir = path.join(runtimeRoot, 'versions', 'approved-v1');
  const bootstrapPath = path.join(runtimeRoot, 'bootstrap', 'owned.exe');
  const profileId = 'abcdefabcdefabcdefabcdef';
  const receipt = {schemaVersion: 1, patchedPath: path.join(runtimeDir, 'codex.exe'), patchedSha256: 'a'.repeat(64), compatibility: {status: 'passed', probe: 'app-server-initialize', cliVersion: 'test-version'}};
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  const bootstrapBytes = Buffer.from('owned bootstrap');
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const generic = {
    owner: 'sol-luna-native-api-bootstrap', schemaVersion: 1, phase: 'applied',
    runtime: {version: 'test-version', sourceCommit: 'test-source', patchSha256: 'test-patch', binarySha256: 'a'.repeat(64)},
    paths: {maintenanceRoot: runtimeRoot, runtimeDir, bootstrapPath, receiptPath: path.join(runtimeRoot, 'compatibility.json')},
    environment: {next: {CODEX_CLI_PATH: {present: true, value: bootstrapPath}}},
    receiptFile: {path: path.join(runtimeRoot, 'compatibility.json'), deployedSha256: digest(receiptBytes)},
    bootstrapFile: {deployedSha256: digest(bootstrapBytes)},
  };
  const env = {CODEX_HOME: codexHome, CODEX_CLI_PATH: bootstrapPath};
  await mkdir(path.dirname(generic.paths.receiptPath), {recursive: true});
  await writeFile(generic.paths.receiptPath, receiptBytes);
  await mkdir(runtimeDir, {recursive: true});
  await mkdir(path.dirname(bootstrapPath), {recursive: true});
  await writeFile(bootstrapPath, bootstrapBytes);
  await writeFile(path.join(runtimeDir, 'codex.exe'), 'approved runtime');
  const genericJournalPath = path.join(runtimeRoot, 'bootstrap-install.json');
  await writeFile(genericJournalPath, JSON.stringify(generic));

  const verifyRuntimeVersion = async dir => ({exePath: path.join(dir, 'codex.exe'), manifest: {binary_sha256: 'a'.repeat(64), version: 'test-version', source_commit: 'test-source', patch_sha256: 'test-patch'}});
  const resolved = await resolveOwnedGatewayBootstrap({executor: 'api', profileId, env, apiDir: path.join(root, 'api'), verifyRuntimeVersion});
  assert.equal(resolved.runtimeDir, runtimeDir, 'API dispatch resolves only the owned persistent runtime from generic journal');
  assert.equal(resolved.bootstrapPath, bootstrapPath, 'API dispatch uses the exact owned bootstrap path');

  let observed = 0;
  const approval = await observeOwnedGatewayBackend({executor: 'api', profileId, env, apiDir: path.join(root, 'api'),
    verifyRuntimeVersion,
    observer: async ({bootstrapPath: actualBootstrap, runtimeDir: actualRuntime}) => {
      observed += 1;
      assert.equal(actualBootstrap, bootstrapPath);
      assert.equal(actualRuntime, runtimeDir);
      return {state: 'running-approved', restartRequired: false};
    },
  });
  assert.equal(approval.state, 'running-approved', 'exact owned journal and receipt permit observation of running backend');
  assert.equal(observed, 1, 'valid API dispatch reaches the observer once');

  await writeFile(genericJournalPath, JSON.stringify({...generic, owner: 'foreign'}));
  await assert.rejects(resolveOwnedGatewayBootstrap({executor: 'api', profileId, env, apiDir: path.join(root, 'api'), verifyRuntimeVersion}), /ownership|owned/i);
  await writeFile(genericJournalPath, JSON.stringify(generic));
  await writeFile(generic.paths.receiptPath, '{broken');
  const beforeMissingReceipt = observed;
  await assert.rejects(observeOwnedGatewayBackend({executor: 'api', profileId, env, apiDir: path.join(root, 'api'), verifyRuntimeVersion, observer: async () => { observed += 1; }}), /receipt/i);
  assert.equal(observed, beforeMissingReceipt, 'invalid receipt refuses before consulting the backend observer');
  await writeFile(generic.paths.receiptPath, JSON.stringify(receipt));

  const stateDir = path.join(root, 'tasks');
  const tasks = new NativeTasks({stateDir});
  let spawnAllowed = false;
  await assert.rejects(prepareGatewayDispatch({
    result: {resolved_model: 'mock-api-model', agent_type: 'native_api_fixture'}, executor: 'api', profileId,
    taskNonce: 'observer-restart-required-01', parentThreadId: 'parent', tasks,
    ensureReady: async () => {
      await assertGatewayBackendReady({executor: 'api', profileId, env, apiDir: path.join(root, 'api'),
        verifyRuntimeVersion,
        observer: async () => ({state: 'restart-required', restartRequired: true, reason: 'stock host'}),
      });
      spawnAllowed = true;
    },
  }), /重启 Codex/);
  assert.equal(spawnAllowed, false, 'stock/old host cannot yield spawn metadata');
  assert.equal(await tasks.hasActiveGatewayExecutions(), false, 'failed observer cancels the gateway intent');

  let armCalls = 0;
  const armedHome = path.join(root, 'new-codex-home');
  const armedRuntime = path.join(armedHome, 'router-runtime', 'versions', 'approved-v1');
  await mkdir(armedRuntime, {recursive: true});
  const armed = await armOrReuseApiBootstrap({runtimeDir: armedRuntime, codexHome: armedHome, env: {CODEX_HOME: armedHome},
    verifyRuntimeVersion,
    adapter: {get: async () => ({present: false, value: null}), set: async () => {throw new Error('test adapter must not write');}},
    arm: async options => { armCalls += 1; assert.equal(options.runtimeRoot, path.join(armedHome, 'router-runtime')); return {state: 'armed', restartRequired: true, ready: false}; },
  });
  assert.equal(armed.reused, false, 'explicit Apply arms a new owned bootstrap when the journal is absent');
  assert.equal(armCalls, 1, 'new explicit Apply reaches the approved maintenance arm seam once');
  const discovered = await discoverApplyCompatibleRuntime({codexHome: armedHome, verifyRuntime: async dir => ({exePath: path.join(dir, 'codex.exe')})});
  assert.equal(discovered.versionDir, armedRuntime, 'Apply discovers an approved artifact only under the persistent CODEX_HOME runtime root');
  const absent = await discoverApplyCompatibleRuntime({codexHome: path.join(root, 'no-runtime-home')});
  assert.equal(absent.versionDir, null, 'Apply refuses when the approved persistent runtime is absent');
  await assert.rejects(armOrReuseApiBootstrap({runtimeDir, codexHome: armedHome, env: {CODEX_HOME: armedHome}, arm: async () => {armCalls += 1;}}), /router-runtime\/versions/);
  assert.equal(armCalls, 1, 'runtime outside the managed CODEX_HOME root cannot arm');

  const reused = await armOrReuseApiBootstrap({runtimeDir, codexHome, env, verifyRuntimeVersion,
    adapter: {get: async () => ({present: true, value: bootstrapPath}), set: async () => {throw new Error('reuse must not write');}},
    arm: async () => {armCalls += 1; throw new Error('existing owned bootstrap must be reused');},
  });
  assert.equal(reused.reused, true, 'repeated Apply reuses a verified owned bootstrap');
  assert.equal(armCalls, 1, 'repeated Apply does not collide with or rewrite the owned journal');

  const legacyHome = path.join(root, 'legacy-home');
  const legacyRoot = path.join(legacyHome, 'router-runtime');
  const legacyRuntime = path.join(legacyRoot, 'versions', 'legacy-v1');
  const legacyBootstrap = path.join(legacyRoot, 'bootstrap', 'legacy-bootstrap.exe');
  const legacyJournalPath = path.join(legacyHome, 'deepseek', 'install.json');
  await mkdir(legacyRuntime, {recursive: true});
  await mkdir(path.dirname(legacyBootstrap), {recursive: true});
  await mkdir(path.dirname(legacyJournalPath), {recursive: true});
  await writeFile(legacyBootstrap, 'legacy owned bootstrap');
  const legacyReceipt = {...receipt, patchedPath: path.join(legacyRuntime, 'codex.exe')};
  await writeFile(path.join(legacyRoot, 'compatibility.json'), JSON.stringify(legacyReceipt));
  assert.equal(JSON.parse(await readFile(path.join(legacyRoot, 'compatibility.json'), 'utf8')).patchedPath, path.join(legacyRuntime, 'codex.exe'));
  const legacyJournal = {phase: 'active', completed: {environment: true},
    paths: {journalPath: legacyJournalPath, codexHome: legacyHome, versionDir: legacyRuntime},
    environmentSnapshot: {next: {CODEX_CLI_PATH: {present: true, value: legacyBootstrap}}}};
  await writeFile(legacyJournalPath, JSON.stringify(legacyJournal));
  const legacy = await resolveOwnedGatewayBootstrap({executor: 'deepseek', env: {CODEX_HOME: legacyHome, SOL_LUNA_NATIVE_INSTALL_JOURNAL: legacyJournalPath},
    readDeepseekJournal: async () => legacyJournal, verifyRuntimeVersion: async dir => ({exePath: path.join(dir, 'codex.exe'), manifest: {binary_sha256: 'a'.repeat(64), version: 'test-version'}})});
  assert.equal(legacy.source, 'legacy-deepseek', 'active formal legacy journal is recognized only with the matching root receipt');
  await rm(path.join(legacyRoot, 'compatibility.json'));
  await assert.rejects(resolveOwnedGatewayBootstrap({executor: 'deepseek', env: {CODEX_HOME: legacyHome, SOL_LUNA_NATIVE_INSTALL_JOURNAL: legacyJournalPath},
    readDeepseekJournal: async () => legacyJournal, verifyRuntimeVersion: async dir => ({exePath: path.join(dir, 'codex.exe'), manifest: {binary_sha256: 'a'.repeat(64), version: 'test-version'}})}), /compatibility receipt|receipt/i);

  const nativeRoutes = [
    resolveNativeAgent({executor: 'luna', mainModel: 'gpt-6.1-sol', models: ['gpt-6-luna']}),
    resolveNativeAgent({executor: 'same', mainModel: 'gpt-6.1-sol'}),
    resolveNativeAgent({executor: 'native:gpt-6-luna', models: ['gpt-6-luna']}),
  ];
  assert.deepEqual(nativeRoutes.map(route => route.model), ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-luna'], 'native model routes do not use or require gateway readiness');
} finally {
  await rm(root, {recursive: true, force: true});
}

console.log('native API bootstrap gate integration tests passed');
