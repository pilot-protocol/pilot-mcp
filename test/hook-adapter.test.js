// `pilot-mcp hook` was the native pre/post tool hook for the retired hosted
// control plane. Harness settings written by releases <=0.3.0 still invoke
// it, so it must stay a silent allow under every condition those settings
// can produce.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runHook } from '../src/hooks/adapter.js';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
const HARNESSES = ['claude', 'codex', 'gemini', 'openhands', 'copilot', 'cursor', 'cline', 'hermes', 'openclaw', 'picoclaw'];

function runCLI(args, { input = '', env = {} } = {}) {
  // An empty PATH and a HOME without ~/.pilot prove the shim needs neither
  // pilotctl nor a runtime.
  const home = env.HOME ?? mkdtempSync(join(tmpdir(), 'pilot-hook-home-'));
  return spawnSync(process.execPath, [cli, ...args], {
    input, encoding: 'utf8', timeout: 20_000,
    env: { PATH: '', HOME: home, ...env },
  });
}

test('the retired hook is a silent allow for every harness and phase', () => {
  const event = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hello' } });
  for (const harness of HARNESSES) {
    for (const phase of ['pre', 'post']) {
      const result = runCLI(['hook', '--harness', harness, '--phase', phase], { input: event });
      assert.equal(result.status, 0, `${harness} ${phase}: ${result.stderr}`);
      assert.equal(result.stdout, '', `${harness} ${phase}`);
      assert.equal(result.stderr, '', `${harness} ${phase}`);
    }
  }
});

test('the retired hook allows without stdin, without a phase, and with malformed input', () => {
  for (const [args, input] of [
    [['hook', '--harness', 'claude', '--phase', 'pre'], ''],
    [['hook', '--harness', 'claude'], '{}'],
    [['hook', '--harness', 'claude', '--phase', 'pre'], 'not json'],
    [['hook'], ''],
  ]) {
    const result = runCLI(args, { input });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

test('a leftover control attachment no longer makes the hook block', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-hook-attached-'));
  const control = join(home, '.pilot', 'managed', 'enterprise-control.json');
  mkdirSync(dirname(control), { recursive: true });
  writeFileSync(control, '{}', { mode: 0o600 });
  for (const env of [{ HOME: home }, { HOME: home, PILOT_ENTERPRISE_CONTROL: control }]) {
    const result = runCLI(['hook', '--harness', 'claude', '--phase', 'pre'], { input: '{"tool_name":"Bash"}', env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

test('runHook resolves to an allow without any input', async () => {
  assert.deepEqual(await runHook(), { blocked: false });
});
