import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  OwnershipStore, WorkspaceLeases, canonicalWorkspace, hashThread, normalizeWorkspace, workspaceKey, withFileLock, writeJsonAtomic,
} from '../scripts/plugin-state.mjs';

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const deepEqual = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1; };

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

const root = await mkdtemp(path.join(os.tmpdir(), 'sol-plugin-state-'));
const makeWorkspace = async name => {
  const value = path.join(root, name);
  await mkdir(value, {recursive: true});
  return value;
};

try {
  deepEqual(normalizeWorkspace(root), process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root),
    'display workspace normalization is deterministic');
  deepEqual(await canonicalWorkspace(root), process.platform === 'win32' ? path.resolve(await canonicalWorkspace(root)).toLowerCase() : path.resolve(root),
    'canonical workspace is a real path');

  const hashed = hashThread('chat-one');
  ok(/^[a-f0-9]{64}$/.test(hashed), 'thread ids are persisted only as a sha256 digest');
  ok(hashed !== 'chat-one', 'the raw thread id is not the stored key');

  {
    const real = await makeWorkspace('symlink-real');
    const alias = path.join(root, 'symlink-alias');
    try {
      await symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
      equal(await workspaceKey(real), await workspaceKey(alias), 'symlink/junction aliases share one workspace lock key');
    } catch (error) {
      if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
      console.log(`SKIP symlink alias assertion: ${error.code}`);
    }
    equal(await workspaceKey(real), await workspaceKey(`${real}${path.sep}`), 'trailing separators share one workspace lock key');
    equal(await workspaceKey(real), await workspaceKey(path.join(real, '..', path.basename(real))), 'dot-segment aliases share one workspace lock key');
    if (process.platform === 'win32') {
      equal(await workspaceKey(real), await workspaceKey(real.toUpperCase()), 'Windows case aliases share one workspace lock key');
    }
  }

  {
    const stores = [new OwnershipStore({stateDir: root}), new OwnershipStore({stateDir: root})];
    const first = await stores[0].claim('A1', 'chat-one', {workspace: root, write: true, status: 'active'});
    equal(first.agent_id, 'A1', 'claim returns the agent id');
    equal(first.owner, hashed, 'claim stores the hashed owner');
    equal(first.status, 'active', 'claim stores the initial status');
    const durable = await stores[1].assertOwner('A1', 'chat-one');
    equal(durable.agent_id, 'A1', 'a second store sees durable ownership');
    await rejects(stores[1].assertOwner('A1', 'chat-two'), /not available to this chat/, 'another chat cannot manage the agent');
    await rejects(stores[1].claim('A1', 'chat-two', {workspace: root}), /not available to this chat/, 'another chat cannot re-claim the agent');
    equal((await stores[1].owned('chat-one')).length, 1, 'owned() returns only this chat');
    equal((await stores[1].owned('chat-two')).length, 0, 'another chat sees no owned agents');

    const raw = await readFile(path.join(root, 'ownership.json'), 'utf8');
    ok(!raw.includes('chat-one') && !raw.includes('chat-two'), 'raw chat identifiers are not persisted');
    ok(raw.includes(hashed), 'the hashed owner is persisted');

    const combined = await Promise.allSettled([
      stores[0].claim('A2', 'chat-one', {workspace: root}),
      stores[1].claim('A2', 'chat-two', {workspace: root}),
    ]);
    equal(combined.filter(result => result.status === 'fulfilled').length, 1, 'concurrent claims for one agent admit exactly one chat');
    const winner = (await stores[0].snapshot()).agents.A2.owner;
    const expected = winner === hashThread('chat-one') ? 'chat-one' : 'chat-two';
    await stores[0].assertOwner('A2', expected);
    checks += 1;
  }

  {
    const stores = [new OwnershipStore({stateDir: root}), new OwnershipStore({stateDir: root})];
    const claims = [];
    for (let index = 0; index < 24; index += 1) {
      claims.push(stores[index % 2].claim(`P${index}`, `parallel-chat-${index % 3}`, {workspace: root, write: index % 2 === 0}));
    }
    await Promise.all(claims);
    const snapshot = await stores[0].snapshot();
    equal(Object.keys(snapshot.agents).length, 26, 'all concurrent ownership claims survive read-modify-write');
    equal((await stores[1].owned('parallel-chat-1')).length, 8, 'ownership groups remain separated after parallel writes');
  }

  {
    const leases = new WorkspaceLeases({stateDir: root});
    const workspace = await makeWorkspace('workspace');
    const other = await makeWorkspace('other-workspace');
    const running = async () => 'running';
    const lease = await leases.acquire({workspace, threadId: 'chat-one', agentId: 'W1', bound: true, reconcile: running});
    equal(lease.agent_id, 'W1', 'writer lease records the agent');
    equal(lease.owner, hashThread('chat-one'), 'writer lease records the hashed owner');
    equal(lease.bound, true, 'a verified writer lease is bound');
    equal(lease.expires_at, undefined, 'bound leases have no expiry that could silently release them');
    await rejects(leases.acquire({workspace, threadId: 'chat-two', agentId: 'W2', bound: true, reconcile: running}), /Workspace is busy/, 'another chat cannot take the same workspace lease');
    const second = await leases.acquire({workspace: other, threadId: 'chat-two', agentId: 'W3', bound: true, reconcile: running});
    equal(second.agent_id, 'W3', 'a different workspace has an independent lease');
    await leases.release({workspace: other, threadId: 'chat-two', agentId: 'W3'});
    equal(await leases.release({workspace, threadId: 'chat-two', agentId: 'W1'}), false, 'a non-owner cannot release a lease');
    equal((await leases.get(workspace)).agent_id, 'W1', 'a rejected release leaves the lease intact');
    equal(await leases.release({workspace, threadId: 'chat-one', agentId: 'W1'}), true, 'the owner releases its lease');
    equal(await leases.get(workspace), null, 'a released lease is gone');

    const bindWorkspace = await makeWorkspace('bind-workspace');
    await leases.acquire({workspace: bindWorkspace, threadId: 'chat-one', agentId: 'reservation:1', bound: false});
    await leases.bind({workspace: bindWorkspace, threadId: 'chat-one', reservationId: 'reservation:1', agentId: 'B1'});
    const bound = await leases.get(bindWorkspace);
    equal(bound.agent_id, 'B1', 'a reservation is atomically bound to the created agent id');
    equal(bound.bound, true, 'binding marks the lease as a verified writer');
    await leases.release({workspace: bindWorkspace, threadId: 'chat-one', agentId: 'B1'});

    const parallelWorkspace = await makeWorkspace('parallel-workspace');
    const reservations = await Promise.allSettled([
      leases.acquire({workspace: parallelWorkspace, threadId: 'chat-one', agentId: 'R1', bound: false}),
      leases.acquire({workspace: parallelWorkspace, threadId: 'chat-two', agentId: 'R2', bound: false}),
    ]);
    equal(reservations.filter(result => result.status === 'fulfilled').length, 1, 'parallel writers in one workspace admit exactly one reservation');
    const parallelCanonical = await canonicalWorkspace(parallelWorkspace);
    const heldEntry = (await leases.list()).find(value => value.workspace === parallelCanonical);
    ok(heldEntry, 'the winning reservation is durable');
    await leases.release({workspace: parallelWorkspace, threadId: heldEntry.owner === hashThread('chat-one') ? 'chat-one' : 'chat-two', agentId: heldEntry.agent_id});
  }

  {
    const leases = new WorkspaceLeases({stateDir: root});
    const workspace = await makeWorkspace('dead-plugin-workspace');
    const running = async () => 'running';
    await leases.acquire({workspace, threadId: 'chat-one', agentId: 'D1', bound: true, reconcile: running});
    const file = path.join(root, 'leases', `${await workspaceKey(workspace)}.json`);
    await writeJsonAtomic(file, {...JSON.parse(await readFile(file, 'utf8')), pid: 999999, expires_at: '2000-01-01T00:00:00.000Z'});
    await rejects(leases.acquire({workspace, threadId: 'chat-two', agentId: 'D2', bound: true, reconcile: running}),
      /Workspace is busy.*running/, 'an active independent DSH task keeps the lease after plugin death and expiry');
    equal((await leases.get(workspace)).agent_id, 'D1', 'the active lease is not stolen');
    const completed = async () => 'completed';
    const replacement = await leases.acquire({workspace, threadId: 'chat-two', agentId: 'D3', bound: true, reconcile: completed});
    equal(replacement.agent_id, 'D3', 'confirmed completion recovers the workspace');
    equal((await leases.get(workspace)).agent_id, 'D3', 'only the confirmed replacement remains');
    await leases.release({workspace, threadId: 'chat-two', agentId: 'D3'});

    const idleWorkspace = await makeWorkspace('idle-workspace');
    await leases.acquire({workspace: idleWorkspace, threadId: 'chat-one', agentId: 'I1', bound: true, reconcile: running});
    const idleReplacement = await leases.acquire({workspace: idleWorkspace, threadId: 'chat-two', agentId: 'I2', bound: true, reconcile: async () => 'idle'});
    equal(idleReplacement.agent_id, 'I2', 'confirmed idle also recovers the workspace');
    await leases.release({workspace: idleWorkspace, threadId: 'chat-two', agentId: 'I2'});
  }

  {
    const leases = new WorkspaceLeases({stateDir: root});
    const unavailableWorkspace = await makeWorkspace('unavailable-workspace');
    await leases.acquire({workspace: unavailableWorkspace, threadId: 'chat-one', agentId: 'U1', bound: true, reconcile: async () => 'running'});
    await rejects(leases.acquire({
      workspace: unavailableWorkspace,
      threadId: 'chat-two',
      agentId: 'U2',
      bound: true,
      reconcile: async () => { throw new Error('MCP process exited (1).'); },
    }), /backend is unavailable|lease is retained/, 'backend unavailable keeps the lease locked');
    equal((await leases.get(unavailableWorkspace)).agent_id, 'U1', 'backend unavailable never silently releases');
    await rejects(leases.acquire({
      workspace: unavailableWorkspace,
      threadId: 'chat-two',
      agentId: 'U3',
      bound: true,
      reconcile: async () => 'unknown',
    }), /unknown status|lease is retained/, 'an unknown backend status keeps the lease locked');
    await leases.release({workspace: unavailableWorkspace, threadId: 'chat-one', agentId: 'U1'});
  }

  {
    const leases = new WorkspaceLeases({stateDir: root});
    const reservationWorkspace = await makeWorkspace('reservation-workspace');
    await leases.acquire({workspace: reservationWorkspace, threadId: 'chat-one', agentId: 'reservation:uncertain', bound: false});
    const file = path.join(root, 'leases', `${await workspaceKey(reservationWorkspace)}.json`);
    await writeJsonAtomic(file, {...JSON.parse(await readFile(file, 'utf8')), pid: 999999, expires_at: '2000-01-01T00:00:00.000Z'});
    let reconciled = false;
    await rejects(leases.acquire({
      workspace: reservationWorkspace,
      threadId: 'chat-two',
      agentId: 'R2',
      bound: true,
      reconcile: async () => { reconciled = true; return 'completed'; },
    }), /uncertain start reservation|never expires/, 'an uncertain start reservation never expires into a duplicate dispatch');
    equal(reconciled, false, 'an unbound reservation is never reconciled as an agent');
    equal((await leases.get(reservationWorkspace)).agent_id, 'reservation:uncertain', 'the reservation remains until deliberate recovery');
    await leases.release({workspace: reservationWorkspace, threadId: 'chat-one', agentId: 'reservation:uncertain'});
  }

  {
    const lockPath = path.join(root, 'manual.lock');
    await withFileLock(lockPath, async () => {
      equal(await readFile(lockPath, 'utf8').then(Boolean), true, 'a lock is visible while held');
    });
    await assert.rejects(readFile(lockPath, 'utf8'), /ENOENT/);
    checks += 1;
  }

  {
    const entries = await readdir(root);
    ok(!entries.some(name => name.endsWith('.tmp') || name.includes('.tmp-')), 'atomic writes leave no temporary files');
    ok(!entries.includes('ownership.lock'), 'ownership locks are released');
    const leaseFiles = await readdir(path.join(root, 'leases'));
    ok(!leaseFiles.some(name => name.endsWith('.guard') || name.endsWith('.reclaim')), 'lease guard and reclaim locks are released');
  }

  {
    const corrupt = path.join(root, 'corrupt');
    await rm(corrupt, {recursive: true, force: true});
    const store = new OwnershipStore({stateDir: corrupt});
    await mkdir(corrupt, {recursive: true});
    await writeFile(path.join(corrupt, 'ownership.json'), '{not json', 'utf8');
    await rejects(store.assertOwner('A1', 'chat-one'), /corrupt; refusing to act/, 'corrupt ownership fails closed');
  }
} finally {
  await rm(root, {recursive: true, force: true});
}

console.log(`PASS ${checks} plugin state assertions`);
