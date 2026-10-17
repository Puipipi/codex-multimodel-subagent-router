import {spawn} from 'node:child_process';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const PUBLISHED_VERSION = '0.7.0';
const PUBLISHED_PACKAGE = `dsh-subagent-mcp@${PUBLISHED_VERSION}`; // Published backend: dsh-subagent-mcp@0.7.0.
// One concise marker appended to every new start or follow-up message. A
// follow-up gets its own instruction so agents started before this change are
// covered too; the original task always remains a verbatim prefix.
export const LANGUAGE_INSTRUCTION = '用户可见的进度与最终报告必须使用简体中文；代码、命令和内部 GPT-DeepSeek 通信可保持原文。';

const toolMap = {
  start: 'dsh_start', wait: 'dsh_wait', result: 'dsh_wait', followup: 'dsh_followup',
  show: 'dsh_status', list: 'dsh_list', interrupt: 'dsh_interrupt',
  close: 'dsh_close', rename: 'dsh_rename', events: 'dsh_events',
};
const allowed = {
  start: ['task', 'cwd', 'name', 'model', 'provider', 'effort', 'preset', 'permission'],
  wait: ['agent_id', 'seconds', 'legacy'], result: ['agent_id', 'legacy'],
  followup: ['agent_id', 'task', 'legacy'], show: ['agent_id', 'legacy'],
  list: ['limit', 'status', 'cwd', 'match', 'max_chars', 'legacy'],
  interrupt: ['agent_id', 'legacy'],
  close: ['agent_id', 'legacy'],
  rename: ['agent_id', 'name', 'legacy'],
  events: ['agent_id', 'after', 'limit', 'max_chars', 'include_progress', 'include_descendants', 'include_tool_events', 'event_id'],
};
const numeric = {
  seconds: {min: 0, max: 2147483.647, integer: false},
  limit: {min: 1, max: 200, integer: true},
  max_chars: {min: 256, max: 100000, integer: true},
  event_id: {min: 1, max: 2147483647, integer: true},
};
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10000;
const DEFAULT_CALL_TIMEOUT_MS = 30000;
const DEFAULT_NPX_CACHE_ENTRIES = 128;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function publishedEntryIn(packageRoot) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    if (manifest?.name !== 'dsh-subagent-mcp' || manifest?.version !== PUBLISHED_VERSION) return null;
    const entry = path.join(packageRoot, 'src', 'cli.mjs');
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

function npmCacheRoot(env) {
  if (nonEmptyString(env.npm_config_cache)) return env.npm_config_cache;
  if (process.platform === 'win32' && nonEmptyString(env.LOCALAPPDATA)) return path.join(env.LOCALAPPDATA, 'npm-cache');
  return path.join(env.HOME || env.USERPROFILE || '.', '.npm');
}

function packageRootCandidates(env) {
  const candidates = [];
  if (nonEmptyString(env.SOL_LUNA_DSH_PACKAGE_ROOT)) candidates.push(env.SOL_LUNA_DSH_PACKAGE_ROOT);
  if (nonEmptyString(env.npm_config_prefix)) candidates.push(path.join(env.npm_config_prefix, 'node_modules', 'dsh-subagent-mcp'));
  if (nonEmptyString(env.APPDATA)) candidates.push(path.join(env.APPDATA, 'npm', 'node_modules', 'dsh-subagent-mcp'));
  const cacheRoot = npmCacheRoot(env);
  try {
    const entries = readdirSync(path.join(cacheRoot, '_npx'), {withFileTypes: true})
      .filter(entry => entry.isDirectory())
      .slice(0, DEFAULT_NPX_CACHE_ENTRIES);
    for (const entry of entries) candidates.push(path.join(cacheRoot, '_npx', entry.name, 'node_modules', 'dsh-subagent-mcp'));
  } catch { /* No npx cache is fine; the pinned npx command below remains the fallback. */ }
  return candidates;
}

// Prefer a verified task-managed installation: the explicit package-root
// override, an npm global prefix, or the npm npx cache. The current working
// directory and its node_modules are deliberately never searched or executed.
// This skips the npm resolver process that dominated a one-shot call, but only
// after the exact package name/version and entrypoint are verified.
export function resolvePublishedEntry({env = process.env} = {}) {
  if (env.SOL_LUNA_DSH_TRANSPORT === 'npx') return null;
  for (const candidate of packageRootCandidates(env)) {
    const entry = publishedEntryIn(candidate);
    if (entry) return entry;
  }
  return null;
}

function appendLanguageInstruction(task) {
  if (task.includes(LANGUAGE_INSTRUCTION)) return task;
  return `${task}\n\n${LANGUAGE_INSTRUCTION}`;
}

function prepareRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('MCP client request must be an object.');
  if (!request.args || typeof request.args !== 'object' || Array.isArray(request.args)) throw new Error('MCP client request.args must be an object.');
  const {action} = request;
  const tool = toolMap[action];
  if (!tool) throw new Error(`Unsupported action: ${action}`);
  if (action === 'start' && (!nonEmptyString(request.args.task) || !nonEmptyString(request.args.cwd))) throw new Error('start requires task and cwd');
  if (['wait', 'result', 'followup', 'show', 'interrupt', 'close', 'rename', 'events'].includes(action) && !nonEmptyString(request.args.agent_id)) throw new Error(`${action} requires agent_id`);
  if (action === 'followup' && !nonEmptyString(request.args.task)) throw new Error('followup requires task');
  if (action === 'rename' && !nonEmptyString(request.args.name)) throw new Error('rename requires name');
  const args = {...request.args};
  for (const key of Object.keys(args)) if (!allowed[action].includes(key)) throw new Error(`Unsupported option for ${action}: ${key}`);
  if (action === 'start') {
    args.provider ??= 'deepseek-official';
    args.model ??= 'deepseek-flash';
    if (args.provider !== 'deepseek-official') throw new Error('Shell helper requires provider deepseek-official.');
    if (!/deepseek/i.test(args.model)) throw new Error('Shell helper requires a DeepSeek model name.');
  }
  // Every start or follow-up message gets one marker. This also covers agents
  // created before the marker existed, without restarting their conversation.
  if (action === 'start' || action === 'followup') args.task = appendLanguageInstruction(args.task);
  if (action === 'result') args.seconds = 0;
  if (action === 'events' && 'after' in args) {
    const raw = args.after;
    if (typeof raw === 'string' && raw.trim() !== '') args.after = raw;
    else if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) args.after = raw;
    else throw new Error('after must be a non-negative integer or a non-empty continuation cursor.');
  }
  for (const key of Object.keys(numeric)) if (key in args) {
    const raw = args[key];
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    const {min, max, integer} = numeric[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${key} is outside the DSH MCP schema range.`);
    args[key] = value;
  }
  if ('legacy' in args && typeof args.legacy !== 'boolean') {
    if (args.legacy === 'true') args.legacy = true;
    else if (args.legacy === 'false') args.legacy = false;
    else throw new Error('legacy must be true or false.');
  }
  for (const key of ['include_progress', 'include_descendants', 'include_tool_events']) if (key in args && typeof args[key] !== 'boolean') {
    if (args[key] === 'true') args[key] = true;
    else if (args[key] === 'false') args[key] = false;
    else throw new Error(`${key} must be true or false.`);
  }
  let meta;
  if (request.meta !== undefined) {
    if (!request.meta || typeof request.meta !== 'object' || Array.isArray(request.meta)) throw new Error('MCP client meta must be an object.');
    if (request.meta.threadId !== undefined) {
      if (!nonEmptyString(request.meta.threadId)) throw new Error('MCP client meta.threadId must be a non-empty string.');
      meta = {threadId: request.meta.threadId};
    }
  }
  return {action, tool, args, npxCli: request.npxCli, meta};
}

export async function runClient(request, {
  spawnProcess = spawn,
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
} = {}) {
  const {action, tool, args, npxCli, meta} = prepareRequest(request);
  // An injected spawn implementation owns process selection (tests and
  // embedders keep the published npx command); the production path may use the
  // verified local 0.7 entrypoint.
  const directEntry = spawnProcess === spawn ? resolvePublishedEntry() : null;
  if (!directEntry && spawnProcess === spawn && !nonEmptyString(npxCli)) {
    throw new Error(`Cannot locate ${PUBLISHED_PACKAGE} or an npx CLI path.`);
  }
  const processArgs = directEntry ? [directEntry, 'mcp'] : [npxCli, '--yes', PUBLISHED_PACKAGE, 'mcp'];
  const child = spawnProcess(process.execPath, processArgs, {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  let buffer = '';
  let nextId = 0;
  const pending = new Map();
  let stderr = '';
  let timer;
  const failAll = error => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  child.on('error', failAll);
  // Wait for close rather than exit: a child can exit after writing its final
  // response while stdout still has that response buffered.
  child.on('close', (code, signal) => failAll(new Error(`MCP process exited (${code ?? signal ?? 'unknown'}).`)));
  child.stdin.on('error', error => failAll(new Error(`MCP stdin error: ${error.message}`)));
  child.stdout.on('error', error => failAll(new Error(`MCP stdout error: ${error.message}`)));
  child.stderr.on('error', error => failAll(new Error(`MCP stderr error: ${error.message}`)));
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); message.error ? waiter.reject(new Error(message.error.message || 'MCP request failed')) : waiter.resolve(message.result); }
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, {resolve, reject});
    try {
      child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n', 'utf8', error => {
        if (error && pending.delete(id)) reject(error);
      });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
  try {
    const initialized = await Promise.race([
      send('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'sol-luna-deepseek-router', version: '1.0.0'}}),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP handshake timed out.')), handshakeTimeoutMs); }),
    ]);
    clearTimeout(timer); timer = undefined;
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
    const params = {name: tool, arguments: args};
    if (meta) params._meta = meta;
    const call = send('tools/call', params);
    const result = action === 'wait'
      ? await call
      : await Promise.race([call, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`MCP call timed out for ${tool}; outcome may be unknown. Inspect the same agent ID before retrying.`)), callTimeoutMs); })]);
    clearTimeout(timer); timer = undefined;
    if (result?.isError) throw new Error(`${tool} returned an error; inspect local DSH status or logs without sharing credentials.`);
    return {server: initialized.serverInfo?.name, tool, result};
  } catch (error) {
    failAll(error);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      child.stdin.end();
    } finally {
      child.kill();
    }
  }
}

function sanitize(message) {
  return String(message || 'MCP request failed').replace(/(api[_-]?key|authorization|bearer|token|secret)(\s*[:=]\s*)\S+/ig, '$1$2<REDACTED>').replace(/sk-[A-Za-z0-9_-]{12,}/g, '<REDACTED_KEY>');
}

async function main() {
  const request = JSON.parse(readFileSync(0, 'utf8'));
  const output = await runClient(request);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${sanitize(error.message || 'MCP request failed')}\n`);
    process.exitCode = 1;
  });
}
