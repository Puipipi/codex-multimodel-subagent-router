import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {runClient} from '../scripts/dsh-mcp-client.mjs';

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const deepEqual = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1; };

class FakeChild extends EventEmitter {
  constructor(onMessage) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.closed = false;
    let buffer = '';
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line) onMessage(this, JSON.parse(line));
      }
    });
  }
  send(value) { this.stdout.write(`${JSON.stringify(value)}\n`); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', 0, null);
  }
  kill() { this.killed = true; this.close(); return true; }
}

function harness() {
  const state = {messages: [], calls: [], args: null, options: null, child: null};
  const spawnProcess = (command, args, options) => {
    state.args = args;
    state.options = options;
    state.child = new FakeChild((child, message) => {
      state.messages.push(message);
      if (message.method === 'initialize') child.send({jsonrpc: '2.0', id: message.id, result: {serverInfo: {name: 'fake-dsh'}}});
      else if (message.method === 'tools/call') {
        state.calls.push(message.params);
        child.send({jsonrpc: '2.0', id: message.id, result: {content: [{type: 'text', text: JSON.stringify({ok: true})}]}});
      }
    });
    return state.child;
  };
  return {state, run: request => runClient(request, {spawnProcess, handshakeTimeoutMs: 1000, callTimeoutMs: 1000})};
}

{
  const test = harness();
  const output = await test.run({
    action: 'events',
    args: {agent_id: 'A1', after: 4, include_progress: true, include_descendants: true, include_tool_events: true},
    npxCli: 'npx-cli.js',
    meta: {threadId: 'chat-one'},
  });
  equal(output.tool, 'dsh_events', 'events maps to dsh_events');
  deepEqual(test.state.args.slice(1), ['--yes', 'dsh-subagent-mcp@0.7.0', 'mcp'], 'events still uses the published DSH 0.7 transport');
  equal(test.state.calls[0].name, 'dsh_events', 'the MCP call is dsh_events');
  deepEqual(test.state.calls[0].arguments, {agent_id: 'A1', after: 4, include_progress: true, include_descendants: true, include_tool_events: true},
    'event options are forwarded');
  deepEqual(test.state.calls[0]._meta, {threadId: 'chat-one'}, 'trusted request metadata is forwarded');
  equal(test.state.child.killed, true, 'the MCP child is released after the call');
}

for (const [action, args, tool, expected] of [
  ['close', {agent_id: 'A2', legacy: true}, 'dsh_close', {agent_id: 'A2', legacy: true}],
  ['rename', {agent_id: 'A3', name: 'renamed'}, 'dsh_rename', {agent_id: 'A3', name: 'renamed'}],
  ['events', {agent_id: 'A4', after: 'cursor-1'}, 'dsh_events', {agent_id: 'A4', after: 'cursor-1'}],
]) {
  const test = harness();
  const output = await test.run({action, args, npxCli: 'npx-cli.js'});
  equal(output.tool, tool, `${action} maps to ${tool}`);
  deepEqual(test.state.calls[0].arguments, expected, `${action} forwards its arguments`);
  equal(test.state.calls[0]._meta, undefined, 'metadata is omitted unless the wrapper supplies it');
}

for (const [name, request, pattern] of [
  ['invalid after', {action: 'events', args: {agent_id: 'A1', after: -1}}, /after must be/],
  ['event id zero', {action: 'events', args: {agent_id: 'A1', event_id: 0}}, /event_id is outside/],
  ['rename without name', {action: 'rename', args: {agent_id: 'A1'}}, /rename requires name/],
  ['empty meta thread', {action: 'show', args: {agent_id: 'A1'}, meta: {threadId: ''}}, /meta\.threadId must be a non-empty string/],
  ['non-object meta', {action: 'show', args: {agent_id: 'A1'}, meta: 'chat'}, /meta must be an object/],
]) {
  const test = harness();
  try {
    await test.run({...request, npxCli: 'npx-cli.js'});
    throw new Error(`expected rejection: ${name}`);
  } catch (error) {
    assert.match(error.message, pattern, name);
    checks += 1;
  }
  equal(test.state.args, null, `${name} is rejected before spawning MCP`);
}

console.log(`PASS ${checks} plugin client assertions`);
