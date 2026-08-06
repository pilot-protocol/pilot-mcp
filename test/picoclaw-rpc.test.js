import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { runPicoClawRPC } from '../src/hooks/picoclaw-rpc.js';

test('PicoClaw process hook negotiates and leaves an unattached tool call unchanged', { concurrency: false }, async () => {
  const originalControl = process.env.PILOT_ENTERPRISE_CONTROL;
  delete process.env.PILOT_ENTERPRISE_CONTROL;
  let stdout = '';
  let stderr = '';
  try {
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'hook.hello', params: {} },
      {
        jsonrpc: '2.0', id: 2, method: 'hook.before_tool',
        params: { tool: 'write_file', arguments: { path: '/tmp/a', content: 'hello' } },
      },
    ].map((request) => JSON.stringify(request)).join('\n') + '\n';
    await runPicoClawRPC({
      stdin: Readable.from([requests]),
      stdout: { write(value) { stdout += value; } },
      stderr: { write(value) { stderr += value; } },
    });
    const responses = stdout.trim().split('\n').map(JSON.parse);
    assert.deepEqual(responses[0], { jsonrpc: '2.0', id: 1, result: { ok: true, name: 'pilot' } });
    assert.deepEqual(responses[1], { jsonrpc: '2.0', id: 2, result: { action: 'continue' } });
    assert.equal(stderr, '');
  } finally {
    if (originalControl === undefined) delete process.env.PILOT_ENTERPRISE_CONTROL;
    else process.env.PILOT_ENTERPRISE_CONTROL = originalControl;
  }
});
