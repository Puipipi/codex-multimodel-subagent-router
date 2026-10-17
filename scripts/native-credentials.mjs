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

const ACCOUNT_RECORD = "deepseek-account-platform/default";

function scalar(source, label) {
  let value = source.trim();
  if (!value) return "";
  if (value[0] === "'") {
    let out = "";
    for (let i = 1; i < value.length; i += 1) {
      if (value[i] !== "'") { out += value[i]; continue; }
      if (value[i + 1] === "'") { out += "'"; i += 1; continue; }
      if (value.slice(i + 1).trim() && !value.slice(i + 1).trimStart().startsWith("#")) {
        throw new Error(`Invalid DSH ${label} scalar`);
      }
      return out;
    }
    throw new Error(`Invalid DSH ${label} scalar`);
  }
  if (value[0] === '"') {
    let end = -1;
    let escaped = false;
    for (let i = 1; i < value.length; i += 1) {
      if (escaped) { escaped = false; continue; }
      if (value[i] === "\\") { escaped = true; continue; }
      if (value[i] === '"') { end = i; break; }
    }
    if (end < 0 || (value.slice(end + 1).trim() && !value.slice(end + 1).trimStart().startsWith("#"))) {
      throw new Error(`Invalid DSH ${label} scalar`);
    }
    try { return JSON.parse(value.slice(0, end + 1)); }
    catch { throw new Error(`Invalid DSH ${label} scalar`); }
  }
  const comment = /\s+#/.exec(value);
  if (comment) value = value.slice(0, comment.index).trimEnd();
  if (/[\[\]{},&*!|>]/.test(value) || /:\s/.test(value) || /^(?:null|~)$/i.test(value)) {
    if (/^(?:null|~)$/i.test(value)) return "";
    throw new Error(`Invalid DSH ${label} scalar`);
  }
  return value;
}

// Parses only the one documented DSH account grant shape. It is intentionally
// not a general YAML parser and never includes source values in diagnostics.
function parseAccountGrant(text) {
  const lines = text.split(/\r?\n/);
  let section = null;
  let recordCount = 0;
  let inRecord = false;
  let inPayload = false;
  let payloadSeen = false;
  const fields = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const rootSection = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (rootSection) {
      section = rootSection[1];
      if (inRecord) inRecord = false;
      inPayload = false;
      const rootValue = rootSection[2].trim();
      if (section === "records" && rootValue && !rootValue.startsWith("#")) {
        if (rootValue.includes(ACCOUNT_RECORD)) throw new Error("Unsupported DSH DeepSeek records format");
        section = "records-inline";
      }
      continue;
    }
    if (section !== "records") continue;
    const record = /^ {2}(?:deepseek-account-platform\/default|['"]deepseek-account-platform\/default['"]):(?:\s*(.*))?$/.exec(line);
    if (record) {
      recordCount += 1;
      if (recordCount > 1) throw new Error("Duplicate DSH DeepSeek account record");
      if (record[1] && !record[1].startsWith("#")) throw new Error("Unsupported DSH DeepSeek account record format");
      inRecord = true; inPayload = false; continue;
    }
    if (!inRecord) continue;
    if (/^ {2}\S/.test(line)) { inRecord = false; inPayload = false; continue; }
    let match = /^ {4}kind\s*:\s*(.*)$/.exec(line);
    if (match) {
      if (fields.has("kind")) throw new Error("Duplicate DSH DeepSeek account field");
      fields.set("kind", scalar(match[1], "account kind"));
      continue;
    }
    match = /^ {4}payload\s*:\s*(.*)$/.exec(line);
    if (match) {
      if (payloadSeen) throw new Error("Duplicate DSH DeepSeek account payload");
      payloadSeen = true;
      if (scalar(match[1], "account payload")) throw new Error("Invalid DSH DeepSeek account payload");
      inPayload = true;
      continue;
    }
    match = /^ {6}(version|token|issuer)\s*:\s*(.*)$/.exec(line);
    if (match && inPayload) {
      if (fields.has(match[1])) throw new Error("Duplicate DSH DeepSeek account field");
      fields.set(match[1], scalar(match[2], `account ${match[1]}`));
    }
  }
  if (recordCount === 0) return null;
  if (fields.get("kind") !== "grant" || !payloadSeen
      || fields.get("version") !== "1"
      || typeof fields.get("token") !== "string" || !fields.get("token")
      || fields.get("issuer") !== "https://platform.deepseek.com") {
    throw new Error("Invalid DSH DeepSeek account grant or issuer");
  }
  const token = fields.get("token");
  if (!/^[\x21-\x7e]+$/.test(token)) throw new Error("Invalid DSH DeepSeek account token");
  return token;
}

export function resolveDeepSeekAuth({ env = process.env, file, text } = {}) {
  let source = text;
  if (source === undefined) {
    const credentialFile = file || dshCredentialPath(env);
    if (!existsSync(credentialFile)) throw new Error("DSH DeepSeek credential file is missing");
    source = readFileSync(credentialFile, "utf8");
  }
  const accountToken = parseAccountGrant(source);
  if (accountToken) return { mode: "account", headers: { "x-dsh-auth-token": accountToken } };
  const refs = parseRefs(source);
  const key = refs.DEEPSEEK_API_KEY;
  if (typeof key !== "string" || !key) throw new Error("DeepSeek credential is not configured");
  return { mode: "api-key", headers: { authorization: `Bearer ${key}` } };
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
    resolveDeepSeekAuth({ env, file: credentialFile });
    return { present: true, path: credentialFile };
  } catch {
    return { present: false, path: credentialFile };
  }
}
