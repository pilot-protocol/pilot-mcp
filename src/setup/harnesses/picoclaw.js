// PicoClaw: write tools.mcp.servers.pilot block into ~/.picoclaw/config.json.
//
// SECURITY NOTE: PicoClaw issue #2307 is a process-hook RCE chain via
// hooks.processes[*].command. We deliberately do NOT write to hooks.processes
// here — even though that would give per-turn injection — because the hook
// command surface is the documented RCE vector. If we ever do, the command
// MUST be a stable audited path (`pilot-mcp heartbeat --picoclaw`), never a
// user-influenced string.

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
  current.tools.mcp.servers.pilot = { command: 'npx', args: ['-y', 'pilotprotocol-mcp'] };
  writeFileSync(CONFIG, JSON.stringify(current, null, 2));
}
