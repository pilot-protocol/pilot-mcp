import { definePluginEntry } from 'openclaw/plugin-sdk/core';
import { evaluate } from './evaluate.js';

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
      try {
        await evaluate('post', {
          hook_event_name: 'after_tool_call', tool_name: event.toolName, tool_input: event.params,
          tool_response: event.result, error: event.error,
          session_id: ctx.sessionId ?? ctx.sessionKey ?? event.runId, tool_use_id: event.toolCallId,
        });
      } catch (error) {
        api.logger?.warn?.(`Pilot post-hook evidence failure: ${error.message}`);
      }
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
