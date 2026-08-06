import { spawn } from 'node:child_process';
import { definePluginEntry } from 'openclaw/plugin-sdk/core';

async function evaluate(phase, event) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['-y', 'pilotprotocol-mcp', 'hook', '--harness', 'openclaw', '--phase', phase], {
      stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (phase === 'pre' && code === 2) return resolve({ blocked: true, reason: stderr.trim() || 'Pilot denied this action.' });
      if (code !== 0) return reject(new Error(stderr.trim() || `Pilot hook exited ${code}`));
      resolve({ blocked: false });
    });
    child.stdin.end(JSON.stringify(event));
  });
}

export default definePluginEntry({
  id: 'pilot-policy',
  name: 'Pilot Policy',
  description: 'Hosted Pilot control for OpenClaw tools and outbound messages.',
  register(api) {
    api.on('before_tool_call', async (event, ctx) => {
      const decision = await evaluate('pre', {
        hook_event_name: 'before_tool_call', tool_name: event.toolName, tool_input: event.params,
        session_id: ctx.sessionId ?? ctx.sessionKey ?? event.runId, tool_use_id: event.toolCallId,
      });
      return decision.blocked ? { block: true, blockReason: decision.reason } : undefined;
    }, { priority: 100, timeoutMs: 30000 });
    api.on('after_tool_call', async (event, ctx) => {
      await evaluate('post', {
        hook_event_name: 'after_tool_call', tool_name: event.toolName, tool_input: event.params,
        tool_response: event.result, error: event.error,
        session_id: ctx.sessionId ?? ctx.sessionKey ?? event.runId, tool_use_id: event.toolCallId,
      });
    }, { priority: 100, timeoutMs: 30000 });
    api.on('message_sending', async (event, ctx) => {
      const decision = await evaluate('pre', {
        hook_event_name: 'message_sending', tool_name: 'message_sending',
        tool_input: { to: event.to, content: event.content, thread_id: event.threadId, metadata: event.metadata },
        session_id: ctx.sessionKey ?? ctx.runId, tool_use_id: ctx.messageId,
      });
      return decision.blocked ? { cancel: true, cancelReason: decision.reason } : undefined;
    }, { priority: 100, timeoutMs: 30000 });
  },
});
