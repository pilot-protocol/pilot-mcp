import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { runPicoClawRPC } from '../src/hooks/picoclaw-rpc.js';

async function exchange(requests) {
  let stdout = '';
  let stderr = '';
  await runPicoClawRPC({
    stdin: Readable.from([requests.map((request) => JSON.stringify(request)).join('\n') + '\n']),
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
  });
  return { responses: stdout.trim().split('\n').map(JSON.parse), stderr };
}

test('retired PicoClaw process hook negotiates and lets every tool call continue', async () => {
  const { responses, stderr } = await exchange([
    { jsonrpc: '2.0', id: 1, method: 'hook.hello', params: {} },
    {
      jsonrpc: '2.0', id: 2, method: 'hook.before_tool',
      params: { tool: 'write_file', arguments: { path: '/tmp/a', content: 'hello' } },
    },
    { jsonrpc: '2.0', id: 3, method: 'hook.after_tool', params: { tool: 'write_file', result: 'ok' } },
  ]);
  assert.deepEqual(responses[0], { jsonrpc: '2.0', id: 1, result: { ok: true, name: 'pilot' } });
  assert.deepEqual(responses[1], { jsonrpc: '2.0', id: 2, result: { action: 'continue' } });
  assert.deepEqual(responses[2], { jsonrpc: '2.0', id: 3, result: { action: 'continue' } });
  assert.equal(stderr, '');
});

test('retired PicoClaw process hook ignores a leftover control attachment', { concurrency: false }, async () => {
  const original = process.env.PILOT_ENTERPRISE_CONTROL;
  process.env.PILOT_ENTERPRISE_CONTROL = '/tmp/test-enterprise-control.json';
  try {
    const { responses } = await exchange([
      { jsonrpc: '2.0', id: 1, method: 'hook.before_tool', params: { tool: 'bash', arguments: { command: 'rm -rf /' } } },
    ]);
    assert.deepEqual(responses[0], { jsonrpc: '2.0', id: 1, result: { action: 'continue' } });
  } finally {
    if (original === undefined) delete process.env.PILOT_ENTERPRISE_CONTROL;
    else process.env.PILOT_ENTERPRISE_CONTROL = original;
  }
});

test('retired PicoClaw process hook reports malformed and unknown requests as JSON-RPC errors', async () => {
  const { responses } = await exchange([
    { id: 7, method: 'hook.before_tool' },
    { jsonrpc: '2.0', id: 8, method: 'hook.unknown' },
  ]);
  assert.equal(responses[0].id, 7);
  assert.match(responses[0].error.message, /invalid PicoClaw hook request/);
  assert.equal(responses[1].id, 8);
  assert.match(responses[1].error.message, /unsupported PicoClaw hook method/);
});
