import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAttach, selectedHarnesses } from '../src/setup/attach.js';

test('adapter-only attach configures a harness without touching the core runtime', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-attach-'));
  const managed = join(home, '.pilot', 'managed');
  mkdirSync(managed, { recursive: true, mode: 0o700 });
  const control = join(managed, 'enterprise-control.json');
  writeFileSync(control, '{"mode":"managed"}\n', { mode: 0o600 });
  chmodSync(control, 0o600);
  const calls = [];
  const output = [];

  const result = await runAttach({ gemini: true }, {
    home,
    lstat: lstatSync,
    harnesses: { gemini: { configure: async (options) => calls.push(options) } },
    write: (line) => output.push(line),
  });

  assert.deepEqual(result.configured, ['gemini']);
  assert.equal(result.controlPath, control);
  assert.deepEqual(calls, [{ id: 'gemini', name: 'gemini', transport: 'managed', enterpriseControl: control }]);
  assert.match(output.join('\n'), /Core runtime and node identity were not changed/);
});

test('adapter-only attach requires an explicit harness and owner-only regular control', async () => {
  assert.throws(() => selectedHarnesses({}), /choose at least one harness/);
  await assert.rejects(
    runAttach({ gemini: true }, {
      home: '/unused',
      lstat: () => ({ isSymbolicLink: () => true, isFile: () => true, mode: 0o100600, uid: 123 }),
      platform: 'linux',
      uid: 123,
      harnesses: {},
      write: () => {},
    }),
    /not a regular file/,
  );
  await assert.rejects(
    runAttach({ gemini: true }, {
      home: '/unused',
      lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, mode: 0o100644, uid: 123 }),
      platform: 'linux',
      uid: 123,
      harnesses: {},
      write: () => {},
    }),
    /owner-only/,
  );
});
