// Harness-neutral external pre/post hook adapter.
//
// Native agent hooks send different event shapes, but Pilot's enforcement
// contract is intentionally one small JSON boundary. This adapter preserves
// the complete tool input/output as hosted federation content and maps the
// called tool to Pilot's canonical action vocabulary.

import { createHash } from 'node:crypto';
import process from 'node:process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { execPilotctl } from '../daemon-bridge.js';

const MAX_CONTENT_BYTES = 16 << 20;
const SUPPORTED_HARNESSES = new Set([
  'claude', 'codex', 'gemini', 'openhands', 'copilot', 'cursor', 'cline', 'hermes',
  'openclaw', 'picoclaw',
]);

export async function runHook(flags, io = defaultIO()) {
  const harness = String(flags.harness ?? '').trim().toLowerCase();
  const explicitPhase = String(flags.phase ?? '').trim().toLowerCase();
  if (!SUPPORTED_HARNESSES.has(harness)) {
    throw new Error(`unsupported hook harness ${harness || '(missing)'}`);
  }
  const native = await readNativeEvent(io.stdin);
  const phase = explicitPhase || eventPhase(native);
  if (phase !== 'pre' && phase !== 'post') {
    throw new Error('hook phase must be pre or post');
  }
  const configuredPath = String(process.env.PILOT_ENTERPRISE_CONTROL ?? '').trim();
  const adoptedPath = join(homedir(), '.pilot', 'managed', 'enterprise-control.json');
  const controlPath = configuredPath || (existsSync(adoptedPath) ? adoptedPath : '');
  // Installing an adapter is not consent to managed control. An unattached
  // node must behave exactly as it did before setup: no pilotctl dependency,
  // no content upload, no local inspection, and no altered host response.
  if (!controlPath) return { blocked: false, unmanaged: true };
  const request = toPilotHookRequest(harness, phase, native);
  try {
    const result = await execPilotctl(
      ['enterprise', 'hook', phase, '--control', controlPath, '--json'],
      { capture: true, input: JSON.stringify(request) },
    );
    if (result.code !== 0) {
      throw new Error(cleanPilotctlError(result.stderr, result.stdout));
    }
    const parsed = JSON.parse(result.stdout);
    const response = parsed?.data ?? parsed;
    if (phase === 'pre' && response.execute === false) {
      blockNativeHook(harness, formatBlockReason(response), io);
      return { blocked: true, response };
    }
    if (response.warning) io.stderr.write(`Pilot: ${response.warning}\n`);
    return { blocked: false, response };
  } catch (error) {
    // Once an enterprise attachment is explicitly enabled, a broken policy
    // path must never quietly become permission to execute. Post-hooks remain
    // evidence-only: their failure is visible but cannot retry a side effect.
    if (phase === 'pre' && controlPath) {
      blockNativeHook(harness, `Pilot control plane unavailable: ${error.message}`, io);
      return { blocked: true, error };
    }
    if (phase === 'post') {
      io.stderr.write(`Pilot post-hook evidence failure: ${error.message}\n`);
      return { blocked: false, error };
    }
    throw error;
  }
}

export function toPilotHookRequest(harness, phase, native) {
  const toolName = nativeToolName(harness, native);
  if (!toolName) throw new Error('native hook event is missing tool_name');
  const sessionID = stringValue(native.session_id ?? native.sessionId ?? native.conversation_id ?? 'session');
  const eventName = stringValue(native.hook_event_name ?? native.hookEventName ?? native.event_type ?? native.eventName ?? phase);
  const input = parseJSONValue(native.tool_input ?? native.toolInput ?? native.toolArgs ?? native.arguments ?? native.parameters ?? native.preToolUse?.parameters ?? native.params ?? cursorSyntheticInput(native) ?? {});
  const mapped = mapToolAction(toolName, input);
  const stableResume = digest({ harness, sessionID, toolName, action: mapped.action, resource: mapped.resource, input });
  const nativeToolUseID = stringValue(native.tool_use_id ?? native.toolUseId ?? native.call_id ?? native.toolCallId ?? native.extra?.tool_call_id);
  // Gemini's documented BeforeTool/AfterTool schema has no call identifier.
  // Hash the fields that are stable across both events instead of the full
  // native payload (which changes event name, timestamp and tool response).
  // Harnesses that expose a real call ID retain that stronger correlation.
  const toolUseID = nativeToolUseID || `content-${stableResume}`;
  const requestContent = phase === 'pre'
    ? { tool_name: toolName, tool_input: input }
    : {
        tool_name: toolName,
        tool_input: input,
        tool_response: parseJSONValue(native.tool_response ?? native.toolResponse ?? native.toolResult ?? native.tool_output ?? native.output ?? native.result ?? native.postToolUse?.result ?? native.extra?.result ?? null),
      };
  const content = Buffer.from(JSON.stringify(requestContent), 'utf8');
  if (content.byteLength > MAX_CONTENT_BYTES) {
    throw new Error(`native hook content exceeds ${MAX_CONTENT_BYTES} bytes`);
  }
  return {
    version: 1,
    attempt_key: `${harness}:${sessionID}:${toolUseID}`.slice(0, 1024),
    action: mapped.action,
    resource: mapped.resource,
    adapter_id: `harness.${harness}`,
    content_type: 'application/json',
    content_base64: content.toString('base64'),
    attributes: compactAttributes({
      harness,
      tool: toolName,
      event: eventName,
      session: sessionID,
      cwd: native.cwd,
      permission_mode: native.permission_mode ?? native.permissionMode,
      model: native.model ?? native.extra?.model,
      platform: native.platform ?? native.extra?.platform,
    }),
    resume_token: `hook-${stableResume}`,
    ...(phase === 'post' ? {
      status: postStatus(eventName, native),
      error_code: postStatus(eventName, native) === 'failed' ? 'tool_failed' : undefined,
    } : {}),
  };
}

export function mapToolAction(toolName, input = {}) {
  const raw = String(toolName);
  const name = raw.toLowerCase();
  const pilotName = name.split('__').at(-1)?.replaceAll('-', '_');
  const target = stringValue(input.peer ?? input.target ?? input.agent ?? input.recipient);
  if (pilotName === 'pilot_send') return { action: 'data.send.text', resource: `agent:${target || 'unknown'}/inbox` };
  if (pilotName === 'pilot_send_file') return { action: 'file.share', resource: `agent:${target || 'unknown'}/inbox` };
  if (pilotName === 'pilot_handshake') return { action: 'trust.request', resource: `agent:${target || 'unknown'}` };
  if (pilotName === 'pilot_approve') return { action: 'trust.accept', resource: `agent:${target || 'unknown'}` };
  if (pilotName === 'pilot_reject') return { action: 'trust.reject', resource: `agent:${target || 'unknown'}` };
  if (pilotName === 'pilot_untrust') return { action: 'trust.revoke', resource: `agent:${target || 'unknown'}` };
  if (pilotName === 'pilot_publish') return { action: 'event.publish', resource: `eventstream:${stringValue(input.topic) || 'unknown'}` };
  if (/^(message_sending|send_message|message_send)$/.test(name)) {
    return { action: 'data.send.text', resource: `agent:${stringValue(input.to ?? input.target) || 'unknown'}/inbox` };
  }

  if (/^(bash|shell|execute_command|exec_command|run_terminal_cmd|run_shell_command|terminal|computer|powershell)$/.test(name)) {
    const command = stringValue(input.command ?? input.cmd ?? input.code);
    return { action: 'process.execute', resource: `process:${firstCommandToken(command) || raw}` };
  }
  if (/^(read|readfile|read_file|glob|grep|search_files|list_dir|list_directory|ls|view)$/.test(name)) {
    return { action: 'file.read', resource: fileResource(input) };
  }
  if (/^(write|writefile|write_file|create|edit|editfile|edit_file|apply_patch|notebookedit|multiedit)$/.test(name)) {
    return { action: 'file.write', resource: fileResource(input) };
  }
  if (/^(webfetch|web_fetch|fetch|http_request|websearch|web_search)$/.test(name)) {
    return { action: 'http.request', resource: boundedResource(stringValue(input.url ?? input.query) || `web:${raw}`) };
  }
  if (/browser|navigate|open_url/.test(name)) {
    return { action: 'browser.navigate', resource: boundedResource(stringValue(input.url) || `browser:${raw}`) };
  }
  return { action: 'tool.invoke', resource: boundedResource(`tool:${raw}`) };
}

function fileResource(input) {
  return boundedResource(stringValue(
    input.file_path ?? input.path ?? input.target_file ?? input.notebook_path ?? input.pattern,
  ) || 'file:unknown');
}

function firstCommandToken(command) {
  const match = String(command ?? '').trim().match(/^(?:env\s+[^\s=]+=\S+\s+)*(?:sudo\s+)?["']?([^\s"']+)/);
  return boundedResource(match?.[1] ?? '');
}

function boundedResource(value) {
  const bytes = Buffer.from(String(value), 'utf8');
  return (bytes.byteLength <= 900 ? String(value) : bytes.subarray(0, 900).toString('utf8')).replaceAll('\u0000', '');
}

function compactAttributes(values) {
  const attributes = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    const text = String(value);
    const bytes = Buffer.from(text, 'utf8');
    attributes[key] = bytes.byteLength <= 256 ? text : bytes.subarray(0, 256).toString('utf8');
  }
  return attributes;
}

function postStatus(eventName, native) {
  const name = String(eventName).toLowerCase();
  if (name.includes('failure') || name.includes('error') || native.success === false || native.error || native.extra?.error) return 'failed';
  return 'succeeded';
}

function eventPhase(native) {
  const name = String(native.hook_event_name ?? native.hookEventName ?? native.event_type ?? native.eventName ?? '').toLowerCase();
  if (name.startsWith('pre') || name.startsWith('before')) return 'pre';
  if (name.startsWith('post') || name.startsWith('after')) return 'post';
  return '';
}

function formatBlockReason(response) {
  const reasons = Array.isArray(response.reasons) ? response.reasons.filter(Boolean) : [];
  if (response.outcome === 'approval_required') {
    const id = response.reference?.approval_transaction_id;
    const expiry = response.reference?.approval_expires_at;
    reasons.unshift(`Approval required${id ? ` (${id})` : ''}${expiry ? ` before ${new Date(expiry * 1000).toISOString()}` : ''}. Approve in Pilot, then retry the tool.`);
  } else if (response.outcome === 'constrain') {
    reasons.unshift('Pilot returned constraints this harness adapter cannot safely enforce.');
  } else {
    reasons.unshift('Pilot policy denied this action.');
  }
  return reasons.join(' ');
}

function blockNativeHook(harness, reason, io) {
  // Cline's executable hook protocol consumes a cancellation object. The
  // remaining command-hook harnesses either consume an explicit block object
  // below or specify exit code 2 as a blocking pre-hook.
  if (harness === 'cline') {
    io.stdout.write(`${JSON.stringify({ cancel: true, errorMessage: reason })}\n`);
    return;
  }
  // Hermes explicitly treats non-zero command-hook exits as a warning and
  // continues the agent loop. Its documented JSON decision is therefore the
  // only fail-closed response shape for pre_tool_call.
  if (harness === 'hermes') {
    io.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
    return;
  }
  if (harness === 'picoclaw') {
    io.stdout.write(`${JSON.stringify({ action: 'deny_tool', reason })}\n`);
    return;
  }
  if (harness === 'cursor') {
    io.stdout.write(`${JSON.stringify({ continue: true, permission: 'deny', user_message: reason, agent_message: reason })}\n`);
    return;
  }
  io.stderr.write(`${reason}\n`);
  io.setExitCode(2);
}

function nativeToolName(harness, native) {
  const explicit = stringValue(
    native.tool_name ?? native.toolName ?? native.tool ?? native.preToolUse?.toolName ?? native.postToolUse?.toolName,
  );
  if (explicit) return explicit;
  const event = stringValue(native.hook_event_name ?? native.hookEventName ?? native.event_type ?? native.eventName).toLowerCase();
  if (harness === 'cursor') {
    if (event.includes('shell') || native.command !== undefined) return 'shell';
    if (event.includes('readfile') || native.file_path !== undefined) return 'read_file';
    if (event.includes('fileedit')) return 'edit_file';
  }
  if (event.includes('message_sending')) return 'message_sending';
  return '';
}

function cursorSyntheticInput(native) {
  if (native.command !== undefined) return { command: native.command, cwd: native.cwd, sandbox: native.sandbox };
  if (native.file_path !== undefined) return { path: native.file_path };
  return undefined;
}

async function readNativeEvent(stream) {
  let body = '';
  for await (const chunk of stream) body += chunk.toString();
  if (!body.trim()) throw new Error('native hook event JSON is required on stdin');
  return JSON.parse(body);
}

function cleanPilotctlError(stderr, stdout) {
  const raw = String(stderr || stdout || 'pilotctl hook failed').trim();
  try {
    const parsed = JSON.parse(raw);
    return parsed.message ?? parsed.error ?? raw;
  } catch {
    return raw;
  }
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
}

function parseJSONValue(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function defaultIO() {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    setExitCode(code) { process.exitCode = code; },
  };
}
