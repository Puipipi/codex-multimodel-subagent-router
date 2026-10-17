import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { decideRoute } from '../scripts/route.mjs';

const cases = [
  ['before first peak', '2026-10-19T08:59:59+08:00', 'deepseek'],
  ['first peak starts at 09:00 Shanghai', '2026-10-19T09:00:00+08:00', 'luna'],
  ['weekday morning peak in Shanghai', '2026-10-19T10:30:00+08:00', 'luna'],
  ['first peak ends before 12:00 Shanghai', '2026-10-19T11:59:59+08:00', 'luna'],
  ['weekday noon valley boundary', '2026-10-19T12:00:00+08:00', 'deepseek'],
  ['second peak begins at 14:00 Shanghai', '2026-10-19T14:00:00+08:00', 'luna'],
  ['weekday afternoon peak', '2026-10-19T14:30:00+08:00', 'luna'],
  ['second peak ends before 18:00 Shanghai', '2026-10-19T17:59:59+08:00', 'luna'],
  ['weekday evening valley boundary', '2026-10-19T18:00:00+08:00', 'deepseek'],
  ['weekend is valley', '2026-10-17T10:00:00+08:00', 'deepseek'],
  ['adjusted working Saturday is still weekend valley', '2026-05-09T10:00:00+08:00', 'deepseek'],
  ['2026 public holiday is conservatively valley', '2026-10-02T10:00:00+08:00', 'deepseek'],
  ['unknown year candidate peak is conservatively Luna', '2027-10-04T10:00:00+08:00', 'luna'],
  ['unknown year daytime valley remains DeepSeek', '2027-10-04T12:00:00+08:00', 'deepseek'],
];

for (const date of [
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
]) cases.push([`2026 holiday ${date}`, `${date}T10:00:00+08:00`, 'deepseek']);

for (const [name, at, expected] of cases) {
  const result = await decideRoute({ at });
  assert.equal(result.executor, expected, name);
  assert.equal(result.timezone, 'Asia/Shanghai');
  assert.equal(typeof result.evaluatedAt, 'string');
}

const temp = await mkdtemp(path.join(os.tmpdir(), 'executor-router-'));
try {
  const sessionId = 'chat-A';
  const configured = await decideRoute({ at: '2026-10-19T10:30:00+08:00', setSessionExecutor: 'deepseek', sessionId, stateDir: temp });
  assert.equal(configured.executor, 'deepseek', 'session override must apply immediately');
  assert.equal(configured.source, 'session_override');

  const sticky = await decideRoute({ at: '2026-10-19T10:30:00+08:00', sessionId, stateDir: temp });
  assert.equal(sticky.executor, 'deepseek', 'session override remains sticky');

  const updated = await decideRoute({ at: '2026-10-19T10:30:00+08:00', setSessionExecutor: 'luna', sessionId, stateDir: temp });
  assert.equal(updated.executor, 'luna', 'atomic session update replaces the previous choice');
  await decideRoute({ at: '2026-10-19T10:30:00+08:00', setSessionExecutor: 'deepseek', sessionId, stateDir: temp });

  const once = await decideRoute({ at: '2026-10-19T10:30:00+08:00', executor: 'luna', sessionId, stateDir: temp });
  assert.equal(once.executor, 'luna', 'one-time explicit override outranks sticky setting');

  const otherChat = await decideRoute({ at: '2026-10-19T10:30:00+08:00', sessionId: 'chat-B', stateDir: temp });
  assert.equal(otherChat.executor, 'luna', 'session overrides must not leak across chats');

  const reset = await decideRoute({ at: '2026-10-19T10:30:00+08:00', resetSession: true, sessionId, stateDir: temp });
  assert.equal(reset.executor, 'luna', 'reset restores automatic schedule');
  assert.equal(reset.source, 'schedule');

  const brokenSession = 'broken-chat';
  const digest = createHash('sha256').update(brokenSession).digest('hex');
  await mkdir(temp, { recursive: true });
  await writeFile(path.join(temp, `${digest}.json`), '{"executor":"unexpected"}\n');
  await assert.rejects(
    decideRoute({ at: '2026-10-19T12:00:00+08:00', sessionId: brokenSession, stateDir: temp }),
    /invalid router override; refusing automatic routing/,
    'corrupt or unsupported sticky state must fail closed instead of switching executors',
  );
  await assert.rejects(decideRoute({ at: '2026-10-19T10:30:00+08:00', executor: '', stateDir: temp }), /--executor must be luna or deepseek/);
  await assert.rejects(decideRoute({ at: '2026-10-19T10:30:00+08:00', setSessionExecutor: '', sessionId, stateDir: temp }), /--set-session-executor must be luna, deepseek, or auto/);
  await assert.rejects(decideRoute({ at: '2026-10-19T10:30:00', stateDir: temp }), /explicit UTC offset/);
} finally {
  await rm(temp, { recursive: true, force: true });
}

const cliPath = fileURLToPath(new URL('../scripts/route.mjs', import.meta.url));
const missingSessionValue = spawnSync(process.execPath, [cliPath, '--session', '--json'], { encoding: 'utf8' });
assert.equal(missingSessionValue.status, 2, 'a flag cannot be mistaken for the missing session value');
assert.match(missingSessionValue.stderr, /missing value/);
for (const args of [['--session', ''], ['--at', '']]) {
  const invalid = spawnSync(process.execPath, [cliPath, ...args, '--json'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2, `empty ${args[0]} must fail`);
}
console.log(`PASS ${cases.length * 3 + 14} routing assertions`);
