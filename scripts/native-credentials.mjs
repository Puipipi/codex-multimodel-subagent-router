import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function dshCredentialPath(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, ".credentials.yaml");
}

function parseRefs(text) {
  const lines = text.split(/\r?\n/);
  const refsAt = lines.findIndex((line) => /^refs:\s*$/.test(line));
  if (refsAt < 0) throw new Error("DSH credentials file has no refs section");
  const refs = {};
  for (let i = refsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    const match = /^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replaceAll("''", "'");
    }
    refs[match[1]] = value;
  }
  return refs;
}

// Reads the existing DSH local credential store in-process. The value is held
// only in memory and never written to logs, state, catalogs, or responses.
export function readDeepSeekKey({ env = process.env, file } = {}) {
  const credentialFile = file || dshCredentialPath(env);
  if (!existsSync(credentialFile)) throw new Error("DSH DeepSeek credential file is missing");
  const refs = parseRefs(readFileSync(credentialFile, "utf8"));
  const value = refs.DEEPSEEK_API_KEY;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("DEEPSEEK_API_KEY is not configured in the DSH credential store");
  }
  return value;
}

export function credentialStatus({ env = process.env, file } = {}) {
  const credentialFile = file || dshCredentialPath(env);
  try {
    readDeepSeekKey({ env, file: credentialFile });
    return { present: true, path: credentialFile };
  } catch {
    return { present: false, path: credentialFile };
  }
}
