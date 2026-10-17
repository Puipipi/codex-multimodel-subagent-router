import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { install, rollback } from "./native-install.mjs";
import { PICKER_SLUG } from "./native-routing.mjs";

const CODEX = process.env.CODEX_CLI_PATH || "codex";

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

function rootValue(content, key) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const first = lines.findIndex((line) => /^\s*\[/.test(line));
  const root = first < 0 ? lines : lines.slice(0, first);
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`);
  for (const line of root) {
    const match = pattern.exec(line);
    if (!match) continue;
    try { return JSON.parse(match[1]); } catch { return match[1].trim().replace(/^"|"$/g, ""); }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs = 20_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error("app-server websocket did not open"));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

async function appServerSession({ codexHome, cwd }) {
  const port = await freePort();
  const child = spawn(CODEX, ["app-server", "--listen", `ws://127.0.0.1:${port}`], {
    cwd, env: { ...process.env, CODEX_HOME: codexHome, RUST_LOG: "error" },
    stdio: "ignore", windowsHide: true,
  });
  try {
    await waitForPort(port);
    const ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      const timer = setTimeout(() => { try { socket.close(); } catch { /* ignore */ } reject(new Error("websocket connect timeout")); }, 20_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(socket); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("app-server websocket error")); }, { once: true });
    });
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject, timer } = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(timer);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
    });
    const request = (method, params, timeoutMs = 30_000) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`timeout ${method}`)); }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: requestId, method, params }));
    });
    await request("initialize", {
      clientInfo: { name: "native-config-validate", title: "Native Config Validate", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    const config = await request("config/read", { includeLayers: true, cwd });
    const models = await request("model/list", { limit: 100, includeHidden: true });
    ws.close();
    return { config, models };
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    await new Promise((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(resolve, 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

function layerConfigs(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) layerConfigs(item, out);
    return out;
  }
  if (value.openai_base_url || value.model_catalog_json) out.push(value);
  for (const item of Object.values(value)) if (item && typeof item === "object") layerConfigs(item, out);
  return out;
}

function baseUrlFacts(url) {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, port: parsed.port ? Number(parsed.port) : null, loopback: parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" };
  } catch {
    return null;
  }
}

async function main() {
  const sourceHome = path.resolve(arg("source-home", process.env.CODEX_HOME || path.join(os.homedir(), ".codex")));
  const sourceConfig = path.join(sourceHome, "config.toml");
  const sourceCache = path.join(sourceHome, "models_cache.json");
  if (!existsSync(sourceConfig)) throw new Error(`source config.toml is missing at ${sourceConfig}`);
  if (!existsSync(sourceCache)) throw new Error(`source models_cache.json is missing at ${sourceCache}`);
  const rawSource = readFileSync(sourceConfig, "utf8");
  const mainModel = rootValue(rawSource, "model");
  const mainProvider = rootValue(rawSource, "model_provider");
  if (!mainModel) throw new Error("source config.toml has no root model");

  const temp = mkdtempSync(path.join(os.tmpdir(), "native-config-read-"));
  const home = path.join(temp, "codex-home");
  const workspace = path.join(temp, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  try {
    copyFileSync(sourceCache, path.join(home, "models_cache.json"));
    const fixtureConfig = [
      `model = ${JSON.stringify(mainModel)}`,
      `model_provider = ${JSON.stringify(mainProvider || "openai")}`,
      'approval_policy = "never"',
      'sandbox_mode = "workspace-write"',
      "",
      "[features]",
      "multi_agent = true",
      "",
      '[plugins."last-table"]',
      "enabled = true",
      "",
    ].join("\n");
    writeFileSync(path.join(home, "config.toml"), fixtureConfig, "utf8");

    const fakeState = { port: 43119, token: "fixture-local-only", pid: 1 };
    const installed = await install({ codexHome: home, startGateway: false, autostart: false, gatewayState: fakeState });
    const installedText = readFileSync(path.join(home, "config.toml"), "utf8");
    const firstSession = await appServerSession({ codexHome: home, cwd: workspace });
    const layers = layerConfigs(firstSession.config);
    const routingLayer = layers.find((layer) => layer.openai_base_url && layer.model_catalog_json);
    if (!routingLayer) throw new Error("config/read did not expose the managed routing layer");
    const urlFacts = baseUrlFacts(routingLayer.openai_base_url);
    if (!urlFacts?.loopback) throw new Error("managed base URL is not loopback");
    const effective = firstSession.config.config || {};
    const modelListText = JSON.stringify(firstSession.models);
    const checks = {
      effective_main_model_preserved: effective.model === mainModel,
      effective_provider_preserved: (effective.model_provider || "openai") === (mainProvider || "openai"),
      catalog_loaded: routingLayer.model_catalog_json === installed.catalog,
      model_list_has_deepseek: modelListText.includes(PICKER_SLUG),
      base_url_loopback: urlFacts.loopback,
      base_url_has_capability_path: new URL(routingLayer.openai_base_url).pathname.length > 1,
      multi_table_preserved: installedText.includes('[plugins."last-table"]') && installedText.includes("[features]"),
      managed_block_at_root: installedText.indexOf("sol-luna-native-gateway begin") < installedText.indexOf("[features]"),
    };

    const postRoot = installedText.replace(/\n\[features\]/, '\npost_install_root = "keep"\n\n[features]');
    writeFileSync(path.join(home, "config.toml"), `${postRoot}\n[user.added]\nvalue = 1\n`, "utf8");
    await rollback({ codexHome: home, stop: false, removeStartup: false });
    const rolledText = readFileSync(path.join(home, "config.toml"), "utf8");
    const secondSession = await appServerSession({ codexHome: home, cwd: workspace });
    const secondEffective = secondSession.config.config || {};
    const rolledChecks = {
      effective_main_model_preserved: secondEffective.model === mainModel,
      managed_block_removed: !rolledText.includes("sol-luna-native-gateway begin"),
      post_install_root_preserved: /^\s*post_install_root\s*=/m.test(rolledText),
      post_install_table_preserved: rolledText.includes("[user.added]"),
    };
    const pass = Object.values(checks).every(Boolean) && Object.values(rolledChecks).every(Boolean);
    process.stdout.write(`${JSON.stringify({
      ok: pass,
      main_model: mainModel,
      effective_model: effective.model,
      provider: effective.model_provider || "openai",
      catalog_path: installed.catalog,
      base_url: { host: urlFacts.host, port: urlFacts.port, capability_hidden: true },
      checks,
      rollback: rolledChecks,
    }, null, 2)}\n`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    try { rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
