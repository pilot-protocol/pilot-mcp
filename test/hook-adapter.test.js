import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { mapToolAction, runHook, toPilotHookRequest } from '../src/hooks/adapter.js';

test('Claude and Codex shell events become exact process.execute preflights', () => {
  const claude = toPilotHookRequest('claude', 'pre', {
    session_id: 'session-a', hook_event_name: 'PreToolUse', tool_use_id: 'call-a',
    tool_name: 'Bash', tool_input: { command: 'sudo rm -rf /tmp/example' }, cwd: '/repo',
  });
  assert.equal(claude.action, 'process.execute');
  assert.equal(claude.resource, 'process:rm');
  assert.equal(claude.adapter_id, 'harness.claude');
  assert.equal(claude.attempt_key, 'claude:session-a:call-a');
  assert.deepEqual(JSON.parse(Buffer.from(claude.content_base64, 'base64').toString()), {
    tool_name: 'Bash', tool_input: { command: 'sudo rm -rf /tmp/example' },
  });

  const codex = toPilotHookRequest('codex', 'pre', {
    session_id: 'session-b', hook_event_name: 'PreToolUse', tool_use_id: 'call-b',
    tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch' },
  });
  assert.equal(codex.action, 'file.write');
});

test('post hook carries the complete tool result and failure category', () => {
  const request = toPilotHookRequest('codex', 'post', {
    session_id: 'session-a', hook_event_name: 'PostToolUseFailure', tool_use_id: 'call-a',
    tool_name: 'Bash', tool_input: { command: 'false' }, tool_response: { output: 'failed', code: 1 },
  });
  assert.equal(request.status, 'failed');
  assert.equal(request.error_code, 'tool_failed');
  assert.deepEqual(JSON.parse(Buffer.from(request.content_base64, 'base64').toString()), {
    tool_name: 'Bash', tool_input: { command: 'false' }, tool_response: { output: 'failed', code: 1 },
  });
});

test('Pilot MCP calls retain their business action instead of collapsing to tool.invoke', () => {
  assert.deepEqual(mapToolAction('mcp__pilot__pilot_send', { peer: 'vendor-x' }), {
    action: 'data.send.text', resource: 'agent:vendor-x/inbox',
  });
  assert.deepEqual(mapToolAction('pilot_handshake', { target: 'unknown-agent' }), {
    action: 'trust.request', resource: 'agent:unknown-agent',
  });
  assert.deepEqual(mapToolAction('some_custom_tool', {}), {
    action: 'tool.invoke', resource: 'tool:some_custom_tool',
  });
});

test('Cline, Cursor and PicoClaw native payloads preserve their actual action content', () => {
  const cline = toPilotHookRequest('cline', 'pre', {
    hookName: 'PreToolUse', taskId: 'task-1',
    preToolUse: { toolName: 'execute_command', parameters: { command: 'curl https://vendor.test' } },
  });
  assert.equal(cline.action, 'process.execute');
  assert.equal(cline.resource, 'process:curl');

  const cursor = toPilotHookRequest('cursor', 'pre', {
    hook_event_name: 'beforeShellExecution', command: 'rm -rf /tmp/example', cwd: '/repo',
  });
  assert.equal(cursor.action, 'process.execute');
  assert.deepEqual(JSON.parse(Buffer.from(cursor.content_base64, 'base64').toString()).tool_input, {
    command: 'rm -rf /tmp/example', cwd: '/repo',
  });

  const pico = toPilotHookRequest('picoclaw', 'pre', {
    hook_event_name: 'hook.before_tool', tool: 'write_file', arguments: { path: '/tmp/out', content: 'secret' },
    meta: { SessionKey: 'pico-session', TurnID: 'turn-1' },
  });
  assert.equal(pico.action, 'file.write');
});

test('approval retries share a stable resume token while attempts stay call-specific', () => {
  const base = {
    session_id: 'session-a', hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'curl https://vendor.example/pay' },
  };
  const first = toPilotHookRequest('claude', 'pre', { ...base, tool_use_id: 'call-1' });
  const retry = toPilotHookRequest('claude', 'pre', { ...base, tool_use_id: 'call-2' });
  assert.notEqual(first.attempt_key, retry.attempt_key);
  assert.equal(first.resume_token, retry.resume_token);
});

test('file-share preflight never opens a model-supplied local path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pilot-hook-'));
  const path = join(directory, 'proof.md');
  writeFileSync(path, 'ULTIMATE-GOAL-BLOCK-20260803');
  const request = toPilotHookRequest('claude', 'pre', {
    session_id: 'session-file', hook_event_name: 'PreToolUse', tool_use_id: 'call-file',
    tool_name: 'mcp__pilot__pilot_send_file', tool_input: { peer: 'external-agent', path },
  });
  const content = JSON.parse(Buffer.from(request.content_base64, 'base64').toString());
  assert.equal(request.action, 'file.share');
  assert.deepEqual(content, {
    tool_name: 'mcp__pilot__pilot_send_file',
    tool_input: { peer: 'external-agent', path },
  });
  assert.equal(content.file_attachment, undefined);
});

test('Hermes shell-hook events retain one tool-call identity and complete result', () => {
  const before = toPilotHookRequest('hermes', 'pre', {
    hook_event_name: 'pre_tool_call', tool_name: 'terminal',
    tool_input: { command: 'curl https://example.test' }, session_id: 'hermes-session', cwd: '/repo',
    extra: { task_id: 'task-a', tool_call_id: 'hermes-call-1', model: 'gemini-2.5-pro' },
  });
  const after = toPilotHookRequest('hermes', 'post', {
    hook_event_name: 'post_tool_call', tool_name: 'terminal',
    tool_input: { command: 'curl https://example.test' }, session_id: 'hermes-session', cwd: '/repo',
    extra: { task_id: 'task-a', tool_call_id: 'hermes-call-1', result: '{"status":200}', duration_ms: 17 },
  });
  assert.equal(before.attempt_key, 'hermes:hermes-session:hermes-call-1');
  assert.equal(after.attempt_key, before.attempt_key);
  assert.equal(after.status, 'succeeded');
  assert.deepEqual(JSON.parse(Buffer.from(after.content_base64, 'base64').toString()), {
    tool_name: 'terminal', tool_input: { command: 'curl https://example.test' }, tool_response: { status: 200 },
  });
});

test('Hermes denial uses its explicit block JSON instead of a non-blocking exit code', { concurrency: false }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pilot-hermes-hook-'));
  const binary = join(directory, 'pilotctl');
  writeFileSync(binary, '#!/bin/sh\nprintf \'%s\\n\' \'{"data":{"execute":false,"outcome":"deny","reasons":["semantic policy"]}}\'\n');
  chmodSync(binary, 0o700);
  const originalPath = process.env.PATH;
  const originalControl = process.env.PILOT_ENTERPRISE_CONTROL;
  const originalPilotctl = process.env.PILOTCTL_BIN;
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
  process.env.PILOTCTL_BIN = binary;
  process.env.PILOT_ENTERPRISE_CONTROL = '/tmp/test-enterprise-control.json';
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    const result = await runHook({ harness: 'hermes', phase: 'pre' }, {
      stdin: Readable.from([JSON.stringify({
        hook_event_name: 'pre_tool_call', tool_name: 'terminal', tool_input: { command: 'echo hello' },
        session_id: 'hermes-session', extra: { tool_call_id: 'call-1' },
      })]),
      stdout: { write(value) { stdout += value; } },
      stderr: { write(value) { stderr += value; } },
      setExitCode(value) { exitCode = value; },
    });
    assert.equal(result.blocked, true);
    assert.deepEqual(JSON.parse(stdout), { decision: 'block', reason: 'Pilot policy denied this action. semantic policy' });
    assert.equal(stderr, '');
    assert.equal(exitCode, 0);
  } finally {
    process.env.PATH = originalPath;
    if (originalControl === undefined) delete process.env.PILOT_ENTERPRISE_CONTROL;
    else process.env.PILOT_ENTERPRISE_CONTROL = originalControl;
    if (originalPilotctl === undefined) delete process.env.PILOTCTL_BIN;
    else process.env.PILOTCTL_BIN = originalPilotctl;
  }
});

test('an installed but unattached hook is a zero-side-effect pass-through', { concurrency: false }, async () => {
  const originalControl = process.env.PILOT_ENTERPRISE_CONTROL;
  delete process.env.PILOT_ENTERPRISE_CONTROL;
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    const result = await runHook({ harness: 'claude', phase: 'pre' }, {
      stdin: Readable.from(['{}']),
      stdout: { write(value) { stdout += value; } },
      stderr: { write(value) { stderr += value; } },
      setExitCode(value) { exitCode = value; },
    });
    assert.deepEqual(result, { blocked: false, unmanaged: true });
    assert.equal(stdout, '');
    assert.equal(stderr, '');
    assert.equal(exitCode, 0);
  } finally {
    if (originalControl === undefined) delete process.env.PILOT_ENTERPRISE_CONTROL;
    else process.env.PILOT_ENTERPRISE_CONTROL = originalControl;
  }
});

test('an explicitly managed hook fails closed when the control plane is unavailable', { concurrency: false }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pilot-unavailable-hook-'));
  const binary = join(directory, 'pilotctl');
  writeFileSync(binary, '#!/bin/sh\nprintf "control plane offline\\n" >&2\nexit 1\n');
  chmodSync(binary, 0o700);
  const originalPath = process.env.PATH;
  const originalControl = process.env.PILOT_ENTERPRISE_CONTROL;
  const originalPilotctl = process.env.PILOTCTL_BIN;
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
  process.env.PILOTCTL_BIN = binary;
  process.env.PILOT_ENTERPRISE_CONTROL = '/tmp/test-enterprise-control.json';
  let stderr = '';
  let exitCode = 0;
  try {
    const result = await runHook({ harness: 'claude', phase: 'pre' }, {
      stdin: Readable.from([JSON.stringify({
        hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hello' },
      })]),
      stdout: { write() {} },
      stderr: { write(value) { stderr += value; } },
      setExitCode(value) { exitCode = value; },
    });
    assert.equal(result.blocked, true);
    assert.match(stderr, /Pilot control plane unavailable/);
    assert.equal(exitCode, 2);
  } finally {
    process.env.PATH = originalPath;
    if (originalControl === undefined) delete process.env.PILOT_ENTERPRISE_CONTROL;
    else process.env.PILOT_ENTERPRISE_CONTROL = originalControl;
    if (originalPilotctl === undefined) delete process.env.PILOTCTL_BIN;
    else process.env.PILOTCTL_BIN = originalPilotctl;
  }
});
