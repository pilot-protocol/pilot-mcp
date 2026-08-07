import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ATTACHABLE_HARNESSES, runAttach, selectedHarnesses } from '../src/setup/attach.js';

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
  assert.deepEqual(result.skipped, []);
  assert.equal(result.controlPath, control);
  assert.deepEqual(calls, [{
    id: 'gemini', name: 'gemini', transport: 'managed', enterpriseControl: control,
    home, allowMissingHost: false,
  }]);
  assert.match(output.join('\n'), /Core runtime and node identity were not changed/);
});

test('attach --all skips a missing optional host without abandoning other harnesses', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-attach-all-'));
  const managed = join(home, '.pilot', 'managed');
  mkdirSync(managed, { recursive: true, mode: 0o700 });
  const control = join(managed, 'enterprise-control.json');
  writeFileSync(control, '{"mode":"managed"}\n', { mode: 0o600 });
  chmodSync(control, 0o600);
  const calls = [];
  const output = [];
  const harnesses = Object.fromEntries(ATTACHABLE_HARNESSES.map((id) => [id, {
    configure: async (options) => {
      calls.push(options);
      return id === 'openclaw' ? { skipped: true, reason: 'OpenClaw CLI is not installed' } : undefined;
    },
  }]));

  const result = await runAttach({ all: true }, {
    home,
    lstat: lstatSync,
    harnesses,
    write: (line) => output.push(line),
  });

  assert.equal(calls.length, ATTACHABLE_HARNESSES.length);
  assert.equal(calls.every((call) => call.allowMissingHost === true && call.home === home), true);
  assert.deepEqual(result.configured, ATTACHABLE_HARNESSES.filter((id) => id !== 'openclaw'));
  assert.deepEqual(result.skipped, [{ id: 'openclaw', reason: 'OpenClaw CLI is not installed' }]);
  assert.match(output.join('\n'), /Skipped openclaw \(OpenClaw CLI is not installed\)/);
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
