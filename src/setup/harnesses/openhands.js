// OpenHands: write [mcp.stdio_servers.pilot] into ~/.openhands/config.toml.
//
// OpenHands accepts Claude Code's hooks.json schema, but discovers it from the
// repository rather than the user's home directory. `pilot-mcp setup` therefore
// installs the hook into the current workspace and preserves any existing
// project hooks. This is project control, not a misleading fleet-wide claim.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';
import { hookCommand, isPilotHookCommand } from './runtime.js';

const HOME = homedir();
const CONFIG = join(HOME, '.openhands', 'config.toml');

const MCP_BLOCK = `
[mcp.stdio_servers.pilot]
command = "npx"
args = ["-y", "pilotprotocol-mcp@0.2.8"]
`;

export async function configure(options = {}) {
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

  const workspace = options.cwd ?? process.cwd();
  const hooksPath = join(workspace, '.openhands', 'hooks.json');
  mkdirSync(dirname(hooksPath), { recursive: true });
  const current = existsSync(hooksPath) ? JSON.parse(readFileSync(hooksPath, 'utf8')) : {};
  installHook(current, 'PreToolUse', 'pre');
  installHook(current, 'PostToolUse', 'post');
  writeFileSync(hooksPath, JSON.stringify(current, null, 2));
}

function installHook(hooks, event, phase) {
  hooks[event] = hooks[event] ?? [];
  const command = hookCommand('openhands', phase);
  const existing = hooks[event].flatMap((group) => group.hooks ?? []).find((hook) =>
    isPilotHookCommand(hook.command, 'openhands', phase)
  );
  if (existing) {
    existing.command = command;
  } else {
    hooks[event].push({
      matcher: '*',
      hooks: [{ type: 'command', command, timeout: 30 }],
    });
  }
}
