import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNativeAgent } from "../scripts/native-agent.mjs";
import { mergeCatalog } from "../scripts/native-catalog.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = path.join(repoRoot, "scripts", "native-agent.mjs");

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };

const cache = {
  models: [
    { slug: "gpt-6.1-sol", visibility: "list", display_name: "GPT-6.1-Sol" },
    { slug: "gpt-6-luna", visibility: "list", display_name: "GPT-6-Luna" },
    { slug: "gpt-5.6-luna", visibility: "list", display_name: "GPT-5.6-Luna" },
  ],
};
const models = cache.models.map((model) => model.slug);
const luna = resolveNativeAgent({ executor: "luna", mainModel: "gpt-6.1-sol", models });
equal(luna.model, "gpt-6-luna", "new Sol maps to its catalog-supported Luna");
equal(luna.fork_turns, "none", "Luna child has no inherited turns");
const older = resolveNativeAgent({ executor: "luna", mainModel: "gpt-5.6-sol", models });
equal(older.model, "gpt-5.6-luna", "older Sol maps to its supported Luna");
const fallback = resolveNativeAgent({ executor: "luna", mainModel: "new-sol-model", models });
equal(fallback.model, "gpt-6-luna", "new unknown Sol prefers an available supported Luna without changing main");
const deepseek = resolveNativeAgent({ executor: "deepseek", mainModel: "gpt-6.1-sol", models });
equal(deepseek.agent_type, "native_deepseek", "DeepSeek selects the dedicated native role");
equal(deepseek.model, undefined, "DeepSeek does not send an explicit model override");
equal(Object.hasOwn(deepseek, "model"), false, "DeepSeek result omits the model property entirely");
equal(deepseek.resolved_model, "deepseek/deepseek-flash", "role metadata identifies the fixed DeepSeek slug informationally");
equal(deepseek.fork_turns, "none", "DeepSeek child has no inherited turns");
assert.throws(() => resolveNativeAgent({ executor: "luna", mainModel: "x", models: ["gpt-6.1-sol"] }), /No supported native Luna/);
checks += 1;

const catalog = mergeCatalog(cache);
equal(catalog.models.length, 4, "catalog preserves every native model and adds DeepSeek");
equal(catalog.models[0].slug, "gpt-6.1-sol", "native catalog order and fields are preserved");
equal(catalog.models.at(-1).slug, "deepseek/deepseek-flash", "DeepSeek is appended");
equal(catalog.models.at(-1).multi_agent_version, "v2", "DeepSeek is spawnable");
equal(catalog.models.at(-1).use_responses_lite, false, "DeepSeek disables ResponsesLite");
equal(catalog.models.filter((model) => model.slug === "deepseek/deepseek-flash").length, 1, "DeepSeek appears once");

function runCli(args, env = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "native-agent-cli-"));
  const out = path.join(dir, "out");
  const err = path.join(dir, "err");
  const outFd = openSync(out, "w");
  const errFd = openSync(err, "w");
  let result;
  try {
    result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
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

const root = await mkdtemp(path.join(os.tmpdir(), "native-agent-homes-"));
try {
  const home = path.join(root, "codex-home");
  const emptyHome = path.join(root, "empty-home");
  await mkdir(home, { recursive: true });
  await mkdir(emptyHome, { recursive: true });
  await writeFile(path.join(home, "models_cache.json"), JSON.stringify(cache), "utf8");
  const lunaCli = runCli(["--executor", "luna", "--main-model", "gpt-6.1-sol"], { CODEX_HOME: home });
  equal(lunaCli.status, 0, "Luna CLI reads the actual CODEX_HOME cache by default");
  equal(JSON.parse(lunaCli.stdout).model, "gpt-6-luna", "Luna CLI resolves the real catalog model");
  const dsCli = runCli(["--executor", "deepseek"], { CODEX_HOME: emptyHome });
  equal(dsCli.status, 2, "DeepSeek CLI fails closed without an activated isolated install journal");
  assert.match(dsCli.stderr, /--install-journal is required/);
  checks += 1;
  const missing = runCli(["--executor", "luna", "--main-model", "gpt-6.1-sol"], { CODEX_HOME: emptyHome });
  equal(missing.status, 2, "Luna CLI fails closed when the default cache is missing");
  assert.match(missing.stderr, /models_cache\.json is missing/);
  checks += 1;
  const overrideCache = path.join(root, "override-cache.json");
  await writeFile(overrideCache, JSON.stringify(cache), "utf8");
  const override = runCli(["--executor", "luna", "--main-model", "gpt-6.1-sol", "--models-cache", overrideCache], { CODEX_HOME: emptyHome });
  equal(override.status, 0, "--models-cache overrides the default cache path");
  equal(JSON.parse(override.stdout).model, "gpt-6-luna", "override cache resolves the model");
  await writeFile(path.join(emptyHome, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6.1-sol" }] }), "utf8");
  const noLuna = runCli(["--executor", "luna", "--main-model", "gpt-6.1-sol"], { CODEX_HOME: emptyHome });
  equal(noLuna.status, 2, "Luna CLI fails instead of substituting when no Luna is listed");
  assert.match(noLuna.stderr, /No supported native Luna/);
  checks += 1;
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`PASS ${checks} native agent/catalog assertions`);
