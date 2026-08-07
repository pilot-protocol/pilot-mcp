// OpenHands: write the current user-level ~/.openhands/mcp.json format.
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
import { pilotMcpServer } from './runtime.js';

const HOME = homedir();
const MCP_CONFIG = join(HOME, '.openhands', 'mcp.json');
const LEGACY_CONFIG = join(HOME, '.openhands', 'config.toml');

export async function configure(options = {}) {
  mkdirSync(dirname(MCP_CONFIG), { recursive: true });
  const mcp = existsSync(MCP_CONFIG) ? JSON.parse(readFileSync(MCP_CONFIG, 'utf8')) : {};
  mcp.mcpServers = mcp.mcpServers ?? {};
  mcp.mcpServers.pilot = pilotMcpServer();
  writeFileSync(MCP_CONFIG, JSON.stringify(mcp, null, 2));

  if (existsSync(LEGACY_CONFIG)) {
    const legacy = readFileSync(LEGACY_CONFIG, 'utf8');
    const migrated = removeLegacyPilotMcpBlock(legacy);
    if (migrated !== legacy) writeFileSync(LEGACY_CONFIG, migrated);
  }

  const workspace = options.cwd ?? process.cwd();
  const hooksPath = join(workspace, '.openhands', 'hooks.json');
  mkdirSync(dirname(hooksPath), { recursive: true });
  const current = existsSync(hooksPath) ? JSON.parse(readFileSync(hooksPath, 'utf8')) : {};
  installHook(current, 'PreToolUse', 'pre');
  installHook(current, 'PostToolUse', 'post');
  writeFileSync(hooksPath, JSON.stringify(current, null, 2));
}

export function removeLegacyPilotMcpBlock(source) {
  const lines = String(source).split(/(?<=\n)/);
  const retained = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '[mcp.stdio_servers.pilot]') {
      skipping = true;
      continue;
    }
    if (skipping && trimmed.startsWith('[')) skipping = false;
    if (!skipping) retained.push(line);
  }
  return retained.join('').replace(/\n{3,}/g, '\n\n');
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
