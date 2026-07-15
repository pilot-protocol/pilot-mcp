// OpenClaw: defer to the @openclaw/pilot extension if installed; otherwise
// write a minimal MCP server registration into the user's OpenClaw config.
//
// Best path: the openclaw/extensions/pilot channel plugin already exists in
// the OpenClaw monorepo (TypeScript, registers before_prompt_build hook +
// channel plugin + 5 tools). That gives per-turn injection plus native channel
// integration that MCP alone cannot match.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const CONFIG = join(HOME, '.openclaw', 'openclaw.json');

export async function configure() {
  if (!existsSync(CONFIG)) return; // OpenClaw not configured yet — caller already skipped
  const current = JSON.parse(readFileSync(CONFIG, 'utf8'));
  current.mcpServers = current.mcpServers ?? {};
  current.mcpServers.pilot = { command: 'npx', args: ['-y', 'pilotprotocol-mcp'] };
  writeFileSync(CONFIG, JSON.stringify(current, null, 2));
  // TODO: also recommend (and offer to install) @openclaw/pilot extension for
  // per-turn before_prompt_build injection — that's the cache-friendly path.
}
