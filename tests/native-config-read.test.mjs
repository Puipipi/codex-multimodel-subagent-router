import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(repoRoot, "scripts", "native-config-validate.mjs");
const realHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const realCache = path.join(realHome, "models_cache.json");
if (!existsSync(realCache)) {
  console.error("native config/read local gate requires a local Codex models_cache.json; refusing to fake green");
  process.exit(2);
}

const root = mkdtempSync(path.join(os.tmpdir(), "native-config-read-test-"));
const source = path.join(root, "source");
mkdirSync(source, { recursive: true });
copyFileSync(realCache, path.join(source, "models_cache.json"));
writeFileSync(path.join(source, "config.toml"), 'model = "gpt-6.1-sol"\nmodel_provider = "openai"\n', "utf8");
const out = path.join(root, "stdout");
const err = path.join(root, "stderr");
const outFd = openSync(out, "w");
const errFd = openSync(err, "w");
let result;
try {
  result = spawnSync(process.execPath, [script, "--source-home", source], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_CLI_PATH: process.env.CODEX_CLI_PATH || "codex" },
    stdio: ["ignore", outFd, errFd],
    windowsHide: true,
    timeout: 120_000,
  });
} finally {
  closeSync(outFd);
  closeSync(errFd);
}
const stdout = readFileSync(out, "utf8");
const stderr = readFileSync(err, "utf8");
rmSync(root, { recursive: true, force: true });
assert.equal(result.status, 0, `config/read validation failed:\n${stdout}\n${stderr}`);
const parsed = JSON.parse(stdout);
assert.equal(parsed.ok, true, "all config/read checks pass");
assert.equal(parsed.main_model, "gpt-6.1-sol", "original main model is read");
assert.equal(parsed.effective_model, "gpt-6.1-sol", "effective main model is unchanged");
assert.equal(parsed.base_url.host, "127.0.0.1", "base URL host is loopback");
assert.equal(parsed.base_url.capability_hidden, true, "capability path is not printed");
assert.equal(parsed.checks.model_list_has_deepseek, true, "model_catalog_json adds DeepSeek");
assert.equal(parsed.checks.multi_table_preserved, true, "multi-table config survives");
assert.equal(parsed.rollback.post_install_root_preserved, true, "rollback preserves post-install root keys");
assert.equal(parsed.rollback.post_install_table_preserved, true, "rollback preserves post-install tables");
assert.doesNotMatch(stdout, /fixture-local-only|Bearer|sk-[A-Za-z0-9]/i, "validation output contains no capability or credential");
console.log("PASS native config/read validation assertions");
