import { definePluginEntry } from 'openclaw/plugin-sdk/core';

// The plugin manifest carries Pilot's MCP server definition, which is how
// OpenClaw loads it. Earlier releases also registered before/after tool and
// outbound-message hooks for the hosted control plane; that control plane has
// been retired, so nothing is registered here. The plugin id is unchanged so
// an existing linked install is upgraded in place by `pilot-mcp setup`.
export default definePluginEntry({
  id: 'pilot-policy',
  name: 'Pilot',
  description: 'Pilot Protocol MCP server for OpenClaw.',
  register() {},
});
