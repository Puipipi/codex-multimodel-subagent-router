import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalWorkspace } from "../scripts/plugin-state.mjs";
import { NativeTasks, NativeWriterLease } from "../scripts/native-state.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = path.join(repoRoot, "scripts", "native-state.mjs");

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };

function runCli(args, env = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "native-state-cli-"));
  const out = path.join(dir, "out");
  const err = path.join(dir, "err");
  const outFd = openSync(out, "w");
  const errFd = openSync(err, "w");
  let result;
  try {
    result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, CODEX_THREAD_ID: "trusted-parent-A", ...env },
      stdio: ["ignore", outFd, errFd],
      windowsHide: true,
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const stdout = readFileSync(out, "utf8");
  const stderr = readFileSync(err, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stdout, stderr };
}

const root = await mkdtemp(path.join(os.tmpdir(), "native-state-"));
try {
  const workspaceA = path.join(root, "workspace-a");
  const workspaceB = path.join(root, "workspace-b");
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });
  const stateDir = path.join(root, "state");
  const tasks = new NativeTasks({ stateDir });
  await tasks.begin({ parentThreadId: "parent-A", childThreadId: "child-A", model: "deepseek/deepseek-flash", workspace: workspaceA, taskNonce: "task-nonce-A" });
  await tasks.begin({ parentThreadId: "parent-B", childThreadId: "child-B", model: "gpt-6-luna", workspace: workspaceB, taskNonce: "task-nonce-B" });
  equal((await tasks.owned("parent-A")).length, 1, "parent A sees only its own child");
  equal((await tasks.owned("parent-A"))[0].child_thread_id, "child-A", "parent A owns child A");
  equal((await tasks.owned("parent-B")).length, 1, "parent B sees only its own child");
  await assert.rejects(tasks.assertOwner("child-B", "parent-A"), /another parent chat/);
  checks += 1;
  await assert.rejects(tasks.begin({ parentThreadId: "parent-B", childThreadId: "child-A" }), /another parent chat/);
  checks += 1;

  const leases = new NativeWriterLease({ stateDir });
  const realWorkspaceA = await realpath(workspaceA);
  const expectedCanonicalA = process.platform === "win32" ? realWorkspaceA.toLowerCase() : realWorkspaceA;
  const reserved = await leases.reserve({ workspace: workspaceA, parentThreadId: "parent-A", taskNonce: "task-nonce-A" });
  equal(reserved.workspace, expectedCanonicalA, "writer reservation canonicalizes via the OS real path");
  equal(await canonicalWorkspace(workspaceA), await canonicalWorkspace(realWorkspaceA), "short/long aliases canonicalize to one workspace");
  await assert.rejects(
    leases.reserve({ workspace: realWorkspaceA, parentThreadId: "parent-B", taskNonce: "alias-task-nonce" }),
    /already reserved by another native task/,
  );
  checks += 1;
  equal(reserved.state, "reserved", "lease starts reserved before spawn");
  const bound = await leases.bind({ workspace: workspaceA, parentThreadId: "parent-A", taskNonce: "task-nonce-A", childThreadId: "child-A" });
  equal(bound.state, "active", "lease binds the child explicitly");
  equal(bound.child_thread_id, "child-A", "child id is stored after bind");
  await assert.rejects(
    leases.reserve({ workspace: workspaceA, parentThreadId: "parent-B", taskNonce: "task-nonce-B" }),
    /already reserved by another native task/,
  );
  checks += 1;
  await assert.rejects(
    leases.bind({ workspace: workspaceA, parentThreadId: "parent-B", taskNonce: "task-nonce-B", childThreadId: "child-B" }),
    /reservation changed/,
  );
  checks += 1;
  const leaseB = await leases.reserve({ workspace: workspaceB, parentThreadId: "parent-B", taskNonce: "task-nonce-B" });
  ok(leaseB, "a different workspace admits a parallel reservation");
  equal(await leases.release({ workspace: workspaceA, parentThreadId: "parent-B", taskNonce: "task-nonce-B" }), false, "wrong chat cannot release another lease");
  equal(await leases.release({ workspace: workspaceA, parentThreadId: "parent-A", taskNonce: "task-nonce-A" }), true, "owner releases its reservation explicitly");
  equal(await leases.get(workspaceA), null, "released workspace has no residual lease");

  const cliState = path.join(root, "cli-state");
  const reserve = runCli(["reserve", "--workspace", workspaceA, "--task-nonce", "cli-task-nonce", "--state-dir", cliState]);
  equal(reserve.status, 0, "CLI reserve uses trusted CODEX_THREAD_ID without --parent");
  const bind = runCli(["bind", "--workspace", workspaceA, "--task-nonce", "cli-task-nonce", "--child", "cli-child", "--model", "deepseek/deepseek-flash", "--state-dir", cliState]);
  equal(bind.status, 0, "CLI bind records the actual child");
  const whoA = runCli(["who", "--state-dir", cliState], { CODEX_THREAD_ID: "trusted-parent-A" });
  equal(JSON.parse(whoA.stdout).owned.length, 1, "trusted parent sees its own child");
  const whoB = runCli(["who", "--state-dir", cliState], { CODEX_THREAD_ID: "trusted-parent-B" });
  equal(JSON.parse(whoB.stdout).owned.length, 0, "another parent cannot see the child");
  const forged = runCli(["reserve", "--workspace", workspaceB, "--task-nonce", "forged-nonce", "--parent", "trusted-parent-B", "--state-dir", cliState]);
  equal(forged.status, 1, "CLI rejects --parent ownership forgery");
  assert.match(forged.stderr, /--parent is not accepted/);
  checks += 1;
  const finished = runCli(["finish", "--workspace", workspaceA, "--task-nonce", "cli-task-nonce", "--child", "cli-child", "--state-dir", cliState]);
  equal(finished.status, 0, "CLI finish releases the reservation");
  equal((await new NativeWriterLease({ stateDir: cliState }).get(workspaceA)), null, "finish releases the workspace lease");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`PASS ${checks} native state assertions`);
