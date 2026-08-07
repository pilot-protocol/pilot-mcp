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

test('Gemini pre and post events correlate without a native tool call ID', () => {
  const common = {
    session_id: 'gemini-session',
    transcript_path: '/tmp/session.jsonl',
    cwd: '/workspace',
    tool_name: 'mcp_pilot_pilot_send',
    tool_input: { peer: 'vendor-x', data: 'hello' },
  };
  const before = toPilotHookRequest('gemini', 'pre', {
    ...common, hook_event_name: 'BeforeTool', timestamp: '2026-08-07T00:00:00Z',
  });
  const after = toPilotHookRequest('gemini', 'post', {
    ...common, hook_event_name: 'AfterTool', timestamp: '2026-08-07T00:00:02Z',
    tool_response: { llmContent: 'sent', returnDisplay: 'sent' },
  });
  assert.equal(after.attempt_key, before.attempt_key);
  assert.equal(after.resume_token, before.resume_token);
  assert.match(before.attempt_key, /^gemini:gemini-session:content-/);

  const other = toPilotHookRequest('gemini', 'pre', {
    ...common, hook_event_name: 'BeforeTool', tool_input: { peer: 'vendor-x', data: 'different' },
  });
  assert.notEqual(other.attempt_key, before.attempt_key);
});

test('Pilot MCP calls retain their business action instead of collapsing to tool.invoke', () => {
  assert.deepEqual(mapToolAction('mcp__pilot__pilot_send', { peer: 'vendor-x' }), {
    action: 'data.send.text', resource: 'agent:vendor-x/inbox',
  });
  assert.deepEqual(mapToolAction('mcp_pilot_pilot_send', { peer: 'vendor-x' }), {
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
    preToolUse: { tool: 'execute_command', parameters: { command: 'curl https://vendor.test' } },
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

test('all native harness contracts preserve tool identity, session, and complete arguments', () => {
  const cases = [
    ['claude', { session_id: 's-claude', hook_event_name: 'PreToolUse', tool_use_id: 'c-1', tool_name: 'Bash', tool_input: { command: 'echo claude' } }],
    ['codex', { session_id: 's-codex', hook_event_name: 'PreToolUse', tool_use_id: 'c-2', tool_name: 'Bash', tool_input: { command: 'echo codex' } }],
    ['gemini', { session_id: 's-gemini', hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'echo gemini' } }],
    ['openhands', { session_id: 's-openhands', hook_event_name: 'PreToolUse', tool_use_id: 'c-4', tool_name: 'Bash', tool_input: { command: 'echo openhands' } }],
    ['copilot', { sessionId: 's-copilot', hookEventName: 'preToolUse', toolCallId: 'c-5', toolName: 'execute_command', toolArgs: { command: 'echo copilot' } }],
    ['cursor', { session_id: 's-cursor', hook_event_name: 'preToolUse', tool_use_id: 'c-6', tool_name: 'shell', tool_input: { command: 'echo cursor' } }],
    ['cline', { taskId: 's-cline', hookName: 'PreToolUse', preToolUse: { toolName: 'execute_command', parameters: { command: 'echo cline' } } }],
    ['hermes', { session_id: 's-hermes', hook_event_name: 'pre_tool_call', tool_name: 'terminal', tool_input: { command: 'echo hermes' }, extra: { tool_call_id: 'c-8' } }],
    ['openclaw', { session_id: 's-openclaw', hook_event_name: 'before_tool_call', tool_use_id: 'c-9', tool_name: 'execute_command', tool_input: { command: 'echo openclaw' } }],
    ['picoclaw', { session_id: 's-picoclaw', hook_event_name: 'hook.before_tool', tool_use_id: 'c-10', tool: 'execute_command', arguments: { command: 'echo picoclaw' } }],
  ];
  for (const [harness, native] of cases) {
    const request = toPilotHookRequest(harness, 'pre', native);
    const content = JSON.parse(Buffer.from(request.content_base64, 'base64').toString());
    assert.equal(request.adapter_id, `harness.${harness}`);
    assert.match(request.attempt_key, new RegExp(`^${harness}:s-${harness}:`));
    assert.equal(request.action, 'process.execute');
    assert.equal(content.tool_input.command, `echo ${harness}`);
    assert.ok(content.tool_name);
  }
});

test('post-hook failure payloads retain host-native error and timing evidence', () => {
  const cline = toPilotHookRequest('cline', 'post', {
    taskId: 'task-1', hookName: 'PostToolUse',
    postToolUse: {
      tool: 'execute_command', parameters: { command: 'false' }, result: 'exit 1',
      success: false, executionTimeMs: 42,
    },
  });
  assert.equal(cline.status, 'failed');
  assert.deepEqual(JSON.parse(Buffer.from(cline.content_base64, 'base64').toString()).tool_response, {
    success: false, duration_ms: 42, result: 'exit 1',
  });

  const cursor = toPilotHookRequest('cursor', 'post', {
    session_id: 'cursor-1', hook_event_name: 'postToolUseFailure', tool_name: 'shell',
    tool_input: { command: 'false' }, error_message: 'exit 1', failure_type: 'nonzero_exit', is_interrupt: false,
  });
  assert.equal(cursor.status, 'failed');
  assert.deepEqual(JSON.parse(Buffer.from(cursor.content_base64, 'base64').toString()).tool_response, {
    error: 'exit 1', failure_type: 'nonzero_exit', is_interrupt: false,
  });

  const copilot = toPilotHookRequest('copilot', 'post', {
    sessionId: 'copilot-1', hookEventName: 'postToolUseFailure', toolName: 'execute_command',
    toolArgs: { command: 'false' }, error: 'command failed',
  });
  assert.equal(copilot.status, 'failed');
  assert.deepEqual(JSON.parse(Buffer.from(copilot.content_base64, 'base64').toString()).tool_response, {
    error: 'command failed',
  });
});

test('every managed pre-hook emits the host-specific blocking contract', { concurrency: false }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pilot-all-hook-denials-'));
  const binary = join(directory, 'pilotctl');
  writeFileSync(binary, '#!/bin/sh\nprintf \'%s\\n\' \'{"data":{"execute":false,"outcome":"deny","reasons":["blocked marker"]}}\'\n');
  chmodSync(binary, 0o700);
  const originalControl = process.env.PILOT_ENTERPRISE_CONTROL;
  const originalPilotctl = process.env.PILOTCTL_BIN;
  process.env.PILOT_ENTERPRISE_CONTROL = '/tmp/test-enterprise-control.json';
  process.env.PILOTCTL_BIN = binary;
  const cases = [
    ['claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo x' } }, 'exit'],
    ['codex', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo x' } }, 'exit'],
    ['gemini', { hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'echo x' } }, 'exit'],
    ['openhands', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo x' } }, 'exit'],
    ['copilot', { hookEventName: 'preToolUse', toolName: 'execute_command', toolArgs: { command: 'echo x' } }, 'exit'],
    ['cursor', { hook_event_name: 'preToolUse', tool_name: 'shell', tool_input: { command: 'echo x' } }, 'cursor'],
    ['cline', { hookName: 'PreToolUse', preToolUse: { tool: 'execute_command', parameters: { command: 'echo x' } } }, 'cline'],
    ['hermes', { hook_event_name: 'pre_tool_call', tool_name: 'terminal', tool_input: { command: 'echo x' } }, 'hermes'],
    ['openclaw', { hook_event_name: 'before_tool_call', tool_name: 'execute_command', tool_input: { command: 'echo x' } }, 'exit'],
    ['picoclaw', { hook_event_name: 'hook.before_tool', tool: 'execute_command', arguments: { command: 'echo x' } }, 'picoclaw'],
  ];
  try {
    for (const [harness, native, contract] of cases) {
      let stdout = '';
      let stderr = '';
      let exitCode = 0;
      const result = await runHook({ harness, phase: 'pre' }, {
        stdin: Readable.from([JSON.stringify(native)]),
        stdout: { write(value) { stdout += value; } },
        stderr: { write(value) { stderr += value; } },
        setExitCode(value) { exitCode = value; },
      });
      assert.equal(result.blocked, true, harness);
      if (contract === 'exit') {
        assert.equal(exitCode, 2, harness);
        assert.match(stderr, /blocked marker/, harness);
      } else {
        assert.equal(exitCode, 0, harness);
        const output = JSON.parse(stdout);
        if (contract === 'cursor') assert.equal(output.permission, 'deny');
        if (contract === 'cline') assert.equal(output.cancel, true);
        if (contract === 'hermes') assert.equal(output.decision, 'block');
        if (contract === 'picoclaw') assert.equal(output.action, 'deny_tool');
      }
    }
  } finally {
    if (originalControl === undefined) delete process.env.PILOT_ENTERPRISE_CONTROL;
    else process.env.PILOT_ENTERPRISE_CONTROL = originalControl;
    if (originalPilotctl === undefined) delete process.env.PILOTCTL_BIN;
    else process.env.PILOTCTL_BIN = originalPilotctl;
  }
});

test('managed pre-hooks fail closed before the host timeout can fail open', { concurrency: false }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pilot-hook-timeout-'));
  const binary = join(directory, 'pilotctl');
  writeFileSync(binary, '#!/usr/bin/env node\nsetTimeout(() => {}, 5000);\n');
  chmodSync(binary, 0o700);
  const originals = {
    control: process.env.PILOT_ENTERPRISE_CONTROL,
    binary: process.env.PILOTCTL_BIN,
    timeout: process.env.PILOT_HOOK_TIMEOUT_MS,
  };
  process.env.PILOT_ENTERPRISE_CONTROL = '/tmp/test-enterprise-control.json';
  process.env.PILOTCTL_BIN = binary;
  process.env.PILOT_HOOK_TIMEOUT_MS = '50';
  let stderr = '';
  let exitCode = 0;
  const started = Date.now();
  try {
    const result = await runHook({ harness: 'copilot', phase: 'pre' }, {
      stdin: Readable.from([JSON.stringify({ toolName: 'execute_command', toolArgs: { command: 'echo x' } })]),
      stdout: { write() {} },
      stderr: { write(value) { stderr += value; } },
      setExitCode(value) { exitCode = value; },
    });
    assert.equal(result.blocked, true);
    assert.equal(exitCode, 2);
    assert.match(stderr, /timed out after 50ms/);
    assert.ok(Date.now() - started < 1000);
  } finally {
    if (originals.control === undefined) delete process.env.PILOT_ENTERPRISE_CONTROL;
    else process.env.PILOT_ENTERPRISE_CONTROL = originals.control;
    if (originals.binary === undefined) delete process.env.PILOTCTL_BIN;
    else process.env.PILOTCTL_BIN = originals.binary;
    if (originals.timeout === undefined) delete process.env.PILOT_HOOK_TIMEOUT_MS;
    else process.env.PILOT_HOOK_TIMEOUT_MS = originals.timeout;
  }
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
    tool_name: 'terminal', tool_input: { command: 'curl https://example.test' },
    tool_response: { duration_ms: 17, result: { status: 200 } },
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
      stdin: {
        [Symbol.asyncIterator]() {
          throw new Error('unmanaged hook must not inspect stdin');
        },
      },
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

test('an explicitly managed hook rejects a successful but non-authoritative response', { concurrency: false }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pilot-malformed-decision-'));
  const binary = join(directory, 'pilotctl');
  writeFileSync(binary, '#!/bin/sh\nprintf \'%s\\n\' \'{"data":{}}\'\n');
  chmodSync(binary, 0o700);
  const originalControl = process.env.PILOT_ENTERPRISE_CONTROL;
  const originalPilotctl = process.env.PILOTCTL_BIN;
  process.env.PILOT_ENTERPRISE_CONTROL = '/tmp/test-enterprise-control.json';
  process.env.PILOTCTL_BIN = binary;
  let stderr = '';
  let exitCode = 0;
  try {
    const result = await runHook({ harness: 'gemini', phase: 'pre' }, {
      stdin: Readable.from([JSON.stringify({ tool_name: 'run_shell_command', tool_input: { command: 'echo hello' } })]),
      stdout: { write() {} },
      stderr: { write(value) { stderr += value; } },
      setExitCode(value) { exitCode = value; },
    });
    assert.equal(result.blocked, true);
    assert.equal(exitCode, 2);
    assert.match(stderr, /no authoritative execute decision/);
  } finally {
    if (originalControl === undefined) delete process.env.PILOT_ENTERPRISE_CONTROL;
    else process.env.PILOT_ENTERPRISE_CONTROL = originalControl;
    if (originalPilotctl === undefined) delete process.env.PILOTCTL_BIN;
    else process.env.PILOTCTL_BIN = originalPilotctl;
  }
});
