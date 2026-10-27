import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PICKER_SLUG } from "./native-routing.mjs";
import { catalogPath, mergeCatalog, readCatalogCache, writeCatalog } from "./native-catalog.mjs";
import { ensureGateway, gatewayPaths, stopGateway } from "./native-gateway-manager.mjs";
import { installAutostart, removeAutostart } from "./native-autostart.mjs";

const MARKER_BEGIN = "# sol-luna-native-gateway begin";
const MARKER_END = "# sol-luna-native-gateway end";
const AGENT_MARKER = "# Managed by sol-luna-native-gateway";
const MANIFEST = "install-manifest.json";
const ROOT_KEYS = ["openai_base_url", "model_catalog_json"];

export function resolveCodexHome(explicit) {
  return path.resolve(explicit || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function backupDir(codexHome) { return path.join(codexHome, "sol-luna-native-backup"); }
function manifestPath(codexHome) { return path.join(backupDir(codexHome), MANIFEST); }
function installedConfigPath(codexHome) { return path.join(codexHome, "config.toml"); }
function installedAgentPath(codexHome) { return path.join(codexHome, "agents", "native_deepseek.toml"); }

export function readManifest(codexHome) {
  const file = manifestPath(codexHome);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, file);
}

function readText(file, fallback = "") {
  try { return readFileSync(file, "utf8"); } catch { return fallback; }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function removeManagedBlock(content) {
  return content.replace(
    new RegExp(`\\n?${escapeRegExp(MARKER_BEGIN)}[\\s\\S]*?${escapeRegExp(MARKER_END)}\\n?`, "g"),
    "\n",
  );
}

function splitRoot(content) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const index = lines.findIndex((line) => /^\s*\[/.test(line));
  return { lines, firstTable: index < 0 ? lines.length : index };
}

function rootValue(content, key) {
  const { lines, firstTable } = splitRoot(content);
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*$`);
  for (let i = 0; i < firstTable; i += 1) {
    const match = pattern.exec(lines[i]);
    if (!match) continue;
    try { return JSON.parse(match[1]); } catch { return match[1].trim().replace(/^"|"$/g, ""); }
  }
  return null;
}

export function readPriorRoot(content) {
  return Object.fromEntries(ROOT_KEYS.map((key) => [key, rootValue(content, key)]));
}

export function hasRootKeyOutsideBlock(content) {
  const outside = removeManagedBlock(content);
  return ROOT_KEYS.some((key) => rootValue(outside, key) !== null);
}

function rootWithKeys(content, values) {
  const base = removeManagedBlock(content);
  const { lines, firstTable } = splitRoot(base);
  const root = lines.slice(0, firstTable);
  const rest = lines.slice(firstTable);
  const filtered = root.filter((line) => !ROOT_KEYS.some((key) => new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line)));
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    filtered.push(`${key} = ${JSON.stringify(String(value))}`);
  }
  return [...filtered, ...rest].join("\n").replace(/\n{3,}/g, "\n\n");
}

export function composeConfig(content, { baseUrl, catalog }) {
  const base = removeManagedBlock(content);
  const block = [
    MARKER_BEGIN,
    `openai_base_url = ${JSON.stringify(baseUrl)}`,
    `model_catalog_json = ${JSON.stringify(catalog)}`,
    MARKER_END,
  ];
  const { lines, firstTable } = splitRoot(base);
  const root = lines.slice(0, firstTable).join("\n").trimEnd();
  const rest = lines.slice(firstTable).join("\n").trimStart();
  return `${root}${root ? "\n\n" : ""}${block.join("\n")}${rest ? `\n\n${rest}` : ""}\n`;
}

export function agentToml() {
  return [
    AGENT_MARKER,
    'name = "native_deepseek"',
    'description = "DeepSeek Flash native collaboration child through the local native gateway"',
    'model_provider = "openai"',
    `model = "${PICKER_SLUG}"`,
    "",
    'developer_instructions = """',
    "Complete the bounded task assigned by the parent.",
    "Report in Simplified Chinese for user-visible progress and results.",
    '"""',
    "",
  ].join("\n");
}

export function planInstall({ codexHome, baseUrl, catalog, manifest = null }) {
  const config = installedConfigPath(codexHome);
  const content = readText(config);
  if (hasRootKeyOutsideBlock(content)) {
    throw new Error("config.toml already has openai_base_url or model_catalog_json outside the managed block; refusing to overwrite user-owned routing.");
  }
  const agent = installedAgentPath(codexHome);
  if (existsSync(agent) && !readText(agent).startsWith(AGENT_MARKER)) {
    throw new Error("An unowned agents/native_deepseek.toml already exists; refusing to overwrite it");
  }
  if (existsSync(catalog) && !manifest) {
    throw new Error("A catalog file already exists without an install manifest; refusing to overwrite it");
  }
  return {
    codex_home: codexHome,
    config,
    catalog,
    agent,
    backup: path.join(backupDir(codexHome), "config.toml.bak"),
    managed_base_url: baseUrl ? "loopback native gateway" : null,
    existing_managed_block: content.includes(MARKER_BEGIN),
    prior_root: manifest?.prior_root || readPriorRoot(content),
  };
}

function writeConfigAtomic(file, content) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, file);
}

export async function install({
  codexHome = resolveCodexHome(),
  gatewayDir,
  dryRun = false,
  startGateway = true,
  gatewayState = null,
  autostart = false,
} = {}) {
  const home = path.resolve(codexHome);
  const catalog = catalogPath(home);
  const manifestBefore = readManifest(home);
  if (dryRun) {
    const plan = planInstall({ codexHome: home, baseUrl: null, catalog, manifest: manifestBefore });
    mergeCatalog(readCatalogCache(home));
    return plan;
  }

  // Complete the pure preflight and catalog build before starting or writing
  // anything. A conflict must not leave a gateway or a half-written config.
  planInstall({ codexHome: home, baseUrl: null, catalog, manifest: manifestBefore });
  const catalogData = mergeCatalog(readCatalogCache(home));
  const state = gatewayState || (startGateway ? (await ensureGateway({ paths: gatewayPaths(gatewayDir) })).state : null);
  if (!state?.port || !state?.token) throw new Error("A running native gateway state is required for install");
  const plan = planInstall({ codexHome: home, baseUrl: `http://127.0.0.1:${state.port}/${state.token}/v1`, catalog, manifest: manifestBefore });
  const original = readText(plan.config);
  const backup = plan.backup;
  mkdirSync(backupDir(home), { recursive: true, mode: 0o700 });
  if (!manifestBefore && !existsSync(backup)) writeFileSync(backup, original, { encoding: "utf8", mode: 0o600 });

  const agentExisted = existsSync(plan.agent);
  const catalogExisted = existsSync(catalog);
  try {
    writeCatalog(catalog, catalogData);
    mkdirSync(path.dirname(plan.agent), { recursive: true, mode: 0o700 });
    writeFileSync(plan.agent, agentToml(), { encoding: "utf8", mode: 0o600 });
    const baseUrl = `http://127.0.0.1:${state.port}/${state.token}/v1`;
    const next = composeConfig(original, { baseUrl, catalog });
    writeConfigAtomic(plan.config, next);
    writeJson(manifestPath(home), {
      version: 1,
      installed_at: new Date().toISOString(),
      config_backup: backup,
      catalog,
      agent: plan.agent,
      prior_root: plan.prior_root,
      gateway_identity: { port: state.port, pid: state.pid, log: state.log || null },
    });
    if (autostart) installAutostart();
  } catch (error) {
    if (!manifestBefore) {
      if (!agentExisted) rmSync(plan.agent, { force: true });
      if (!catalogExisted) rmSync(catalog, { force: true });
      rmSync(manifestPath(home), { force: true });
      if (existsSync(backup)) writeFileSync(plan.config, readFileSync(backup, "utf8"), { encoding: "utf8", mode: 0o600 });
    }
    throw error;
  }
  return { ...plan, installed: true, catalog_models: catalogData.models.map((model) => model.slug) };
}

function removeOwned(file, marker) {
  if (!existsSync(file)) return false;
  if (!readText(file).startsWith(marker)) return false;
  rmSync(file, { force: true });
  return true;
}

export async function rollback({ codexHome = resolveCodexHome(), gatewayDir, stop = true, removeStartup = true } = {}) {
  const home = path.resolve(codexHome);
  const manifest = readManifest(home);
  if (!manifest) throw new Error("No native gateway install manifest exists");
  if (stop) {
    try { await stopGateway({ paths: gatewayPaths(gatewayDir) }); } catch { /* file rollback still proceeds */ }
  }
  const config = installedConfigPath(home);
  const current = readText(config);
  const prior = manifest.prior_root || {};
  const next = rootWithKeys(current, prior);
  writeConfigAtomic(config, next);
  removeOwned(manifest.agent, AGENT_MARKER);
  rmSync(manifest.catalog, { force: true });
  rmSync(manifestPath(home), { force: true });
  if (removeStartup) removeAutostart();
  return { rolled_back: true, config, catalog: manifest.catalog, agent: manifest.agent };
}

export async function uninstall({ codexHome = resolveCodexHome(), gatewayDir } = {}) {
  return rollback({ codexHome, gatewayDir, stop: true });
}

async function main(argv) {
  const command = argv[0] || "status";
  const at = argv.indexOf("--codex-home");
  const codexHome = at >= 0 ? argv[at + 1] : undefined;
  const dirAt = argv.indexOf("--gateway-dir");
  const gatewayDir = dirAt >= 0 ? argv[dirAt + 1] : undefined;
  if (command === "install") {
    const result = await install({ codexHome, gatewayDir, dryRun: argv.includes("--dry-run"), autostart: argv.includes("--autostart") });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "uninstall") {
    process.stdout.write(`${JSON.stringify(await uninstall({ codexHome, gatewayDir }), null, 2)}\n`);
    return;
  }
  if (command === "rollback") {
    process.stdout.write(`${JSON.stringify(await rollback({ codexHome, gatewayDir }), null, 2)}\n`);
    return;
  }
  if (command === "status") {
    const home = resolveCodexHome(codexHome);
    process.stdout.write(`${JSON.stringify({ codex_home: home, manifest: readManifest(home) }, null, 2)}\n`);
    return;
  }
  throw new Error("usage: native-install.mjs <install|uninstall|rollback|status> [--dry-run] [--codex-home PATH] [--gateway-dir PATH]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
