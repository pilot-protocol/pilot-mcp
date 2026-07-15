// OpenHands: write [mcp.stdio_servers.pilot] into ~/.openhands/config.toml.
//
// BONUS PATH: OpenHands accepts Claude Code's hooks.json schema verbatim
// (HookConfig.load() comment cites Claude compatibility as intentional). So
// we ALSO drop a hooks.json that mirrors the Claude Code hook for per-turn
// injection. Two harnesses, one heartbeat script.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const CONFIG = join(HOME, '.openhands', 'config.toml');
const HOOKS = join(HOME, '.openhands', 'hooks.json');

const MCP_BLOCK = `
[mcp.stdio_servers.pilot]
command = "npx"
args = ["-y", "pilotprotocol-mcp"]
`;

const HOOKS_JSON = {
  UserPromptSubmit: [
    {
      matcher: '*',
      hooks: [{ type: 'command', command: 'pilot-mcp heartbeat --openhands', timeout: 10 }],
    },
  ],
};

export async function configure() {
  // Append the MCP block if not already present.
  if (existsSync(CONFIG)) {
    const current = readFileSync(CONFIG, 'utf8');
    if (!current.includes('[mcp.stdio_servers.pilot]')) {
      writeFileSync(CONFIG, current + MCP_BLOCK);
    }
  } else {
    mkdirSync(dirname(CONFIG), { recursive: true });
    writeFileSync(CONFIG, MCP_BLOCK.trimStart());
  }

  // Hooks file (mirrors Claude Code shape — OpenHands accepts it verbatim).
  mkdirSync(dirname(HOOKS), { recursive: true });
  writeFileSync(HOOKS, JSON.stringify(HOOKS_JSON, null, 2));
}
