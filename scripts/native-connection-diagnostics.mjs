import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STATE_FILE = "connection-diagnostics.json";
const MAX_ROWS = 500;
const MAX_EVENTS = 128;
const WINDOW_MS = 72 * 60 * 60 * 1000;
const sha = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
const safeIso = (seconds, nanos = 0) => {
  const ms = Number(seconds) * 1000 + Math.floor(Number(nanos || 0) / 1e6);
  return Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : null;
};
const numericCapture = (text, patterns, max = Number.MAX_SAFE_INTEGER) => {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isSafeInteger(n) && n >= 0 && n <= max) return n;
  }
  return null;
};
function classify(text) {
  const s = text.toLowerCase();
  if (/compaction.{0,80}(retry|failed)|(?:retry|failed).{0,80}compaction/.test(s)) return "compaction_retry";
  if (/falling back to http|fallback.{0,40}http|http.{0,40}fallback/.test(s)) return "http_fallback";
  if (/payload.{0,40}too large|request body.{0,40}too large|request.{0,30}exceeds.{0,30}(?:limit|maximum)/.test(s)) return "payload_too_large";
  if (/\bhttp(?: status| code| response)?\s*[:=]?\s*5\d\d\b|\bstatus\s*[:=]\s*5\d\d\b/.test(s)) return "http_5xx";
  if (/retry(?:ing)?\s+(?:sampling|request)|sampling.{0,40}retry|retry\s+\d+\s*\/\s*\d+/.test(s)) return "sampling_retry";
  if (/websocket.{0,100}(?:closed|close)|(?:closed|close).{0,100}websocket|stream disconnected before completion/.test(s)) return "websocket_closed_before_completed";
  return null;
}
function makeEvent(row, parentThreadId, registeredChildThreadIds) {
  const raw = typeof row.message === "string" ? row.message : (typeof row.feedback_log_body === "string" ? row.feedback_log_body : "");
  const text = `${String(row.target ?? "")} ${raw}`;
  const errorClass = classify(text);
  if (!errorClass) return null;
  const tid = row.thread_id == null || row.thread_id === "" ? null : String(row.thread_id);
  const children = new Set(registeredChildThreadIds.map(String));
  let correlation = "other_or_unknown";
  if (tid && parentThreadId && tid === String(parentThreadId)) correlation = "parent";
  else if (tid && children.has(tid)) correlation = "registered_child";
  const process = /\bprocess_uuid\s*[:=]\s*["']?([0-9a-f-]{8,})/i.exec(raw)?.[1] ?? null;
  const retryNumber = numericCapture(text, [/\bretry(?:ing)?\s+(?:sampling|request)\D{0,12}(\d+)\s*\//i, /\bretry\s+(\d+)\s*\//i], 100);
  const httpStatus = numericCapture(text, [/\bhttp(?: status| code| response)?\s*[:=]?\s*(\d{3})\b/i, /\bstatus\s*[:=]\s*(\d{3})\b/i], 599);
  const closeCode = numericCapture(text, [/\b(?:websocket\s+)?close(?:d)?\s+code\s*[:=]\s*(\d{3,5})\b/i], 49999);
  const requestBytes = numericCapture(text, [/\b(?:request|body|payload)(?:_size| size| bytes)?\s*[:=]\s*(\d+)\s*(?:bytes?)?\b/i, /\b(\d+)\s+bytes\b/i]);
  const timestampUtc = safeIso(row.ts, row.ts_nanos);
  if (!timestampUtc) return null;
  return {
    timestampUtc,
    target: /^[A-Za-z0-9_:.-]{1,96}$/.test(String(row.target ?? "")) ? String(row.target) : "unknown",
    errorClass,
    retryNumber,
    httpStatus: errorClass === "http_5xx" ? httpStatus : null,
    closeCode: errorClass === "websocket_closed_before_completed" ? closeCode : null,
    requestBytes: errorClass === "payload_too_large" ? requestBytes : null,
    threadHash: tid ? sha(tid) : null,
    processHash: process ? sha(process) : null,
    correlation,
  };
}
function sanitizeEvent(event) {
  const classes = ["websocket_closed_before_completed", "sampling_retry", "http_fallback", "payload_too_large", "http_5xx", "compaction_retry"];
  if (!event || !classes.includes(event.errorClass) || typeof event.timestampUtc !== "string" || !Number.isFinite(Date.parse(event.timestampUtc)) || typeof event.target !== "string" || !/^[A-Za-z0-9_:.-]{1,96}$/.test(event.target) || !["parent", "registered_child", "other_or_unknown"].includes(event.correlation)) return null;
  const bounded = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max ? n : null;
  const hash = (s) => typeof s === "string" && /^[a-f0-9]{16}$/.test(s) ? s : null;
  return { timestampUtc: new Date(event.timestampUtc).toISOString(), target: event.target, errorClass: event.errorClass, retryNumber: bounded(event.retryNumber, 100), httpStatus: bounded(event.httpStatus, 599), closeCode: bounded(event.closeCode, 49999), requestBytes: bounded(event.requestBytes, Number.MAX_SAFE_INTEGER), threadHash: hash(event.threadHash), processHash: hash(event.processHash), correlation: event.correlation };
}
function safeFailure() {
  return { available: false, rootCause: "uncertain", events: [] };
}
async function loadState(stateDir) {
  try {
    const value = JSON.parse(await readFile(path.join(stateDir, STATE_FILE), "utf8"));
    return value && typeof value === "object" && Array.isArray(value.events) ? { available: true, cursor: { rowid: Number.isSafeInteger(value.cursor?.rowid) ? value.cursor.rowid : 0, maxTimestampMs: Number.isFinite(value.cursor?.maxTimestampMs) ? value.cursor.maxTimestampMs : 0 }, events: value.events.map((event) => sanitizeEvent(event)).filter(Boolean).slice(-MAX_EVENTS) } : null;
  } catch { return null; }
}
async function atomicWrite(stateDir, snapshot) {
  await mkdir(stateDir, { recursive: true });
  const target = path.join(stateDir, STATE_FILE);
  const temp = path.join(stateDir, `.connection-diagnostics-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temp, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temp, target);
}

/** Read and classify a bounded batch of Rust log rows; raw log text never leaves this function. */
export async function collectConnectionDiagnostics({ codexHome, stateDir, now = Date.now(), enabled = false, parentThreadId = null, registeredChildThreadIds = [] } = {}) {
  if (!enabled) return safeFailure();
  if (!codexHome || !stateDir || !Number.isFinite(Number(now))) return safeFailure();
  const dbPath = path.join(codexHome, "logs_2.sqlite");
  const prior = await loadState(stateDir);
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 50 });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='logs'").all();
    if (!tables.length) return safeFailure();
    const columns = new Set(db.prepare("PRAGMA table_info(logs)").all().map((r) => String(r.name)));
    if (!columns.has("ts") || !columns.has("target")) return safeFailure();
    const bodyCol = columns.has("feedback_log_body") ? "feedback_log_body" : (columns.has("message") ? "message" : null);
    if (!bodyCol) return safeFailure();
    const select = ["rowid AS _rowid", "ts", columns.has("ts_nanos") ? "ts_nanos" : "0 AS ts_nanos", "target", ...(columns.has("message") ? ["message"] : []), ...(columns.has("feedback_log_body") ? ["feedback_log_body"] : []), columns.has("thread_id") ? "thread_id" : "NULL AS thread_id"].join(", ");
    const maxRow = db.prepare("SELECT COALESCE(MAX(rowid),0) AS id FROM logs").get().id;
    const previousCursor = Number(prior?.cursor?.rowid ?? 0);
    const previousTime = Number(prior?.cursor?.maxTimestampMs ?? 0);
    const latestTime = Number(db.prepare("SELECT COALESCE(MAX(ts),0) AS ts FROM logs").get().ts) * 1000;
    const rotated = Number(maxRow) < previousCursor || (previousTime > 0 && latestTime > 0 && latestTime < previousTime - 1000);
    const cursor = rotated ? 0 : previousCursor;
    const floorSec = Math.floor((Number(now) - WINDOW_MS) / 1000);
    const rows = db.prepare(`SELECT ${select} FROM logs WHERE rowid > ? AND ts >= ? ORDER BY rowid ASC LIMIT ${MAX_ROWS}`).all(cursor, floorSec);
    const events = rows.map((row) => makeEvent(row, parentThreadId, registeredChildThreadIds)).filter(Boolean);
    const allEvents = [...(rotated ? [] : (prior?.events ?? [])), ...events].slice(-MAX_EVENTS);
    const nextCursor = rows.length ? Number(rows.at(-1)._rowid) : (rotated ? 0 : previousCursor);
    const snapshot = {
      available: true,
      rootCause: "uncertain",
      cursor: { rowid: nextCursor, maxTimestampMs: Math.max(previousTime, latestTime) },
      events: allEvents,
    };
    await atomicWrite(stateDir, snapshot);
    return { available: true, rootCause: "uncertain", events };
  } catch {
    return safeFailure();
  } finally {
    db?.close();
  }
}

export async function readConnectionDiagnosticsSnapshot(stateDir) {
  const value = await loadState(stateDir);
  if (!value) return safeFailure();
  return { available: value.available === true, rootCause: "uncertain", events: Array.isArray(value.events) ? value.events.slice(-MAX_EVENTS) : [] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const collect = process.argv.includes("--collect");
  const json = process.argv.includes("--json");
  let result = safeFailure();
  if (collect && json) {
    const codexHome = process.env.CODEX_HOME;
    const stateDir = process.env.CODEX_CONNECTION_DIAGNOSTICS_STATE;
    result = await collectConnectionDiagnostics({ codexHome, stateDir, enabled: true, parentThreadId: process.env.CODEX_THREAD_ID ?? null });
  } else if (json) {
    result = await readConnectionDiagnosticsSnapshot(process.env.CODEX_CONNECTION_DIAGNOSTICS_STATE ?? "");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
