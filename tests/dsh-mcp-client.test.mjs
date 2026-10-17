import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {LANGUAGE_INSTRUCTION, resolvePublishedEntry, runClient} from '../scripts/dsh-mcp-client.mjs';

let checks = 0;

function ok(value, message) {
  assert.ok(value, message);
  checks += 1;
}

function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  checks += 1;
}

function deepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks += 1;
}

async function within(promise, milliseconds = 3000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('client test timed out')), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class FakeChild extends EventEmitter {
  constructor(onMessage) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.exited = false;
    this.closed = false;
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');
    this.stdin.setEncoding('utf8');
    let buffer = '';
    this.stdin.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        onMessage(this, JSON.parse(line));
      }
    });
  }

  send(value) {
    this.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
  }

  sendRaw(chunk) {
    this.stdout.write(chunk);
  }

  exit(code = 0, signal = null) {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }

  close(code = 0, signal = null) {
    this.exit(code, signal);
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, signal);
  }

  kill() {
    this.killed = true;
    this.close(null, 'SIGTERM');
    return true;
  }
}

function harness(onMessage, defaults = {}) {
  const state = {spawns: 0, messages: [], child: null, command: null, args: null, options: null};
  const spawnProcess = (command, args, options) => {
    state.spawns += 1;
    state.command = command;
    state.args = args;
    state.options = options;
    state.child = new FakeChild((child, message) => {
      state.messages.push(message);
      onMessage(child, message, state);
    });
    return state.child;
  };
  return {
    state,
    run(request, options = {}) {
      return within(runClient(request, {
        spawnProcess,
        handshakeTimeoutMs: 1000,
        callTimeoutMs: 1000,
        ...defaults,
        ...options,
      }));
    },
  };
}

function initialize(child, message) {
  child.send({jsonrpc: '2.0', id: message.id, result: {serverInfo: {name: 'fake-dsh'}}});
}

function writeFakePackage(root, version = '0.7.0', name = 'dsh-subagent-mcp') {
  mkdirSync(path.join(root, 'src'), {recursive: true});
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({name, version, type: 'module'}), 'utf8');
  const entry = path.join(root, 'src', 'cli.mjs');
  writeFileSync(entry, '', 'utf8');
  return entry;
}

function toolResult(child, message, payload = {ok: true}) {
  child.send({jsonrpc: '2.0', id: message.id, result: {content: [{type: 'text', text: JSON.stringify(payload)}]}});
}

{
  const capture = {};
  const test = harness((child, message, state) => {
    if (message.method === 'initialize') {
      const response = JSON.stringify({jsonrpc: '2.0', id: message.id, result: {serverInfo: {name: 'fake-dsh'}}});
      child.sendRaw(`${JSON.stringify({jsonrpc: '2.0', method: 'notifications/progress', params: {}})}\n${response.slice(0, 13)}`);
      queueMicrotask(() => child.sendRaw(`${response.slice(13)}\n`));
    } else if (message.method === 'tools/call') {
      capture.tool = message.params.name;
      capture.args = message.params.arguments;
      const response = JSON.stringify({jsonrpc: '2.0', id: message.id, result: {content: [{type: 'text', text: 'done'}]}});
      child.sendRaw(`${JSON.stringify({jsonrpc: '2.0', method: 'notifications/message', params: {}})}\n${response.slice(0, 9)}`);
      queueMicrotask(() => child.sendRaw(`${response.slice(9)}\n`));
    }
  });
  const output = await test.run({action: 'start', args: {task: 'work', cwd: 'C:\\work'}});
  equal(output.server, 'fake-dsh', 'server identity is preserved');
  equal(output.tool, 'dsh_start', 'start maps to dsh_start');
  equal(capture.tool, 'dsh_start', 'the server receives dsh_start');
  equal(test.state.spawns, 1, 'a client run spawns exactly one MCP process');
  equal(test.state.command, process.execPath, 'the MCP process runs under the current Node executable');
  deepEqual(test.state.args.slice(1), ['--yes', 'dsh-subagent-mcp@0.7.0', 'mcp'], 'the published MCP transport command is used');
  deepEqual(test.state.options.stdio, ['pipe', 'pipe', 'pipe'], 'the MCP process uses piped stdio');
  equal(test.state.options.windowsHide, true, 'the real MCP child is always started hidden');
  equal(test.state.messages.length, 3, 'a full handshake sends exactly three client frames');
  equal(test.state.messages[0].method, 'initialize', 'initialize is sent first');
  equal(test.state.messages[0].params.protocolVersion, '2025-06-18', 'the MCP protocol version is explicit');
  equal(test.state.messages[0].params.clientInfo.name, 'sol-luna-deepseek-router', 'client identity is sent');
  equal(test.state.messages[1].method, 'notifications/initialized', 'the initialized notification follows the handshake');
  equal(test.state.messages[2].method, 'tools/call', 'the tool call follows the handshake');
  equal(test.state.messages.filter(message => message.method === 'tools/call').length, 1, 'a start is never duplicated');
}

{
  const mapping = [
    {action: 'start', args: {task: 'work', cwd: 'C:\\work', permission: 'workspace-write'}, tool: 'dsh_start',
      expected: {task: `work\n\n${LANGUAGE_INSTRUCTION}`, cwd: 'C:\\work', permission: 'workspace-write', provider: 'deepseek-official', model: 'deepseek-flash'}},
    {action: 'wait', args: {agent_id: 'A1'}, tool: 'dsh_wait', expected: {agent_id: 'A1'}},
    {action: 'result', args: {agent_id: 'A2'}, tool: 'dsh_wait', expected: {agent_id: 'A2', seconds: 0}},
    {action: 'followup', args: {agent_id: 'A3', task: 'fix'}, tool: 'dsh_followup', expected: {agent_id: 'A3', task: `fix\n\n${LANGUAGE_INSTRUCTION}`}},
    {action: 'show', args: {agent_id: 'A4'}, tool: 'dsh_status', expected: {agent_id: 'A4'}},
    {action: 'list', args: {limit: '5', status: 'running', legacy: 'true'}, tool: 'dsh_list', expected: {limit: 5, status: 'running', legacy: true}},
    {action: 'interrupt', args: {agent_id: 'A5'}, tool: 'dsh_interrupt', expected: {agent_id: 'A5'}},
  ];
  for (const item of mapping) {
    const test = harness((child, message, state) => {
      if (message.method === 'initialize') initialize(child, message);
      else if (message.method === 'tools/call') {
        state.tool = message.params.name;
        state.args = message.params.arguments;
        toolResult(child, message, {name: message.params.name, args: message.params.arguments});
      }
    });
    const output = await test.run({action: item.action, args: item.args});
    equal(output.tool, item.tool, `${item.action} maps to ${item.tool}`);
    equal(test.state.tool, item.tool, `${item.action} sends ${item.tool}`);
    deepEqual(test.state.args, item.expected, `${item.action} preserves its arguments`);
    equal(test.state.spawns, 1, `${item.action} spawns one MCP process`);
    equal(test.state.messages.filter(message => message.method === 'tools/call').length, 1, `${item.action} sends one tool call`);
  }
}

{
  const test = harness((child, message, state) => {
    if (message.method === 'initialize') initialize(child, message);
    else if (message.method === 'tools/call') {
      state.args = message.params.arguments;
      toolResult(child, message);
    }
  });
  await test.run({action: 'start', args: {task: 'work', cwd: 'C:\\work', provider: 'deepseek-official', model: 'deepseek-chat', effort: 'high'}});
  deepEqual(test.state.args, {task: `work\n\n${LANGUAGE_INSTRUCTION}`, cwd: 'C:\\work', provider: 'deepseek-official', model: 'deepseek-chat', effort: 'high'},
    'an explicitly selected DeepSeek model, official provider, and reasoning effort are preserved');
}

for (const [name, request, pattern] of [
  ['non-official provider', {action: 'start', args: {task: 'work', cwd: 'C:\\work', provider: 'third-party'}}, /provider deepseek-official/],
  ['non-DeepSeek model', {action: 'start', args: {task: 'work', cwd: 'C:\\work', model: 'gpt-5'}}, /DeepSeek model/],
  ['missing start task', {action: 'start', args: {cwd: 'C:\\work'}}, /start requires task and cwd/],
  ['missing start cwd', {action: 'start', args: {task: 'work'}}, /start requires task and cwd/],
  ['missing agent id', {action: 'wait', args: {}}, /wait requires agent_id/],
  ['unsupported action', {action: 'delete', args: {}}, /Unsupported action/],
  ['unsupported option', {action: 'start', args: {task: 'work', cwd: 'C:\\work', recursive: true}}, /Unsupported option/],
  ['non-object args', {action: 'start', args: []}, /request\.args must be an object/],
]) {
  const test = harness(() => { throw new Error('the fake server must not be reached'); });
  await assert.rejects(test.run(request), pattern, name);
  checks += 1;
  equal(test.state.spawns, 0, `${name} is rejected before spawning MCP`);
}

{
  const test = harness((child, message, state) => {
    if (message.method === 'initialize') initialize(child, message);
    else if (message.method === 'tools/call') {
      state.args = message.params.arguments;
      toolResult(child, message);
    }
  });
  await test.run({action: 'wait', args: {agent_id: 'A1', seconds: '1.5', legacy: 'true'}});
  deepEqual(test.state.args, {agent_id: 'A1', seconds: 1.5, legacy: true}, 'numeric and boolean strings are normalized');
  equal(typeof test.state.args.seconds, 'number', 'seconds is a number');
  equal(typeof test.state.args.legacy, 'boolean', 'legacy is a boolean');
}

for (const [name, request, pattern] of [
  ['boolean seconds', {action: 'wait', args: {agent_id: 'A1', seconds: true}}, /seconds is outside/],
  ['empty seconds', {action: 'wait', args: {agent_id: 'A1', seconds: ''}}, /seconds is outside/],
  ['fractional limit', {action: 'list', args: {limit: '1.5'}}, /limit is outside/],
  ['boolean limit', {action: 'list', args: {limit: true}}, /limit is outside/],
  ['small max_chars', {action: 'list', args: {max_chars: '255'}}, /max_chars is outside/],
  ['large seconds', {action: 'wait', args: {agent_id: 'A1', seconds: '2147483.648'}}, /seconds is outside/],
  ['invalid legacy string', {action: 'wait', args: {agent_id: 'A1', legacy: 'yes'}}, /legacy must be true or false/],
  ['numeric legacy', {action: 'wait', args: {agent_id: 'A1', legacy: 1}}, /legacy must be true or false/],
]) {
  const test = harness(() => { throw new Error('the fake server must not be reached'); });
  await assert.rejects(test.run(request), pattern, name);
  checks += 1;
  equal(test.state.spawns, 0, `${name} is rejected before spawning MCP`);
}

{
  const test = harness((child, message) => {
    if (message.method === 'initialize') initialize(child, message);
    else if (message.method === 'tools/call') child.send({jsonrpc: '2.0', id: message.id, error: {code: -32000, message: 'server exploded'}});
  });
  await assert.rejects(test.run({action: 'start', args: {task: 'work', cwd: 'C:\\work'}}), /server exploded/);
  checks += 1;
  equal(test.state.child.killed, true, 'a JSON-RPC error still kills the MCP child');
}

{
  const test = harness((child, message) => {
    if (message.method === 'initialize') initialize(child, message);
    else if (message.method === 'tools/call') child.send({jsonrpc: '2.0', id: message.id, result: {isError: true, content: [{type: 'text', text: 'denied'}]}});
  });
  await assert.rejects(test.run({action: 'start', args: {task: 'work', cwd: 'C:\\work'}}),
    /dsh_start returned an error; inspect local DSH status or logs without sharing credentials/);
  checks += 1;
  equal(test.state.child.killed, true, 'an isError result still kills the MCP child');
}

{
  const test = harness((child, message) => {
    if (message.method === 'initialize') initialize(child, message);
    else if (message.method === 'tools/call') {
      const response = JSON.stringify({jsonrpc: '2.0', id: message.id, result: {content: [{type: 'text', text: 'finished'}]}});
      queueMicrotask(() => child.exit(0));
      queueMicrotask(() => child.send(response));
      queueMicrotask(() => child.close(0));
    }
  });
  const output = await test.run({action: 'start', args: {task: 'work', cwd: 'C:\\work'}});
  equal(output.tool, 'dsh_start', 'a response buffered after child exit must still be accepted');
  equal(output.result.content[0].text, 'finished', 'the buffered response payload must be preserved');
}

{
  const test = harness((child, message) => {
    if (message.method === 'initialize') initialize(child, message);
    else if (message.method === 'tools/call') child.close(3);
  });
  await assert.rejects(test.run({action: 'start', args: {task: 'work', cwd: 'C:\\work'}}), /MCP process exited \(3\)/);
  checks += 1;
  equal(test.state.spawns, 1, 'an early child exit does not restart the MCP process');
  equal(test.state.messages.filter(message => message.method === 'tools/call').length, 1, 'an early child exit does not duplicate start');
}

{
  const test = harness(() => {});
  await assert.rejects(test.run({action: 'start', args: {task: 'work', cwd: 'C:\\work'}}, {handshakeTimeoutMs: 30}),
    /MCP handshake timed out/);
  checks += 1;
  equal(test.state.child.killed, true, 'a handshake timeout kills the MCP child');
  equal(test.state.spawns, 1, 'a handshake timeout never retries');
}

{
  const test = harness((child, message, state) => {
    if (message.method === 'initialize') initialize(child, message);
    else if (message.method === 'tools/call') state.toolCalls = (state.toolCalls || 0) + 1;
  });
  await assert.rejects(test.run({action: 'start', args: {task: 'work', cwd: 'C:\\work'}}, {callTimeoutMs: 30}),
    /MCP call timed out for dsh_start; outcome may be unknown/);
  checks += 1;
  equal(test.state.child.killed, true, 'a non-wait timeout kills the MCP child');
  equal(test.state.spawns, 1, 'a non-wait timeout never restarts the MCP process');
  equal(test.state.toolCalls, 1, 'a timed-out start is never issued twice');
}

{
  const test = harness((child, message) => {
    if (message.method === 'initialize') initialize(child, message);
    else if (message.method === 'tools/call') setTimeout(() => toolResult(child, message, {done: true}), 150);
  });
  const output = await test.run({action: 'wait', args: {agent_id: 'A1'}}, {callTimeoutMs: 30});
  equal(output.tool, 'dsh_wait', 'wait remains unbounded and is not subject to the call timeout');
  equal(test.state.child.killed, true, 'a completed wait still releases the MCP child');
}

{
  const test = harness((child, message) => {
    if (message.method === 'initialize') initialize(child, message);
    else if (message.method === 'tools/call') {
      queueMicrotask(() => child.stdin.emit('error', Object.assign(new Error('EPIPE: broken pipe'), {code: 'EPIPE'})));
    }
  });
  await assert.rejects(test.run({action: 'start', args: {task: 'work', cwd: 'C:\\work'}}), /stdin|EPIPE/i);
  checks += 1;
  equal(test.state.child.killed, true, 'a stdin error kills the MCP child');
  equal(test.state.spawns, 1, 'a stdin error never restarts the MCP process');
  equal(test.state.messages.filter(message => message.method === 'tools/call').length, 1, 'a stdin error never duplicates start');
}

{
  const task = '修复 parser：保留 空格 与 "引号" & < > | $HOME\n第二行：中文 🚀';
  const test = harness((child, message, state) => {
    if (message.method === 'initialize') initialize(child, message);
    else if (message.method === 'tools/call') {
      state.args = message.params.arguments;
      toolResult(child, message);
    }
  });
  await test.run({action: 'start', args: {task, cwd: 'C:\\work'}});
  equal(test.state.args.task, `${task}\n\n${LANGUAGE_INSTRUCTION}`, 'start appends exactly one language instruction');
  equal(test.state.args.task.slice(0, task.length), task, 'the original task remains verbatim as the prefix');
  equal(test.state.args.task.split(LANGUAGE_INSTRUCTION).length - 1, 1, 'start sends the marker once');
}

{
  const task = `已经带说明\n\n${LANGUAGE_INSTRUCTION}`;
  const test = harness((child, message, state) => {
    if (message.method === 'initialize') initialize(child, message);
    else if (message.method === 'tools/call') {
      state.args = message.params.arguments;
      toolResult(child, message);
    }
  });
  await test.run({action: 'start', args: {task, cwd: 'C:\\work'}});
  equal(test.state.args.task, task, 'an existing language marker is never duplicated');
}

{
  const test = harness((child, message, state) => {
    if (message.method === 'initialize') initialize(child, message);
    else if (message.method === 'tools/call') {
      state.args = message.params.arguments;
      toolResult(child, message);
    }
  });
  await test.run({action: 'followup', args: {agent_id: 'A9', task: '继续修复'}});
  equal(test.state.args.task, `继续修复\n\n${LANGUAGE_INSTRUCTION}`, 'a follow-up message appends exactly one language instruction');
  equal(test.state.args.task.slice(0, '继续修复'.length), '继续修复', 'a follow-up keeps its task verbatim as the prefix');
  equal(test.state.args.task.split(LANGUAGE_INSTRUCTION).length - 1, 1, 'a follow-up sends the marker once, including for pre-existing agents');
}

{
  const task = `继续修复\n\n${LANGUAGE_INSTRUCTION}`;
  const test = harness((child, message, state) => {
    if (message.method === 'initialize') initialize(child, message);
    else if (message.method === 'tools/call') {
      state.args = message.params.arguments;
      toolResult(child, message);
    }
  });
  await test.run({action: 'followup', args: {agent_id: 'A10', task}});
  equal(test.state.args.task, task, 'a follow-up task with the marker stays verbatim and is not duplicated');
}

{
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-entry-'));
  const oldCwd = process.cwd();
  try {
    const packageRoot = path.join(root, 'pkg');
    const entry = writeFakePackage(packageRoot);
    const base = {SOL_LUNA_DSH_PACKAGE_ROOT: packageRoot, npm_config_cache: path.join(root, 'cache')};
    equal(resolvePublishedEntry({env: base}), entry, 'an explicitly verified 0.7.0 package root is selected');
    equal(resolvePublishedEntry({env: {...base, SOL_LUNA_DSH_TRANSPORT: 'npx'}}), null, 'npx mode disables the local fast path');
    const oldRoot = path.join(root, 'old');
    writeFakePackage(oldRoot, '0.6.9');
    equal(resolvePublishedEntry({env: {...base, SOL_LUNA_DSH_PACKAGE_ROOT: oldRoot}}), null, 'a different package version is rejected');
    const wrongRoot = path.join(root, 'wrong');
    writeFakePackage(wrongRoot, '0.7.0', 'not-dsh');
    equal(resolvePublishedEntry({env: {...base, SOL_LUNA_DSH_PACKAGE_ROOT: wrongRoot}}), null, 'a different package name is rejected');

    const cacheRoot = path.join(root, 'npx-cache');
    const cacheEntry = writeFakePackage(path.join(cacheRoot, '_npx', 'hash', 'node_modules', 'dsh-subagent-mcp'));
    const emptyGlobal = {npm_config_cache: cacheRoot, APPDATA: path.join(root, 'empty-appdata'), npm_config_prefix: path.join(root, 'empty-prefix')};
    equal(resolvePublishedEntry({env: emptyGlobal}), cacheEntry, 'the trusted npx cache is selected after version verification');

    const appData = path.join(root, 'appdata');
    const globalEntry = writeFakePackage(path.join(appData, 'npm', 'node_modules', 'dsh-subagent-mcp'));
    equal(resolvePublishedEntry({env: {npm_config_cache: path.join(root, 'empty-cache'), APPDATA: appData}}), globalEntry,
      'the trusted npm global location is selected after version verification');

    const cwdPackage = writeFakePackage(path.join(root, 'node_modules', 'dsh-subagent-mcp'));
    process.chdir(root);
    equal(resolvePublishedEntry({env: {npm_config_cache: path.join(root, 'empty-cache'), APPDATA: path.join(root, 'none'), npm_config_prefix: path.join(root, 'none')}}), null,
      'cwd/node_modules is never searched or executed implicitly');
    ok(cwdPackage, 'the ignored cwd package is still a valid package, proving the path is deliberately skipped');
    equal(resolvePublishedEntry({env: base}), entry, 'the explicit package-root override remains deliberate and usable');
    equal(resolvePublishedEntry({env: {npm_config_cache: path.join(root, 'empty-cache')}}), null, 'an empty trusted cache falls back to npx');
  } finally {
    process.chdir(oldCwd);
    rmSync(root, {recursive: true, force: true});
  }
}

console.log(`PASS ${checks} MCP client assertions`);
