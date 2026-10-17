// Cross-process worker for the plugin ownership/lease tests. The parent starts
// several of these with windowsHide enabled and a file barrier, then reads only
// the small JSON result. No credentials or raw chat ids are written here.
import {existsSync, readFileSync} from 'node:fs';
import {OwnershipStore, WorkspaceLeases, writeJsonAtomic} from '../../scripts/plugin-state.mjs';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const [, , requestPath, resultPath] = process.argv;

async function waitForFile(file, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await delay(5);
  }
}

async function run() {
  const request = JSON.parse(readFileSync(requestPath, 'utf8'));
  const {
    action, stateDir, threadId, agentId, workspace,
    barrier, readyFile, releaseFile, holdMs,
  } = request;
  if (barrier) await waitForFile(barrier);

  if (action === 'claim') {
    const store = new OwnershipStore({stateDir});
    const record = await store.claim(agentId, threadId, {workspace: workspace ?? null, write: true});
    return {ok: true, owner: record.owner, agent_id: record.agent_id, threadId};
  }

  if (action === 'lease') {
    const leases = new WorkspaceLeases({stateDir});
    const lease = await leases.acquire({workspace, threadId, agentId});
    const result = {ok: true, owner: lease.owner, agent_id: lease.agent_id, workspace: lease.workspace, threadId};
    if (holdMs) {
      if (readyFile) await writeJsonAtomic(readyFile, result);
      await delay(holdMs);
      await leases.release({workspace, threadId, agentId});
      result.released = true;
    }
    return result;
  }

  if (action === 'hold') {
    const leases = new WorkspaceLeases({stateDir});
    const lease = await leases.acquire({workspace, threadId, agentId});
    const result = {ok: true, owner: lease.owner, agent_id: lease.agent_id, workspace: lease.workspace, threadId};
    await writeJsonAtomic(readyFile, result);
    await waitForFile(releaseFile);
    await leases.release({workspace, threadId, agentId});
    result.released = true;
    return result;
  }

  throw new Error(`unknown worker action: ${action}`);
}

try {
  await writeJsonAtomic(resultPath, await run());
} catch (error) {
  await writeJsonAtomic(resultPath, {ok: false, error: error.message, code: error.code ?? null});
}
