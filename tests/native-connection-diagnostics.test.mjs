import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { withFileLock } from "../scripts/plugin-state.mjs";
import { collectConnectionDiagnostics, readConnectionDiagnosticsSnapshot } from "../scripts/native-connection-diagnostics.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "connection-diagnostics-"));
const eq = (a, b, msg) => assert.equal(a, b, msg);
const stateFile = (dir, parent = null) => path.join(dir, `connection-diagnostics-${parent ? createHash("sha256").update(parent).digest("hex") : "unbound"}.json`);
const dbPath = path.join(root, "logs_2.sqlite");
function createDb(home = root) {
  const db = new DatabaseSync(path.join(home, "logs_2.sqlite"));
  db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, level TEXT, target TEXT, message TEXT, feedback_log_body TEXT, thread_id TEXT)");
  return db;
}
function add(db, ts, target, feedback, message = "") {
  const thread = /thread_id=([^ ]+)/.exec(feedback)?.[1] ?? /thread_id=([^ ]+)/.exec(message)?.[1] ?? null;
  db.prepare("INSERT INTO logs(ts,ts_nanos,level,target,message,feedback_log_body,thread_id) VALUES(?,?,?,?,?,?,?)")
    .run(Math.floor(ts / 1000), (ts % 1000) * 1_000_000, "WARN", target, message, feedback, thread);
}
try {
  const stateDir = path.join(root, "plugin-state");
  const fixedNow = Date.UTC(2026, 9, 24, 8, 0, 0);
  const off = await collectConnectionDiagnostics({ codexHome: path.join(root, "missing"), stateDir, now: fixedNow, enabled: false });
  eq(off.available, false, "disabled short-circuits as unavailable");
  await assert.rejects(readFile(stateFile(stateDir)));

  const db = createDb();
  const base = fixedNow - 10_000;
  for (let n = 1; n <= 5; n++) {
    add(db, base + n * 500, "codex_core::client", `sampling request failed; retry ${n}/5 thread_id=01a1491e-cc5c-7743-8d1a-a935dcd54cb9 process_uuid=feedface-1234`);
    add(db, base + n * 500 + 100, "codex_api::endpoint::responses_websocket", `websocket closed by server before response.completed thread_id=01a1491e-cc5c-7743-8d1a-a935dcd54cb9`);
  }
  add(db, base + 3_000, "codex_core::client", "falling back to HTTP thread_id=01a1491e-cc5c-7743-8d1a-a935dcd54cb9 https://secret.example/v1/responses?api_key=do-not-leak");
  add(db, base + 3_500, "codex_core::client", "sampling request failed; retry 1/5 websocket closed thread_id=other-thread process_uuid=other-process");
  add(db, base + 3_700, "codex_core::client", "falling back to HTTP thread_id=child-thread");
  add(db, base + 4_000, "codex_core::client", "sampling request failed; retry 7/5", "user text includes https://private.example/path?key=SECRET");
  add(db, base + 4_100, "codex_core::tools::exec", "websocket closed by server before response.completed");
  db.close();

  const parent = "01a1491e-cc5c-7743-8d1a-a935dcd54cb9";
  const result = await collectConnectionDiagnostics({ codexHome: root, stateDir, now: fixedNow, enabled: true, parentThreadId: parent, registeredChildThreadIds: ["child-thread"] });
  eq(result.available, true, "real SQLite store is read");
  eq(result.events.length, 14, "only classified response-network events are kept");
  eq(result.events.some(e => e.target === "codex_core::tools::exec"), false, "quoted WS text from tool logs is excluded");
  eq(result.events.some(e => e.errorClass === "sampling_retry" && e.retryNumber === 7), true, "feedback field is used when message is empty and contains untrusted text");
  eq(result.events.filter(e => e.errorClass === "sampling_retry").length, 7, "retry rows including unrelated thread are classified");
  eq(result.events.filter(e => e.errorClass === "websocket_closed_before_completed").length, 5, "five WS close events are classified");
  eq(result.events.find(e => e.errorClass === "http_fallback").correlation, "parent", "explicit matching parent ID is recognized");
  eq(result.events.find(e => e.threadHash && e.correlation === "registered_child")?.correlation, "registered_child", "registered child is explicitly recognized");
  eq(result.events.find(e => e.retryNumber === 1 && e.correlation === "other_or_unknown")?.correlation, "other_or_unknown", "unrelated chats are never attributed to parent");
  const serialized = JSON.stringify(result);
  for (const secret of ["secret.example", "api_key", "do-not-leak", "SUPERSECRET", "authorization", "feedface-1234", "other-thread", parent, "falling back to HTTP", "private.example", "SECRET"]) assert.ok(!serialized.includes(secret), "serialized result omits seeded sensitive markers");
  const snapshot = await readConnectionDiagnosticsSnapshot(stateDir, { parentThreadId: parent });
  eq(JSON.stringify(snapshot), JSON.stringify(result), "parent-specific state round-trips sanitized events");
  const rawState = await readFile(stateFile(stateDir, parent), "utf8");
  assert.ok(!rawState.includes("secret.example"), "persisted snapshot never stores raw URLs");

  const again = await collectConnectionDiagnostics({ codexHome: root, stateDir, now: fixedNow + 1_000, enabled: true, parentThreadId: parent });
  eq(again.events.length, 0, "cursor prevents duplicate rows");
  eq(again.rootCause, "uncertain", "missing terminal response never implies recovery or a root cause");
  const missing = await collectConnectionDiagnostics({ codexHome: path.join(root, "absent"), stateDir, now: fixedNow, enabled: true });
  eq(missing.available, false, "missing database is explicitly unavailable");

  const emptyHome = path.join(root, "empty"); await import("node:fs/promises").then(({ mkdir }) => mkdir(emptyHome));
  const empty = createDb(emptyHome); empty.close();
  const emptyResult = await collectConnectionDiagnostics({ codexHome: emptyHome, stateDir: path.join(root, "empty-state"), now: fixedNow, enabled: true });
  eq(emptyResult.available, true, "empty SQLite is a valid available source"); eq(emptyResult.events.length, 0, "empty store returns no events");
  const badHome = path.join(root, "bad"); await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(badHome));
  await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(badHome, "logs_2.sqlite"), "not sqlite"));
  const bad = await collectConnectionDiagnostics({ codexHome: badHome, stateDir: path.join(root, "bad-state"), now: fixedNow, enabled: true });
  eq(bad.available, false, "unreadable database fails closed without throwing");
  const lockHome = path.join(root, "locked"); await import("node:fs/promises").then(({ mkdir }) => mkdir(lockHome));
  const lockDb = new DatabaseSync(path.join(lockHome, "logs_2.sqlite"));
  lockDb.exec("CREATE TABLE logs (ts INTEGER, ts_nanos INTEGER, target TEXT, message TEXT, thread_id TEXT); BEGIN EXCLUSIVE");
  const locked = await collectConnectionDiagnostics({ codexHome: lockHome, stateDir: path.join(root, "locked-state"), now: fixedNow, enabled: true });
  eq(locked.available, false, "exclusive lock is reported unavailable without throwing");
  lockDb.exec("ROLLBACK"); lockDb.close();

  const rotateHome = path.join(root, "rotate"); await import("node:fs/promises").then(({ mkdir }) => mkdir(rotateHome));
  const rotateDb = createDb(rotateHome);
  add(rotateDb, fixedNow - 4_000, "codex_core::client", "falling back to HTTP"); rotateDb.close();
  const rotateState = path.join(root, "rotate-state"); await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(rotateState));
  await import("node:fs/promises").then(({ writeFile }) => writeFile(stateFile(rotateState), JSON.stringify({ cursor: { rowid: 100, maxTimestampMs: fixedNow - 1000 }, events: [] })));
  const afterRotation = await collectConnectionDiagnostics({ codexHome: rotateHome, stateDir: rotateState, now: fixedNow, enabled: true });
  eq(afterRotation.events.length, 1, "lower rowid after log rotation resets cursor to recent bounded window");
  const afterRotationAgain = await collectConnectionDiagnostics({ codexHome: rotateHome, stateDir: rotateState, now: fixedNow + 1_000, enabled: true });
  eq(afterRotationAgain.events.length, 0, "rotation timestamp baseline prevents repeat reset on the next collection");

  const largeHome = path.join(root, "large"); await import("node:fs/promises").then(({ mkdir }) => mkdir(largeHome));
  const largeDb = createDb(largeHome); largeDb.exec("BEGIN");
  const insertLarge = largeDb.prepare("INSERT INTO logs(ts,ts_nanos,level,target,message,feedback_log_body) VALUES(?,0,'WARN','codex_core::client','','sampling request failed; retry 1/5')");
  for (let n = 0; n < 701; n++) insertLarge.run(Math.floor((fixedNow - 70_000 + n * 100) / 1000));
  largeDb.exec("COMMIT"); largeDb.close();
  const latest = await collectConnectionDiagnostics({ codexHome: largeHome, stateDir: path.join(root, "large-state"), now: fixedNow, enabled: true });
  eq(latest.events.length, 500, "first collection is bounded to 500 recent rows");
  eq(latest.events.at(-1).timestampUtc, new Date(Math.floor((fixedNow - 70_000 + 700 * 100) / 1000) * 1000).toISOString(), "first batch starts at newest rows rather than oldest rows");

  const raceHome = path.join(root, "race"); await import("node:fs/promises").then(({ mkdir }) => mkdir(raceHome));
  const raceDb = createDb(raceHome); add(raceDb, fixedNow - 1_000, "codex_core::client", "falling back to HTTP thread_id=parent-a"); raceDb.close();
  const sharedState = path.join(root, "shared-state");
  const concurrent = await Promise.all([1, 2].map(() => collectConnectionDiagnostics({ codexHome: raceHome, stateDir: sharedState, now: fixedNow, enabled: true, parentThreadId: "parent-a" })));
  eq(concurrent.flatMap(x => x.events).length, 1, "same-parent concurrent collection is serialized and not duplicated");
  const parentA = await readConnectionDiagnosticsSnapshot(sharedState, { parentThreadId: "parent-a" });
  const parentB = await collectConnectionDiagnostics({ codexHome: raceHome, stateDir: sharedState, now: fixedNow, enabled: true, parentThreadId: "parent-b" });
  eq(parentB.events.length, 1, "different parents get separate cursors and snapshots");
  eq(parentB.events[0].correlation, "other_or_unknown", "other parent's thread is not attributed");
  eq(parentA.events.length, 1, "first parent's snapshot remains intact");
  const contendedParent = "contended-parent";
  const contendedLock = path.join(sharedState, `connection-diagnostics-${createHash("sha256").update(contendedParent).digest("hex")}.lock`);
  let releaseLock;
  let acquired;
  const lockAcquired = new Promise((resolve) => { acquired = resolve; });
  const hold = new Promise((resolve) => { releaseLock = resolve; });
  const holder = withFileLock(contendedLock, async () => { acquired(); await hold; });
  await lockAcquired;
  const started = performance.now();
  const contended = await collectConnectionDiagnostics({ codexHome: raceHome, stateDir: sharedState, now: fixedNow, enabled: true, parentThreadId: contendedParent });
  const lockWaitMs = performance.now() - started;
  eq(contended.available, false, "lock contention fails open without exposing another snapshot");
  eq(lockWaitMs < 1_000, true, "lock contention does not block the caller");
  releaseLock(); await holder;
  console.log("native connection diagnostics tests passed");
} finally {
  try { await rm(root, { recursive: true, force: true }); } catch (error) { if (error.code !== "EBUSY") throw error; }
}
