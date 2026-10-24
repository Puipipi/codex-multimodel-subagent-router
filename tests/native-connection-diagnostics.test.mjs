import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { collectConnectionDiagnostics, readConnectionDiagnosticsSnapshot } from "../scripts/native-connection-diagnostics.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "connection-diagnostics-"));
const eq = (a, b, msg) => assert.equal(a, b, msg);
const dbPath = path.join(root, "logs_2.sqlite");
function createDb() {
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, level TEXT, target TEXT, feedback_log_body TEXT, thread_id TEXT)");
  return db;
}
function add(db, ts, target, message) {
  db.prepare("INSERT INTO logs(ts,ts_nanos,level,target,feedback_log_body,thread_id) VALUES(?,?,?,?,?,?)")
    .run(Math.floor(ts / 1000), (ts % 1000) * 1_000_000, "WARN", target, message, /thread_id=([^ ]+)/.exec(message)?.[1] ?? null);
}
try {
  const home = root;
  const stateDir = path.join(root, "plugin-state");
  const fixedNow = Date.UTC(2026, 9, 24, 8, 0, 0);
  const off = await collectConnectionDiagnostics({ codexHome: path.join(root, "missing"), stateDir, now: fixedNow, enabled: false });
  eq(off.available, false, "disabled short-circuits as unavailable");
  await assert.rejects(readFile(path.join(stateDir, "connection-diagnostics.json")));

  const db = createDb();
  const base = fixedNow - 10_000;
  for (let n = 1; n <= 5; n++) { add(db, base + n * 500, "codex_core::client", `sampling request failed; retry ${n}/5 thread_id=01a1491e-cc5c-7743-8d1a-a935dcd54cb9 process_uuid=feedface-1234`); add(db, base + n * 500 + 100, "codex_api::responses_websocket", `websocket closed by server before response.completed thread_id=01a1491e-cc5c-7743-8d1a-a935dcd54cb9`); }
  add(db, base + 3_000, "codex_core::client", "falling back to HTTP thread_id=01a1491e-cc5c-7743-8d1a-a935dcd54cb9 https://secret.example/v1/responses?api_key=do-not-leak");
  add(db, base + 3_500, "codex_core::client", "sampling request failed; retry 1/5 websocket closed thread_id=other-thread process_uuid=other-process");
  add(db, base + 3_700, "codex_core::client", "falling back to HTTP thread_id=child-thread");
  add(db, base + 4_000, "codex_core::client", "request failed with secret_key=sk-SUPERSECRET authorization=Bearer private");
  db.close();

  const result = await collectConnectionDiagnostics({ codexHome: home, stateDir, now: fixedNow, enabled: true, parentThreadId: "01a1491e-cc5c-7743-8d1a-a935dcd54cb9", registeredChildThreadIds: ["child-thread"] });
  eq(result.available, true, "real SQLite store is read");
  eq(result.events.length, 13, "only classified events are kept");
  eq(result.events.filter(e => e.errorClass === "sampling_retry").length, 6, "retry rows including unrelated thread are classified");
  eq(result.events.filter(e => e.errorClass === "websocket_closed_before_completed").length, 5, "five WS close events are classified");
  eq(result.events.find(e => e.errorClass === "http_fallback").correlation, "parent", "explicit matching parent ID is recognized");
  eq(result.events.find(e => e.threadHash && e.correlation === "registered_child")?.correlation, "registered_child", "registered child is explicitly recognized");
  eq(result.events.find(e => e.retryNumber === 1 && e.correlation === "other_or_unknown")?.correlation, "other_or_unknown", "unrelated chats are never attributed to parent");
  const serialized = JSON.stringify(result);
  for (const secret of ["secret.example", "api_key", "do-not-leak", "SUPERSECRET", "authorization", "feedface-1234", "other-thread", "01a1491e-cc5c-7743-8d1a-a935dcd54cb9", "falling back to HTTP"]) assert.ok(!serialized.includes(secret), `output omits ${secret}`);
  const snapshot = await readConnectionDiagnosticsSnapshot(stateDir);
  eq(JSON.stringify(snapshot), JSON.stringify(result), "atomic state round-trips sanitized events");
  const rawState = await readFile(path.join(stateDir, "connection-diagnostics.json"), "utf8");
  assert.ok(!rawState.includes("secret.example"), "persisted snapshot never stores raw URLs");

  const again = await collectConnectionDiagnostics({ codexHome: home, stateDir, now: fixedNow + 1_000, enabled: true });
  eq(again.events.length, 0, "cursor prevents duplicate rows");
  eq(again.rootCause, "uncertain", "missing terminal response never implies recovery or a root cause");

  const missing = await collectConnectionDiagnostics({ codexHome: path.join(root, "absent"), stateDir, now: fixedNow, enabled: true });
  eq(missing.available, false, "missing database is explicitly unavailable");
  const emptyHome = path.join(root, "empty");
  const emptyDb = path.join(emptyHome, "logs_2.sqlite");
  const emptyRoot = path.join(root, "empty-state");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(emptyHome));
  const empty = new DatabaseSync(emptyDb); empty.exec("CREATE TABLE logs (id INTEGER, ts INTEGER, ts_nanos INTEGER, level TEXT, target TEXT, feedback_log_body TEXT, thread_id TEXT)"); empty.close();
  const emptyResult = await collectConnectionDiagnostics({ codexHome: emptyHome, stateDir: emptyRoot, now: fixedNow, enabled: true });
  eq(emptyResult.available, true, "empty SQLite is a valid available source"); eq(emptyResult.events.length, 0, "empty store returns no events");
  const badHome = path.join(root, "bad"); await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(badHome));
  await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(badHome, "logs_2.sqlite"), "not sqlite"));
  const bad = await collectConnectionDiagnostics({ codexHome: badHome, stateDir: path.join(root, "bad-state"), now: fixedNow, enabled: true });
  eq(bad.available, false, "unreadable or locked database fails closed without throwing");
  const lockHome = path.join(root, "locked"); await import("node:fs/promises").then(({ mkdir }) => mkdir(lockHome));
  const lockDb = new DatabaseSync(path.join(lockHome, "logs_2.sqlite"));
  lockDb.exec("CREATE TABLE logs (ts INTEGER, ts_nanos INTEGER, target TEXT, message TEXT, thread_id TEXT); BEGIN EXCLUSIVE");
  const locked = await collectConnectionDiagnostics({ codexHome: lockHome, stateDir: path.join(root, "locked-state"), now: fixedNow, enabled: true });
  eq(locked.available, false, "exclusive lock is reported unavailable without throwing");
  lockDb.exec("ROLLBACK"); lockDb.close();

  const rotateHome = path.join(root, "rotate"); await import("node:fs/promises").then(({ mkdir }) => mkdir(rotateHome));
  const rotateDb = new DatabaseSync(path.join(rotateHome, "logs_2.sqlite"));
  rotateDb.exec("CREATE TABLE logs (ts INTEGER, ts_nanos INTEGER, level TEXT, target TEXT, feedback_log_body TEXT, thread_id TEXT)");
  add(rotateDb, fixedNow - 4_000, "codex_core::client", "falling back to HTTP"); rotateDb.close();
  const rotateState = path.join(root, "rotate-state");
  await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(rotateState));
  await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(rotateState, "connection-diagnostics.json"), JSON.stringify({ cursor: { rowid: 100, maxTimestampMs: fixedNow - 1000 }, events: [] })));
  const afterRotation = await collectConnectionDiagnostics({ codexHome: rotateHome, stateDir: rotateState, now: fixedNow, enabled: true });
  eq(afterRotation.events.length, 1, "lower rowid after log rotation resets the cursor");
  console.log("native connection diagnostics tests passed");
} finally {
  for (let attempt = 0; attempt < 8; attempt++) {
    try { await rm(root, { recursive: true, force: true }); break; }
    catch (error) { if (error.code !== "EBUSY" || attempt === 7) { if (error.code === "EBUSY") break; throw error; } await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
}
