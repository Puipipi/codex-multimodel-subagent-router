import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';

const request = JSON.parse(readFileSync(0, 'utf8'));
const toolMap = {start: 'dsh_start', wait: 'dsh_wait', result: 'dsh_wait', followup: 'dsh_followup', show: 'dsh_status', list: 'dsh_list', interrupt: 'dsh_interrupt'};
const tool = toolMap[request.action];
if (!tool) throw new Error(`Unsupported action: ${request.action}`);
if (request.action === 'start' && (!request.args.task || !request.args.cwd)) throw new Error('start requires task and cwd');
if (['wait', 'result', 'followup', 'show', 'interrupt'].includes(request.action) && !request.args.agent_id) throw new Error(`${request.action} requires agent_id`);
const allowed = {
  start: ['task', 'cwd', 'name', 'model', 'provider', 'effort', 'preset', 'permission'],
  wait: ['agent_id', 'seconds', 'legacy'], result: ['agent_id', 'legacy'],
  followup: ['agent_id', 'task', 'legacy'], show: ['agent_id', 'legacy'],
  list: ['limit', 'status', 'cwd', 'match', 'max_chars', 'legacy'],
  interrupt: ['agent_id', 'legacy'],
}[request.action];
for (const key of Object.keys(request.args)) if (!allowed.includes(key)) throw new Error(`Unsupported option for ${request.action}: ${key}`);
if (request.action === 'start') {
  request.args.provider ??= 'deepseek-official';
  request.args.model ??= 'deepseek-flash';
  if (request.args.provider !== 'deepseek-official') throw new Error('Shell helper requires provider deepseek-official.');
  if (!/deepseek/i.test(request.args.model)) throw new Error('Shell helper requires a DeepSeek model name.');
}
if (request.action === 'result') request.args.seconds = 0;
for (const key of ['seconds', 'limit', 'max_chars']) if (key in request.args) {
  const value = Number(request.args[key]);
  const max = {seconds: 2147483.647, limit: 200, max_chars: 100000}[key];
  const min = {seconds: 0, limit: 1, max_chars: 256}[key];
  if (!Number.isFinite(value) || value < min || value > max || (key !== 'seconds' && !Number.isInteger(value))) throw new Error(`${key} is outside the DSH MCP schema range.`);
  request.args[key] = value;
}
for (const key of ['legacy']) if (key in request.args && typeof request.args[key] !== 'boolean') {
  if (request.args[key] === 'true') request.args[key] = true;
  else if (request.args[key] === 'false') request.args[key] = false;
  else throw new Error(`${key} must be true or false.`);
}

const child = spawn(process.execPath, [request.npxCli, '--yes', 'dsh-subagent-mcp@0.7.0', 'mcp'], {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
let buffer = '';
let nextId = 0;
const pending = new Map();
let stderr = '';
child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
child.on('error', error => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); });
child.on('exit', code => { for (const waiter of pending.values()) waiter.reject(new Error(`MCP process exited (${code ?? 'unknown'}).`)); pending.clear(); });
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
  child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
});
let timer;
try {
  const initialized = await Promise.race([
    send('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'sol-luna-deepseek-router', version: '1.0.0'}}),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP handshake timed out.')), 10000); }),
  ]);
  clearTimeout(timer); timer = undefined;
  child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
  const args = request.args;
  const call = send('tools/call', {name: tool, arguments: args});
  const result = request.action === 'wait'
    ? await call
    : await Promise.race([call, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`MCP call timed out for ${tool}; outcome may be unknown. Inspect the same agent ID before retrying.`)), 30000); })]);
  clearTimeout(timer); timer = undefined;
  if (result?.isError) throw new Error(`${tool} returned an error; inspect local DSH status or logs without sharing credentials.`);
  process.stdout.write(JSON.stringify({server: initialized.serverInfo?.name, tool, result}) + '\n');
} catch (error) {
  const message = String(error.message || 'MCP request failed').replace(/(api[_-]?key|authorization|bearer|token|secret)(\s*[:=]\s*)\S+/ig, '$1$2<REDACTED>').replace(/sk-[A-Za-z0-9_-]{12,}/g, '<REDACTED_KEY>');
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
} finally {
  if (timer) clearTimeout(timer);
  child.stdin.end();
  child.kill();
}
