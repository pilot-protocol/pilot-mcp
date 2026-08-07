// PicoClaw: MCP plus its current JSON-RPC process-hook ABI. The process command
// is a fixed argv array written by Pilot (never user-influenced shell text).
// PicoClaw remains pre-1.0, so onboarding reports this as native but
// experimental until a pinned upstream version passes the denial proof.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PILOT_PACKAGE_SPEC, pilotMcpServer } from './runtime.js';

export async function configure(options = {}) {
  const config = join(options.home ?? homedir(), '.picoclaw', 'config.json');
  if (!existsSync(config)) {
    if (options.allowMissingHost === true) {
      return { skipped: true, reason: 'PicoClaw configuration was not found' };
    }
    throw new Error(`PicoClaw configuration was not found at ${config}`);
  }
  const current = JSON.parse(readFileSync(config, 'utf8'));
  current.tools = current.tools ?? {};
  current.tools.mcp = current.tools.mcp ?? {};
  current.tools.mcp.enabled = true;
  current.tools.mcp.servers = current.tools.mcp.servers ?? {};
  current.tools.mcp.servers.pilot = pilotMcpServer({ enabled: true });
  current.hooks = current.hooks ?? {};
  current.hooks.enabled = true;
  current.hooks.defaults = current.hooks.defaults ?? {};
  current.hooks.defaults.interceptor_timeout_ms = current.hooks.defaults.interceptor_timeout_ms ?? 30000;
  current.hooks.processes = current.hooks.processes ?? {};
  current.hooks.processes.pilot = {
    enabled: true,
    priority: 10,
    transport: 'stdio',
    command: ['npx', '-y', PILOT_PACKAGE_SPEC, 'picoclaw-hook'],
    intercept: ['before_tool', 'after_tool'],
  };
  writeFileSync(config, JSON.stringify(current, null, 2));
  return { skipped: false };
}
