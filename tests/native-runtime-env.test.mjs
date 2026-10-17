import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NATIVE_RUNTIME_PATCH_SHA256, NATIVE_RUNTIME_SOURCE_COMMIT, NATIVE_RUNTIME_TARGET, NATIVE_RUNTIME_VERSION } from "../scripts/native-runtime.mjs";
import { apply, createWindowsUserEnvironmentAdapter, plan, rollback } from "../scripts/native-runtime-env.mjs";

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const rejects = async (fn, pattern, message) => { await assert.rejects(fn, pattern, message); checks += 1; };
const sha = (value) => createHash("sha256").update(value).digest("hex");

const root = await mkdtemp(path.join(os.tmpdir(), "native-runtime-env-test-"));
try {
  const versionDir = path.join(root, "versions", "verified");
  await mkdir(versionDir, { recursive: true });
  const files = {
    "codex.exe": Buffer.from("unexecuted staged CLI fixture"),
    "provenance.json": Buffer.from(JSON.stringify({
      source_commit: NATIVE_RUNTIME_SOURCE_COMMIT,
      patch_sha256: NATIVE_RUNTIME_PATCH_SHA256,
      target: NATIVE_RUNTIME_TARGET,
    }) + "\n"),
    "codex-code-mode-host.exe": Buffer.from("helper fixture"),
    "codex-command-runner.exe": Buffer.from("helper fixture"),
    "codex-windows-sandbox-setup.exe": Buffer.from("helper fixture"),
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(versionDir, name), bytes);
  const manifest = {
    version: NATIVE_RUNTIME_VERSION,
    source_commit: NATIVE_RUNTIME_SOURCE_COMMIT,
    patch_sha256: NATIVE_RUNTIME_PATCH_SHA256,
    target: NATIVE_RUNTIME_TARGET,
    stock_cli_version: NATIVE_RUNTIME_VERSION,
    binary_sha256: sha(files["codex.exe"]),
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)])),
  };
  await writeFile(path.join(versionDir, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const environment = new Map([
    ["CODEX_CLI_PATH", "C:\\Codex\\stock\\codex.exe"],
    ["SOL_LUNA_NATIVE_PLAINTEXT_V2", "0"],
    ["PATH", "keep-path-value"],
    ["OTHER", "keep-other-value"],
  ]);
  const adapter = {
    async get(key) { return environment.has(key) ? environment.get(key) : undefined; },
    async set(key, state) {
      if (state.present) environment.set(key, state.value);
      else environment.delete(key);
    },
  };
  const currentEnvironment = Object.fromEntries(environment);
  const transaction = await plan({ versionDir, currentEnvironment });
  equal(JSON.stringify(Object.fromEntries(environment)), JSON.stringify(currentEnvironment), "planning is read-only and does not mutate the environment adapter");
  equal(Object.keys(transaction.prior).sort().join(","), "CODEX_CLI_PATH,SOL_LUNA_NATIVE_PLAINTEXT_V2", "plan snapshots only the two owned keys");
  equal(Object.keys(transaction.next).sort().join(","), "CODEX_CLI_PATH,SOL_LUNA_NATIVE_PLAINTEXT_V2", "plan changes only the two owned keys");
  equal(transaction.next.CODEX_CLI_PATH.value, path.join(versionDir, "codex.exe"), "next CLI path comes from verified runtime");
  equal(transaction.next.SOL_LUNA_NATIVE_PLAINTEXT_V2.value, "1", "next plaintext alias is enabled");
  equal(JSON.stringify(transaction).includes("keep-path-value"), false, "plan does not expose unrelated PATH value");
  equal(JSON.stringify(transaction).includes("keep-other-value"), false, "plan does not expose unrelated environment values");

  const applied = await apply(transaction, adapter);
  equal(environment.get("CODEX_CLI_PATH"), transaction.next.CODEX_CLI_PATH.value, "apply sets the verified CLI path");
  equal(environment.get("SOL_LUNA_NATIVE_PLAINTEXT_V2"), "1", "apply sets the plaintext alias");
  equal(environment.get("PATH"), "keep-path-value", "apply preserves PATH");
  equal(environment.get("OTHER"), "keep-other-value", "apply preserves other environment values");
  await rollback(applied, adapter);
  equal(environment.get("CODEX_CLI_PATH"), "C:\\Codex\\stock\\codex.exe", "rollback restores the prior CLI path");
  equal(environment.get("SOL_LUNA_NATIVE_PLAINTEXT_V2"), "0", "rollback restores the prior alias value");
  equal(environment.get("PATH"), "keep-path-value", "rollback preserves PATH");
  equal(environment.get("OTHER"), "keep-other-value", "rollback preserves unrelated environment values");

  const stale = await plan({ versionDir, currentEnvironment: Object.fromEntries(environment) });
  environment.set("CODEX_CLI_PATH", "C:\\User\\changed-after-plan.exe");
  await rejects(() => apply(stale, adapter), /environment changed since plan/i, "apply refuses stale plan before writing either key");
  equal(environment.get("SOL_LUNA_NATIVE_PLAINTEXT_V2"), "0", "stale plan refusal leaves other owned value unchanged");

  environment.set("CODEX_CLI_PATH", "C:\\Codex\\stock\\codex.exe");
  const partial = await plan({ versionDir, currentEnvironment: Object.fromEntries(environment) });
  let writes = 0;
  const failsOnSecondSet = {
    ...adapter,
    async set(key, state) {
      writes += 1;
      if (writes === 2) throw new Error("simulated alias write failure");
      return adapter.set(key, state);
    },
  };
  await rejects(() => apply(partial, failsOnSecondSet), /alias write failure/i, "second setter failure is surfaced");
  equal(environment.get("CODEX_CLI_PATH"), "C:\\Codex\\stock\\codex.exe", "failed second set rolls back the first owned key");
  equal(environment.get("SOL_LUNA_NATIVE_PLAINTEXT_V2"), "0", "failed set leaves alias prior value intact");

  let recoveryWrites = 0;
  const failsAndCannotRecover = {
    ...adapter,
    async set(key, state) {
      recoveryWrites += 1;
      if (recoveryWrites === 2) throw new Error("primary alias write failure");
      if (recoveryWrites === 3) throw new Error("recovery CLI restore failure");
      return adapter.set(key, state);
    },
  };
  await rejects(() => apply(partial, failsAndCannotRecover), (error) => {
    const details = [error.message, ...(error.errors ?? []).map((item) => item.message)].join(" | ");
    return /primary alias write failure/i.test(details) && /recovery CLI restore failure/i.test(details);
  }, "apply failure retains primary and recovery errors");
  environment.set("CODEX_CLI_PATH", "C:\\Codex\\stock\\codex.exe");

  let recoveryOrderWrites = 0;
  const firstRecoveryFails = {
    ...adapter,
    async set(key, state) {
      recoveryOrderWrites += 1;
      if (recoveryOrderWrites === 2) {
        await adapter.set(key, state);
        throw new Error("primary failure after alias mutation");
      }
      if (recoveryOrderWrites === 3) throw new Error("first recovery failure");
      return adapter.set(key, state);
    },
  };
  await rejects(() => apply(partial, firstRecoveryFails), (error) => {
    const details = [error.message, ...(error.errors ?? []).map((item) => item.message)].join(" | ");
    return /primary failure after alias mutation/i.test(details) && /first recovery failure/i.test(details);
  }, "apply reports first recovery failure while continuing later key recovery");
  equal(environment.get("CODEX_CLI_PATH"), "C:\\Codex\\stock\\codex.exe", "recovery continues to restore the second written key after the first recovery fails");
  environment.set("CODEX_CLI_PATH", "C:\\Codex\\stock\\codex.exe");
  environment.set("SOL_LUNA_NATIVE_PLAINTEXT_V2", "0");

  const rollbackWithFailedRecovery = await apply(partial, adapter);
  let failedRollbackWrites = 0;
  const mutatesAndRecoveryFails = {
    ...adapter,
    async set(key, state) {
      failedRollbackWrites += 1;
      if (failedRollbackWrites === 1) {
        await adapter.set(key, state);
        throw new Error("primary rollback alias failure");
      }
      if (failedRollbackWrites === 2) throw new Error("rollback recovery alias failure");
      return adapter.set(key, state);
    },
  };
  await rejects(() => rollback(rollbackWithFailedRecovery, mutatesAndRecoveryFails), (error) => {
    const details = [error.message, ...(error.errors ?? []).map((item) => item.message)].join(" | ");
    return /primary rollback alias failure/i.test(details) && /rollback recovery alias failure/i.test(details);
  }, "rollback failure retains primary and recovery errors");
  environment.set("CODEX_CLI_PATH", "C:\\Codex\\stock\\codex.exe");
  environment.set("SOL_LUNA_NATIVE_PLAINTEXT_V2", "0");

  const appliedForRollbackFailure = await apply(partial, adapter);
  let rollbackWrites = 0;
  const mutatesThenThrowsDuringRollback = {
    ...adapter,
    async set(key, state) {
      rollbackWrites += 1;
      if (rollbackWrites === 1) {
        await adapter.set(key, state);
        throw new Error("rollback alias write failed after mutation");
      }
      return adapter.set(key, state);
    },
  };
  await rejects(() => rollback(appliedForRollbackFailure, mutatesThenThrowsDuringRollback), /rollback alias write failed after mutation/i, "rollback surfaces a setter failure after mutation");
  equal(environment.get("SOL_LUNA_NATIVE_PLAINTEXT_V2"), appliedForRollbackFailure.next.SOL_LUNA_NATIVE_PLAINTEXT_V2.value, "rollback recovery includes the setter that mutated before throwing");

  const appliedAgain = await apply(await plan({ versionDir, currentEnvironment: Object.fromEntries(environment) }), adapter);
  environment.set("SOL_LUNA_NATIVE_PLAINTEXT_V2", "user-later-value");
  await rejects(() => rollback(appliedAgain, adapter), /environment changed since apply/i, "rollback refuses changed owned value");
  equal(environment.get("CODEX_CLI_PATH"), partial.next.CODEX_CLI_PATH.value, "rollback conflict preserves all other values");
  equal(environment.get("SOL_LUNA_NATIVE_PLAINTEXT_V2"), "user-later-value", "rollback conflict preserves user's later value");

  const invalidRuntime = path.join(root, "invalid");
  await mkdir(invalidRuntime);
  await rejects(() => plan({ versionDir: invalidRuntime, currentEnvironment: {} }), /runtime manifest|missing/i, "plan rejects an unverified runtime");
  const removedFile = path.join(versionDir, "codex-command-runner.exe");
  const saved = await readFile(removedFile);
  await rm(removedFile);
  await rejects(() => plan({ versionDir, currentEnvironment: {} }), /hash|missing|manifest/i, "plan rejects a runtime missing a required file");
  await writeFile(removedFile, saved);

  const calls = [];
  const windowsAdapter = createWindowsUserEnvironmentAdapter({
    runner: async (exe, args, options) => {
      calls.push({ exe, args, options });
      if (options.input.includes('"operation":"get"')) {
        return { status: 0, stdout: '{"key":"CODEX_CLI_PATH","present":false,"value":null}' };
      }
      return { status: 0, stdout: "" };
    },
  });
  equal((await windowsAdapter.get("CODEX_CLI_PATH")).present, false, "Windows adapter parses only the requested key result");
  await windowsAdapter.set("SOL_LUNA_NATIVE_PLAINTEXT_V2", { present: true, value: "1" });
  equal(calls.length, 2, "fake runner captures the two adapter operations");
  for (const call of calls) {
    equal(call.exe, "powershell.exe", "adapter uses PowerShell directly");
    equal(call.options.windowsHide, true, "adapter hides PowerShell windows");
    equal(call.options.timeout, 10_000, "adapter applies a ten-second bound");
    equal(call.options.encoding, "utf8", "adapter uses UTF-8 input and output");
    ok(call.options.input.includes("CODEX_CLI_PATH") || call.options.input.includes("SOL_LUNA_NATIVE_PLAINTEXT_V2"), "adapter passes the requested key through stdin JSON");
    equal(call.args.at(-1).includes("CODEX_CLI_PATH") && call.args.at(-1).includes("SOL_LUNA_NATIVE_PLAINTEXT_V2"), true, "PowerShell command contains only its fixed whitelist script");
    equal(call.args.at(-1).includes("[Console]::InputEncoding") && call.args.at(-1).includes("[Console]::OutputEncoding") && call.args.at(-1).includes("$OutputEncoding"), true, "PowerShell script explicitly configures UTF-8 streams");
    equal(call.args.some((arg) => arg.includes(versionDir) || arg.includes("keep-other-value") || arg === "1"), false, "adapter never interpolates runtime paths or environment values into arguments");
  }
  equal(calls[1].options.input.includes('"value":"1"'), true, "adapter sends values only in stdin JSON");
  await rejects(() => windowsAdapter.get("PATH"), /not an owned environment key/i, "Windows adapter rejects all keys outside its whitelist");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`PASS ${checks} runtime environment assertions`);
