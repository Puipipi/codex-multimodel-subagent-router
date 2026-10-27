import { spawnSync } from "node:child_process";
import path from "node:path";
import { verifyRuntimeVersion } from "./native-runtime.mjs";

const OWNED_KEYS = ["CODEX_CLI_PATH", "SOL_LUNA_NATIVE_PLAINTEXT_V2"];
const INSTALL_JOURNAL_KEY = "SOL_LUNA_NATIVE_INSTALL_JOURNAL";
const EXTENDED_OWNED_KEYS = [...OWNED_KEYS, INSTALL_JOURNAL_KEY];
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
$OutputEncoding = $utf8
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$allowed = @(__ALLOWED_KEYS__)
if ($request.key -notin $allowed) { throw 'Environment key is not allowed.' }
if ($request.operation -eq 'get') {
  $value = [Environment]::GetEnvironmentVariable([string]$request.key, 'User')
  @{ key = [string]$request.key; present = ($null -ne $value); value = $value } | ConvertTo-Json -Compress
} elseif ($request.operation -eq 'set') {
  if ($request.present) { [Environment]::SetEnvironmentVariable([string]$request.key, [string]$request.value, 'User') }
  else { [Environment]::SetEnvironmentVariable([string]$request.key, $null, 'User') }
} else { throw 'Operation is not allowed.' }
`;

function assertOwnedKey(key) {
  if (!EXTENDED_OWNED_KEYS.includes(key)) throw new Error(`not an owned environment key: ${key}`);
}

function transactionKeys(transaction) {
  const priorKeys = Object.keys(transaction?.prior ?? {}).sort();
  const nextKeys = Object.keys(transaction?.next ?? {}).sort();
  const expected = priorKeys.join(",");
  if (expected !== nextKeys.join(",") || ![OWNED_KEYS.join(","), EXTENDED_OWNED_KEYS.slice().sort().join(",")].includes(expected)) {
    throw new Error("environment transaction keys are invalid");
  }
  return priorKeys;
}

function state(value) {
  if (value && typeof value === "object" && typeof value.present === "boolean") {
    return { present: value.present, value: value.present ? String(value.value ?? "") : null };
  }
  return value === undefined || value === null
    ? { present: false, value: null }
    : { present: true, value: String(value) };
}

function sameState(left, right) {
  return left.present === right.present && (!left.present || left.value === right.value);
}

async function readState(adapter, key) {
  return state(await adapter.get(key));
}

async function restoreIfStillNext(snapshot, adapter, keys) {
  const errors = [];
  for (const key of [...keys].reverse()) {
    try {
      const current = await readState(adapter, key);
      if (sameState(current, snapshot.next[key])) await adapter.set(key, snapshot.prior[key]);
    } catch (error) {
      errors.push(new Error(`failed to restore ${key}: ${error.message}`, { cause: error }));
    }
  }
  return errors;
}

function withRecoveryErrors(original, recoveryErrors, operation) {
  if (recoveryErrors.length === 0) return original;
  return new AggregateError([original, ...recoveryErrors], `${operation} failed and recovery also failed`);
}

export async function plan({ versionDir, currentEnvironment = {}, installJournalPath }) {
  const verified = await verifyRuntimeVersion(versionDir);
  if (installJournalPath !== undefined && (typeof installJournalPath !== "string" || !installJournalPath.trim())) throw new Error("installJournalPath must be a non-empty path when provided");
  const keys = installJournalPath === undefined ? OWNED_KEYS : EXTENDED_OWNED_KEYS;
  const prior = Object.fromEntries(keys.map((key) => [key, state(Object.hasOwn(currentEnvironment, key) ? currentEnvironment[key] : undefined)]));
  const next = {
    CODEX_CLI_PATH: { present: true, value: verified.exePath },
    SOL_LUNA_NATIVE_PLAINTEXT_V2: { present: true, value: "1" },
  };
  if (installJournalPath !== undefined) next[INSTALL_JOURNAL_KEY] = { present: true, value: path.resolve(installJournalPath) };
  return {
    versionDir,
    exePath: verified.exePath,
    prior,
    next,
  };
}

export async function apply(transaction, adapter) {
  if (!transaction?.versionDir || !adapter?.get || !adapter?.set) throw new Error("a valid plan and environment adapter are required");
  const verified = await verifyRuntimeVersion(transaction.versionDir);
  const keys = transactionKeys(transaction);
  if (verified.exePath !== transaction.exePath || transaction.next?.CODEX_CLI_PATH?.value !== verified.exePath || transaction.next?.SOL_LUNA_NATIVE_PLAINTEXT_V2?.value !== "1") {
    throw new Error("plan no longer matches its verified runtime");
  }
  for (const key of keys) {
    assertOwnedKey(key);
    if (!sameState(await readState(adapter, key), transaction.prior[key])) throw new Error(`environment changed since plan: ${key}`);
  }
  const attempted = [];
  try {
    for (const key of keys) {
      if (!sameState(await readState(adapter, key), transaction.prior[key])) throw new Error(`environment changed since plan: ${key}`);
      attempted.push(key);
      await adapter.set(key, transaction.next[key]);
    }
  } catch (error) {
    const recoveryErrors = await restoreIfStillNext(transaction, adapter, attempted);
    throw withRecoveryErrors(error, recoveryErrors, "environment apply");
  }
  return { versionDir: transaction.versionDir, exePath: transaction.exePath, prior: transaction.prior, next: transaction.next };
}

export async function rollback(snapshot, adapter) {
  if (!snapshot?.prior || !snapshot?.next || !adapter?.get || !adapter?.set) throw new Error("a valid rollback snapshot and environment adapter are required");
  const keys = transactionKeys(snapshot);
  for (const key of keys) {
    assertOwnedKey(key);
    if (!sameState(await readState(adapter, key), snapshot.next[key])) throw new Error(`environment changed since apply: ${key}`);
  }
  const attempted = [];
  try {
    for (const key of [...keys].reverse()) {
      if (!sameState(await readState(adapter, key), snapshot.next[key])) throw new Error(`environment changed since apply: ${key}`);
      attempted.push(key);
      await adapter.set(key, snapshot.prior[key]);
    }
  } catch (error) {
    const recoveryErrors = [];
    for (const key of [...attempted].reverse()) {
      try {
        if (sameState(await readState(adapter, key), snapshot.prior[key])) await adapter.set(key, snapshot.next[key]);
      } catch (recoveryError) { recoveryErrors.push(recoveryError); }
    }
    throw withRecoveryErrors(error, recoveryErrors, "environment rollback");
  }
  return { restored: true };
}

export function createWindowsUserEnvironmentAdapter({ runner = spawnSync, allowInstallJournal = false } = {}) {
  const allowedKeys = allowInstallJournal === true ? EXTENDED_OWNED_KEYS : OWNED_KEYS;
  const script = WINDOWS_SCRIPT.replace("__ALLOWED_KEYS__", allowedKeys.map((key) => `'${key}'`).join(", "));
  const assertAdapterKey = (key) => {
    if (!allowedKeys.includes(key)) throw new Error(`not an owned environment key: ${key}`);
  };
  const invoke = async (request) => {
    const result = await runner("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      input: JSON.stringify(request), encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    if (result?.error) throw new Error(`PowerShell environment operation failed: ${result.error.message}`);
    if (result?.status !== 0) throw new Error(`PowerShell environment operation failed with status ${result?.status}`);
    return result.stdout ?? "";
  };
  return {
    async get(key) {
      assertAdapterKey(key);
      const output = await invoke({ operation: "get", key });
      let parsed;
      try { parsed = JSON.parse(output); } catch { throw new Error("PowerShell returned invalid environment state"); }
      if (parsed.key !== key || typeof parsed.present !== "boolean") throw new Error("PowerShell returned unexpected environment state");
      return state(parsed);
    },
    async set(key, value) {
      assertAdapterKey(key);
      const normalized = state(value);
      if (normalized.present && typeof normalized.value !== "string") throw new Error("environment value must be a string");
      await invoke({ operation: "set", key, ...normalized });
    },
  };
}

export const NATIVE_RUNTIME_ENV_OWNED_KEYS = [...OWNED_KEYS];
