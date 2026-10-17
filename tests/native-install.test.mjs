import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { composeConfig, install, rollback } from "../scripts/native-install.mjs";

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const match = (value, pattern, message) => { assert.match(value, pattern, message); checks += 1; };

function tomlShape(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const cut = firstTable < 0 ? lines.length : firstTable;
  return {
    root: lines.slice(0, cut),
    tables: lines.slice(cut).filter((line) => /^\s*\[/.test(line)).map((line) => line.trim()),
  };
}

const root = await mkdtemp(path.join(os.tmpdir(), "native-install-"));
try {
  const home = path.join(root, "codex-home");
  await mkdir(path.join(home, "agents"), { recursive: true });
  const original = [
    'model = "gpt-6.1-sol"',
    'model_provider = "openai"',
    'approval_policy = "never"',
    "",
    '[features]',
    'multi_agent = true',
    "",
    '[plugins."last-table"]',
    'enabled = true',
    "",
  ].join("\n");
  await writeFile(path.join(home, "config.toml"), original, "utf8");
  await writeFile(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6.1-sol", visibility: "list" }, { slug: "gpt-6-luna", visibility: "list" }] }), "utf8");

  const composed = composeConfig(original, { baseUrl: "http://127.0.0.1:1234/token/v1", catalog: "catalog.json" });
  const composedShape = tomlShape(composed);
  ok(composedShape.root.some((line) => line.includes('openai_base_url = "http://127.0.0.1:1234/token/v1"')), "managed base URL is in the root section");
  ok(composedShape.root.some((line) => line.includes('model_catalog_json = "catalog.json"')), "managed catalog is in the root section");
  match(composed, /model = "gpt-6\.1-sol"/, "main model is preserved");
  equal(composedShape.tables.at(-1), '[plugins."last-table"]', "last table is preserved after the root block");

  const dry = await install({ codexHome: home, dryRun: true });
  equal(dry.installed, undefined, "dry-run reports a plan and does not install");
  equal((await readFile(path.join(home, "config.toml"), "utf8")), original, "dry-run leaves config untouched");

  const installed = await install({
    codexHome: home, startGateway: false, autostart: false,
    gatewayState: { port: 1234, token: "t".repeat(43), pid: 999999 },
  });
  equal(installed.installed, true, "install applies the managed block");
  const config = await readFile(path.join(home, "config.toml"), "utf8");
  const installedShape = tomlShape(config);
  ok(installedShape.root.some((line) => line.includes("sol-luna-native-gateway begin")), "managed block is at root");
  match(config, /model = "gpt-6\.1-sol"/, "main model stays unchanged");
  equal(installedShape.tables.at(-1), '[plugins."last-table"]', "install keeps the last table");
  ok(existsSync(path.join(home, "sol-luna-native-models.json")), "merged catalog is written");
  ok(existsSync(path.join(home, "agents", "native_deepseek.toml")), "native child role is written");
  const role = await readFile(path.join(home, "agents", "native_deepseek.toml"), "utf8");
  match(role, /deepseek\/deepseek-flash/, "native child role uses the exact slug");

  const withNew = config.replace(/\n\[features\]/, '\npost_install_key = "keep"\n\n[features]')
    + '\n[user.added]\nvalue = 1\n';
  await writeFile(path.join(home, "config.toml"), withNew, "utf8");
  const rolled = await rollback({ codexHome: home, stop: false, removeStartup: false });
  equal(rolled.rolled_back, true, "rollback reports success");
  const after = await readFile(path.join(home, "config.toml"), "utf8");
  match(after, /model = "gpt-6\.1-sol"/, "rollback keeps the main model");
  ok(tomlShape(after).root.some((line) => line.includes('post_install_key = "keep"')), "rollback keeps root keys added after install");
  match(after, /\[user\.added\]/, "rollback keeps tables added after install");
  equal(after.includes("sol-luna-native-gateway begin"), false, "rollback removes only the managed block");
  equal(existsSync(path.join(home, "agents", "native_deepseek.toml")), false, "rollback removes the managed role");
  equal(existsSync(path.join(home, "sol-luna-native-models.json")), false, "rollback removes the managed catalog");

  await writeFile(path.join(home, "config.toml"), original, "utf8");
  await writeFile(path.join(home, "agents", "native_deepseek.toml"), "user-owned = true\n", "utf8");
  await assert.rejects(
    install({ codexHome: home, startGateway: false, gatewayState: { port: 1234, token: "t".repeat(43), pid: 1 } }),
    /unowned agents\/native_deepseek\.toml/,
  );
  checks += 1;
  equal((await readFile(path.join(home, "config.toml"), "utf8")), original, "agent conflict fails before config mutation");

  await writeFile(path.join(home, "config.toml"), 'openai_base_url = "http://user.example"\n', "utf8");
  await assert.rejects(install({ codexHome: home, dryRun: true }), /refusing to overwrite user-owned routing/);
  checks += 1;

  await writeFile(path.join(home, "config.toml"), original, "utf8");
  await rm(path.join(home, "agents", "native_deepseek.toml"), { force: true });
  await writeFile(path.join(home, "sol-luna-native-models.json"), '{"models":[]}\n', "utf8");
  await assert.rejects(
    install({ codexHome: home, startGateway: false, gatewayState: { port: 1234, token: "t".repeat(43), pid: 1 } }),
    /catalog file already exists without an install manifest/,
  );
  checks += 1;
  equal((await readFile(path.join(home, "config.toml"), "utf8")), original, "catalog conflict fails before config mutation");

  const noCacheHome = path.join(root, "no-cache-home");
  await mkdir(noCacheHome, { recursive: true });
  await writeFile(path.join(noCacheHome, "config.toml"), original, "utf8");
  await assert.rejects(
    install({ codexHome: noCacheHome, startGateway: false, gatewayState: { port: 1234, token: "t".repeat(43), pid: 1 } }),
    /models_cache\.json is missing/,
  );
  checks += 1;
  equal((await readFile(path.join(noCacheHome, "config.toml"), "utf8")), original, "catalog build failure leaves config untouched");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`PASS ${checks} native install assertions`);
