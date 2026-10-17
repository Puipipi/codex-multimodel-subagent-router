#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOLIDAYS_2026 = [
  ['2026-01-01', '2026-01-03'],
  ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'],
  ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'],
  ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'],
];

const CHINA_TIMEZONE = 'Asia/Shanghai';
const PEAK_UTC_HOURS = [[1, 4], [6, 10]];
const EXECUTORS = new Set(['luna', 'deepseek']);

function localDate(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function isHoliday2026(date) {
  return HOLIDAYS_2026.some(([start, end]) => date >= start && date <= end);
}

function scheduleRoute(instant) {
  const date = localDate(instant, CHINA_TIMEZONE);
  const year = Number(date.slice(0, 4));
  const weekday = new Date(instant).getUTCDay();
  const hour = new Date(instant).getUTCHours();

  // DeepSeek's published discount applies on UTC weekdays, with Chinese
  // public holidays excluded. Weekend make-up workdays remain valley hours.
  if (weekday === 0 || weekday === 6) {
    return { executor: 'deepseek', phase: 'valley', source: 'schedule', reason: 'weekend valley pricing' };
  }
  if (year === 2026 && isHoliday2026(date)) {
    return { executor: 'deepseek', phase: 'valley', source: 'schedule', reason: 'Chinese public holiday; official DeepSeek holiday pricing is valley' };
  }
  const peak = PEAK_UTC_HOURS.some(([start, end]) => hour >= start && hour < end);
  if (peak && year !== 2026) {
    return { executor: 'luna', phase: 'unknown', source: 'calendar_missing', reason: `no bundled Chinese holiday calendar for ${year}; using Luna conservatively during a candidate peak window` };
  }
  return peak
    ? { executor: 'luna', phase: 'peak', source: 'schedule', reason: 'weekday DeepSeek peak-price window' }
    : { executor: 'deepseek', phase: 'valley', source: 'schedule', reason: 'weekday DeepSeek valley-price window' };
}

function stateRoot(stateDir) {
  if (stateDir) return stateDir;
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'sol-luna-deepseek-router', 'session-overrides');
}

function stateFile(sessionId, stateDir) {
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return path.join(stateRoot(stateDir), `${digest}.json`);
}

async function readOverride(sessionId, stateDir) {
  if (!sessionId) return null;
  let value;
  try {
    value = JSON.parse(await readFile(stateFile(sessionId, stateDir), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read this chat's router override; refusing automatic routing: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || !EXECUTORS.has(value.executor)) {
    throw new Error('This chat has an invalid router override; refusing automatic routing. Reset the session override after inspecting the state file.');
  }
  return value.executor;
}

async function writeOverride(sessionId, executor, stateDir) {
  if (!sessionId) throw new Error('--session is required to save a session override');
  const file = stateFile(sessionId, stateDir);
  await mkdir(path.dirname(file), { recursive: true });
  if (executor === null) {
    await rm(file, { force: true });
    return;
  }
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ executor, updatedAt: new Date().toISOString() })}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function decideRoute({
  at = new Date(), executor, setSessionExecutor,
  resetSession = false, sessionId, stateDir,
} = {}) {
  if (typeof at === 'string' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(at)) {
    throw new Error('--at must be a complete ISO timestamp with Z or an explicit UTC offset');
  }
  const instant = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(instant.getTime())) throw new Error(`Invalid --at date: ${at}`);
  if (executor !== undefined && !EXECUTORS.has(executor)) throw new Error('--executor must be luna or deepseek');
  if (setSessionExecutor !== undefined && ![...EXECUTORS, 'auto'].includes(setSessionExecutor)) throw new Error('--set-session-executor must be luna, deepseek, or auto');
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.trim())) throw new Error('--session must be a non-empty chat ID');
  if (setSessionExecutor && !sessionId) throw new Error('--session is required to save a session override');
  if (resetSession && !sessionId) throw new Error('--session is required to reset a session override');
  if (resetSession && setSessionExecutor) throw new Error('Choose either --reset-session or --set-session-executor');

  if (resetSession) await writeOverride(sessionId, null, stateDir);
  if (setSessionExecutor) await writeOverride(sessionId, setSessionExecutor === 'auto' ? null : setSessionExecutor, stateDir);

  const scheduled = {
    ...scheduleRoute(instant),
    evaluatedAt: instant.toISOString(),
    timezone: CHINA_TIMEZONE,
    calendarVersion: localDate(instant, CHINA_TIMEZONE).startsWith('2026-') ? 'china-public-holidays-2026' : 'missing',
  };
  if (executor !== undefined) return { ...scheduled, executor, source: 'one_time_override', reason: `one-time explicit executor override: ${executor}` };
  const sticky = await readOverride(sessionId, stateDir);
  if (sticky) return { ...scheduled, executor: sticky, source: 'session_override', reason: `sticky executor override for this chat: ${sticky}` };
  return scheduled;
}

function usage() {
  return `Usage: node scripts/route.mjs [options]\n\nOptions:\n  --at ISO_DATE                    Evaluate a test or supplied instant\n  --executor luna|deepseek         One-task manual override\n  --session ID                     Chat-specific state key (not a prompt or secret)\n  --set-session-executor luna|deepseek|auto\n  --reset-session                  Clear this chat's sticky override\n  --state-dir PATH                 State root (tests only; default is per-user LocalAppData)\n  --json                           Print one JSON result\n`;
}

async function main(argv) {
  const options = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') { json = true; continue; }
    if (arg === '--help' || arg === '-h') { process.stdout.write(usage()); return; }
    const fields = {
      '--at': 'at', '--executor': 'executor',
      '--session': 'sessionId', '--set-session-executor': 'setSessionExecutor',
      '--state-dir': 'stateDir',
    };
    if (arg === '--reset-session') { options.resetSession = true; continue; }
    const value = argv[i + 1];
    if (!fields[arg] || value === undefined || value.startsWith('--') || !value.trim()) throw new Error(`Unknown option or missing value: ${arg}`);
    options[fields[arg]] = argv[++i];
  }
  const result = await decideRoute(options);
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${result.executor}: ${result.phase} (${result.reason})\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
