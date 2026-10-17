import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MANAGER = path.join(REPO_ROOT, "scripts", "native-gateway-manager.mjs");
const FILE_NAME = "sol-luna-native-gateway.vbs";

export function startupDirectory(explicit) {
  return path.resolve(explicit || path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
  ));
}

export function autostartFile(explicitDir) {
  return path.join(startupDirectory(explicitDir), FILE_NAME);
}

export function autostartScript() {
  return [
    "' Sol Luna native gateway: start hidden before the first Codex request.",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run """${process.execPath}"" ""${MANAGER}"" ensure --json", 0, False`,
    "",
  ].join("\r\n");
}

export function installAutostart({ startupDir } = {}) {
  const file = autostartFile(startupDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, autostartScript(), { encoding: "utf8", mode: 0o600 });
  return { installed: true, file, hidden: true };
}

export function removeAutostart({ startupDir } = {}) {
  const file = autostartFile(startupDir);
  const existed = existsSync(file);
  rmSync(file, { force: true });
  return { removed: existed, file };
}

export function autostartStatus({ startupDir } = {}) {
  const file = autostartFile(startupDir);
  if (!existsSync(file)) return { installed: false, file };
  return { installed: true, file, contents: readFileSync(file, "utf8") };
}

function main(argv) {
  const command = argv[0] || "status";
  const at = argv.indexOf("--startup-dir");
  const startupDir = at >= 0 ? argv[at + 1] : undefined;
  if (command === "install") process.stdout.write(`${JSON.stringify(installAutostart({ startupDir }))}\n`);
  else if (command === "remove") process.stdout.write(`${JSON.stringify(removeAutostart({ startupDir }))}\n`);
  else if (command === "status") process.stdout.write(`${JSON.stringify(autostartStatus({ startupDir }))}\n`);
  else throw new Error("usage: native-autostart.mjs <install|remove|status> [--startup-dir PATH]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
