// Real cross-process checks for the durable ownership store and workspace
// writer leases. Every worker is spawned hidden and writes one small JSON
// result, so these assertions do not depend on in-process shared memory.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  OwnershipStore, WorkspaceLeases, canonicalWorkspace, hashThread,
} from '../scripts/plugin-state.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const workerPath = path.join(repoRoot, 'tests', 'fixtures', 'plugin-state-worker.mjs');
const root = await mkdtemp(path.join(os.tmpdir(), 'sol-plugin-cross-process-'));
const requests = path.join(root, 'requests');
const results = path.join(root, 'results');
await mkdir(requests, {recursive: true});
await mkdir(results, {recursive: true});

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const deepEqual = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1; };
const match = (value, pattern, message) => { assert.match(value, pattern, message); checks += 1; };

async function rejects(promise, pattern, message) {
  try {
    await promise;
  } catch (error) {
    assert.match(error.message, pattern, message);
    checks += 1;
    return;
  }
  throw new Error(`expected rejection: ${message}`);
}

let sequence = 0;
function workerId() {
  sequence += 1;
  return `${process.pid}-${sequence}`;
}

async function startWorker(request, {timeoutMs = 30000} = {}) {
  const id = workerId();
  const requestPath = path.join(requests, `${id}.json`);
  const resultPath = path.join(results, `${id}.json`);
  await writeFile(requestPath, JSON.stringify(request), 'utf8');
  const child = spawn(process.execPath, [workerPath, requestPath, resultPath], {
    stdio: 'ignore',
    windowsHide: true,
  });
  let timer;
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve({code, signal});
      else reject(new Error(`worker ${id} exited ${code ?? signal ?? 'unknown'}`));
    });
    timer = setTimeout(() => {
      child.kill();
      reject(new Error(`worker ${id} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  done.finally(() => clearTimeout(timer)).catch(() => {});
  return {id, child, done, resultPath};
}

async function resultOf(job) {
  await job.done;
  const raw = await readFile(job.resultPath, 'utf8');
  return JSON.parse(raw);
}

async function waitForResult(file, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(file)) {
      try {
        return JSON.parse(await readFile(file, 'utf8'));
      } catch { /* The worker may still be replacing the file. */ }
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function runBarrier(requestsForWorkers) {
  const barrier = path.join(root, `barrier-${workerId()}`);
  const jobs = [];
  for (const request of requestsForWorkers) jobs.push(await startWorker({...request, barrier}));
  await writeFile(barrier, 'go', 'utf8');
  return Promise.all(jobs.map(resultOf));
}

try {
  {
    const stateDir = path.join(root, 'state-claims');
    const owners = 4;
    const count = 12;
    const resultsForClaims = await runBarrier(Array.from({length: count}, (_, index) => ({
      action: 'claim',
      stateDir,
      agentId: `OWN${index}`,
      threadId: `claim-owner-${index % owners}`,
    })));
    equal(resultsForClaims.filter(result => result.ok).length, count, 'all independent claims succeed across processes');
    const snapshot = await new OwnershipStore({stateDir}).snapshot();
    equal(Object.keys(snapshot.agents).length, count, 'every cross-process claim survives the durable read-modify-write');
    for (const result of resultsForClaims) {
      equal(snapshot.agents[result.agent_id].owner, hashThread(result.threadId), `owner hash is preserved for ${result.agent_id}`);
    }
    const raw = await readFile(path.join(stateDir, 'ownership.json'), 'utf8');
    match(raw, /[a-f0-9]{64}/, 'the ownership store contains hashed owners');
    ok(!raw.includes('claim-owner-'), 'raw chat ids never reach the ownership store');
    deepEqual((await new OwnershipStore({stateDir}).owned('claim-owner-2')).length, 3, 'one owner keeps exactly its own durable rows');
  }

  {
    const stateDir = path.join(root, 'state-same-agent');
    const resultsForClaims = await runBarrier(Array.from({length: 10}, (_, index) => ({
      action: 'claim',
      stateDir,
      agentId: 'SAME',
      threadId: `same-owner-${index}`,
    })));
    const winners = resultsForClaims.filter(result => result.ok);
    const losers = resultsForClaims.filter(result => !result.ok);
    equal(winners.length, 1, 'only one cross-process owner can claim the same agent id');
    equal(losers.length, 9, 'the other cross-process claims are rejected');
    for (const loser of losers) match(loser.error, /not available to this chat/, 'a losing owner receives the ownership error');
    const snapshot = await new OwnershipStore({stateDir}).snapshot();
    equal(snapshot.agents.SAME.owner, hashThread(winners[0].threadId), 'the winning owner is the durable owner');
    equal(snapshot.agents.SAME.owner, winners[0].owner, 'the durable owner matches the winner result');
  }

  {
    const stateDir = path.join(root, 'state-lease-race');
    const workspace = path.join(root, 'workspace-lease-race');
    await mkdir(workspace, {recursive: true});
    const resultsForLeases = await runBarrier(Array.from({length: 10}, (_, index) => ({
      action: 'lease',
      stateDir,
      workspace,
      agentId: `L${index}`,
      threadId: `lease-owner-${index % 4}`,
    })));
    const winners = resultsForLeases.filter(result => result.ok);
    const losers = resultsForLeases.filter(result => !result.ok);
    equal(winners.length, 1, 'one workspace admits exactly one cross-process writer');
    equal(losers.length, 9, 'all other same-workspace writers are rejected');
    for (const loser of losers) match(loser.error, /Workspace is (?:busy|locked)/, 'the loser receives the workspace lease error');
    const lease = await new WorkspaceLeases({stateDir}).get(workspace);
    ok(lease, 'the winning lease remains durable after its worker exits');
    equal(lease.owner, winners[0].owner, 'the durable lease records the winning owner');
    equal(lease.agent_id, winners[0].agent_id, 'the durable lease records the winning agent');
    equal(lease.workspace, await canonicalWorkspace(workspace), 'the lease stores the canonical workspace');
    equal(winners[0].workspace, lease.workspace, 'the worker observed the same canonical workspace');
  }

  {
    const stateDir = path.join(root, 'state-separate-workspaces');
    const workspaceA = path.join(root, 'workspace-a');
    const workspaceB = path.join(root, 'workspace-b');
    await mkdir(workspaceA, {recursive: true});
    await mkdir(workspaceB, {recursive: true});
    const requestsForLeases = [];
    for (const [name, workspace] of [['a', workspaceA], ['b', workspaceB]]) {
      for (let index = 0; index < 4; index += 1) {
        requestsForLeases.push({
          action: 'lease',
          stateDir,
          workspace,
          agentId: `S${name}${index}`,
          threadId: `separate-owner-${name}-${index}`,
        });
      }
    }
    const resultsForLeases = await runBarrier(requestsForLeases);
    for (const workspace of [workspaceA, workspaceB]) {
      const canonical = await canonicalWorkspace(workspace);
      const winners = resultsForLeases.filter(result => result.ok && result.workspace === canonical);
      equal(winners.length, 1, `${path.basename(workspace)} admits one writer`);
      const lease = await new WorkspaceLeases({stateDir}).get(workspace);
      equal(lease.owner, winners[0].owner, `${path.basename(workspace)} keeps its own owner`);
    }
  }

  {
    const stateDir = path.join(root, 'state-hold');
    const workspace = path.join(root, 'workspace-hold');
    const readyFile = path.join(root, 'hold-ready.json');
    const releaseFile = path.join(root, 'hold-release');
    await mkdir(workspace, {recursive: true});
    const job = await startWorker({
      action: 'hold',
      stateDir,
      workspace,
      agentId: 'HOLD1',
      threadId: 'holder-chat',
      readyFile,
      releaseFile,
    });
    const ready = await waitForResult(readyFile);
    equal(ready.ok, true, 'the hidden holder acquires the lease in another process');
    equal(ready.owner, hashThread('holder-chat'), 'the holder result carries the hashed owner');
    const leases = new WorkspaceLeases({stateDir});
    await rejects(
      leases.acquire({workspace, threadId: 'waiter-chat', agentId: 'WAIT1', reconcile: async () => 'running'}),
      /Workspace is busy.*running/,
      'a live cross-process holder blocks a different owner',
    );
    equal((await leases.get(workspace)).agent_id, 'HOLD1', 'the holder lease is not stolen');
    await writeFile(releaseFile, 'release', 'utf8');
    const held = await resultOf(job);
    equal(held.released, true, 'the holder releases its lease after the explicit signal');
    const acquired = await leases.acquire({workspace, threadId: 'waiter-chat', agentId: 'WAIT1'});
    equal(acquired.owner, hashThread('waiter-chat'), 'the waiting owner acquires only after the cross-process release');
    await leases.release({workspace, threadId: 'waiter-chat', agentId: 'WAIT1'});
    equal(await leases.get(workspace), null, 'the final release leaves no stale lease');
  }
} finally {
  await rm(root, {recursive: true, force: true});
}

console.log(`PASS ${checks} cross-process ownership/lease assertions`);
