import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { evaluate } from '../src/openclaw-plugin/evaluate.js';

function fakeSpawn(mode, observation = {}) {
  return (command, args) => {
    observation.command = command;
    observation.args = args;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        observation.input = (observation.input ?? '') + chunk.toString();
        callback();
      },
    });
    child.kill = () => { observation.killed = true; return true; };
    queueMicrotask(() => {
      if (mode === 'allow') child.emit('close', 0);
      if (mode === 'deny') {
        child.stderr.write('semantic policy denied');
        child.emit('close', 2);
      }
      if (mode === 'error') child.emit('error', new Error('npx unavailable'));
    });
    return child;
  };
}

test('OpenClaw plugin invokes the pinned adapter and preserves the entire event', async () => {
  const observation = {};
  const event = { tool_name: 'execute_command', tool_input: { command: 'echo hello' } };
  const result = await evaluate('pre', event, { spawn: fakeSpawn('allow', observation), env: {} });
  assert.deepEqual(result, { blocked: false });
  assert.equal(observation.command, 'npx');
  assert.deepEqual(observation.args, [
    '-y', 'pilotprotocol-mcp@0.3.0', 'hook', '--harness', 'openclaw', '--phase', 'pre',
  ]);
  assert.deepEqual(JSON.parse(observation.input), event);
});

test('OpenClaw plugin converts adapter denial and launch failure into explicit pre-hook blocks', async () => {
  const denied = await evaluate('pre', {}, { spawn: fakeSpawn('deny'), env: {} });
  assert.deepEqual(denied, { blocked: true, reason: 'semantic policy denied' });
  const unavailable = await evaluate('pre', {}, { spawn: fakeSpawn('error'), env: {} });
  assert.equal(unavailable.blocked, true);
  assert.match(unavailable.reason, /control plane unavailable/);
});

test('OpenClaw plugin resolves a fail-closed decision before its host timeout', async () => {
  const observation = {};
  const started = Date.now();
  const result = await evaluate('pre', {}, {
    spawn: fakeSpawn('hang', observation),
    env: { PILOT_OPENCLAW_HOOK_TIMEOUT_MS: '50' },
  });
  assert.equal(result.blocked, true);
  assert.match(result.reason, /timed out after 50ms/);
  assert.equal(observation.killed, true);
  assert.ok(Date.now() - started < 1000);
});

test('OpenClaw post-hook failures remain evidence errors and never replay a side effect', async () => {
  await assert.rejects(
    evaluate('post', {}, { spawn: fakeSpawn('error'), env: {} }),
    /npx unavailable/,
  );
});
