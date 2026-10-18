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
  const profileId = "abcdefabcdefabcdefabcdef";
  const apiBinding = {
    executor: "api",
    profileId,
    model: "different-api-model",
    role: `native_api_${profileId}`,
    providerId: `api-native-${profileId}`,
  };
  await assert.rejects(tasks.begin({
    parentThreadId: "parent-A",
    childThreadId: "child-A",
    binding: apiBinding,
  }), /already has a different model/);
  checks += 1;
  const lateBound = await tasks.begin({
    parentThreadId: "parent-A",
    childThreadId: "child-A",
    binding: { ...apiBinding, model: "deepseek/deepseek-flash" },
  });
  equal(lateBound.binding.profileId, profileId, "a matching late binding preserves the original child model");
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

  const readonlyState = path.join(root, "readonly-api-state");
  const readonlyProfile = "abcdefabcdefabcdefabcdef";
  const writer = runCli(["reserve", "--workspace", workspaceA, "--task-nonce", "writer-keep-nonce", "--state-dir", readonlyState]);
  equal(writer.status, 0, "a writer reservation can coexist with read-only API recording");
  const recordArgs = [
    "record", "--workspace", workspaceA, "--task-nonce", "api-record-nonce", "--child", "api-readonly-child",
    "--model", "api-readonly-model", "--executor", "api", "--profile-id", readonlyProfile,
    "--role", `native_api_${readonlyProfile}`, "--provider-id", `api-native-${readonlyProfile}`,
    "--state-dir", readonlyState,
  ];
  const recorded = runCli(recordArgs);
  equal(recorded.status, 0, "read-only API child can be recorded without taking the writer lease");
  const recordedTask = JSON.parse(recorded.stdout).task;
  equal(recordedTask.binding.profileId, readonlyProfile, "record stores the complete API binding");
  equal(recordedTask.binding.model, "api-readonly-model", "record stores the exact API model");
  equal((await new NativeWriterLease({ stateDir: readonlyState }).get(workspaceA)).state, "reserved",
    "recording a read-only API child leaves the unrelated writer reservation intact");
  const recordedBinding = runCli(["binding", "--child", "api-readonly-child", "--state-dir", readonlyState]);
  equal(JSON.parse(recordedBinding.stdout).binding.profileId, readonlyProfile, "binding reads the recorded API profile");
  const sameChildFollowup = runCli(recordArgs);
  equal(sameChildFollowup.status, 0, "the same read-only child can continue with its original binding");
  equal(JSON.parse(sameChildFollowup.stdout).task.binding.profileId, readonlyProfile,
    "same-child follow-up keeps the original API profile");
  const crossParent = runCli(recordArgs, { CODEX_THREAD_ID: "trusted-parent-B" });
  equal(crossParent.status, 1, "another parent cannot overwrite the recorded API child");
  assert.match(crossParent.stderr, /another parent chat/);
  const changedModel = runCli(recordArgs.map((value) => value === "api-readonly-model" ? "different-model" : value));
  equal(changedModel.status, 1, "a recorded API child model is immutable");
  assert.match(changedModel.stderr, /different model|immutable/i);
  const completed = runCli(["complete", "--child", "api-readonly-child", "--status", "completed", "--state-dir", readonlyState]);
  equal(completed.status, 0, "complete finishes only the API task record");
  equal(JSON.parse(completed.stdout).task.status, "completed", "complete reports the task status");
  equal((await new NativeWriterLease({ stateDir: readonlyState }).get(workspaceA)).state, "reserved",
    "complete does not release another writer lease");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`PASS ${checks} native state assertions`);
