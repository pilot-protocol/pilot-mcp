// PicoClaw: MCP plus its current JSON-RPC process-hook ABI. The process command
// is a fixed argv array written by Pilot (never user-influenced shell text).
// PicoClaw remains pre-1.0, so onboarding reports this as native but
// experimental until a pinned upstream version passes the denial proof.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const CONFIG = join(HOME, '.picoclaw', 'config.json');

export async function configure() {
  if (!existsSync(CONFIG)) return;
  const current = JSON.parse(readFileSync(CONFIG, 'utf8'));
  current.tools = current.tools ?? {};
  current.tools.mcp = current.tools.mcp ?? {};
  current.tools.mcp.servers = current.tools.mcp.servers ?? {};
  current.tools.mcp.servers.pilot = { command: 'npx', args: ['-y', 'pilotprotocol-mcp@0.2.8'] };
  current.hooks = current.hooks ?? {};
  current.hooks.enabled = true;
  current.hooks.defaults = current.hooks.defaults ?? {};
  current.hooks.defaults.interceptor_timeout_ms = current.hooks.defaults.interceptor_timeout_ms ?? 30000;
  current.hooks.processes = current.hooks.processes ?? {};
  current.hooks.processes.pilot = {
    enabled: true,
    priority: 10,
    transport: 'stdio',
    command: ['npx', '-y', 'pilotprotocol-mcp@0.2.8', 'picoclaw-hook'],
    intercept: ['before_tool', 'after_tool'],
  };
  writeFileSync(CONFIG, JSON.stringify(current, null, 2));
}
