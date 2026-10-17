import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  autostartScript, installAutostart, removeAutostart, startupDirectory,
} from "../scripts/native-autostart.mjs";

let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const match = (value, pattern, message) => { assert.match(value, pattern, message); checks += 1; };

const dir = await mkdtemp(path.join(os.tmpdir(), "native-autostart-"));
try {
  const installed = installAutostart({ startupDir: dir });
  ok(existsSync(installed.file), "autostart file is written");
  match(path.basename(installed.file), /\.vbs$/, "autostart uses a hidden VBS launcher");
  const text = readFileSync(installed.file, "utf8");
  match(text, /native-gateway-manager\.mjs/, "autostart targets the manager");
  match(text, /0, False/, "autostart launches hidden and non-blocking");
  equal(startupDirectory(dir), path.resolve(dir), "startup directory is explicit and testable");
  match(autostartScript(), /ensure --json/, "login startup runs ensure before Codex");
  const isolatedDir = path.join(dir, 'native runtime "one');
  const isolatedScript = autostartScript({ gatewayDir: isolatedDir });
  match(isolatedScript, /--dir/, "isolated gateway directory is passed to the manager");
  match(isolatedScript, /--dir ""/, "gateway directory argument is quoted in VBScript command");
  match(isolatedScript, /native runtime ""one""/, "gateway path quotes are escaped for VBScript");
  const isolatedInstall = installAutostart({ startupDir: dir, gatewayDir: isolatedDir });
  match(readFileSync(isolatedInstall.file, "utf8"), /--dir/, "installer writes isolated gateway directory option");
  const removed = removeAutostart({ startupDir: dir });
  equal(removed.removed, true, "autostart can be removed");
  equal(existsSync(installed.file), false, "autostart file is gone");
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`PASS ${checks} native autostart assertions`);
