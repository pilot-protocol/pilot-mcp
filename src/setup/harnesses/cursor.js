// Cursor: write ~/.cursor/mcp.json and remove the user-level hook entries
// earlier Pilot releases wrote into ~/.cursor/hooks.json.

import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pilotMcpServer, removeFlatPilotHooks } from './runtime.js';

const HOME = homedir();
const MCP_JSON = join(HOME, '.cursor', 'mcp.json');
const HOOKS_JSON = join(HOME, '.cursor', 'hooks.json');

export async function configure() {
  mkdirSync(dirname(MCP_JSON), { recursive: true });
  const current = existsSync(MCP_JSON) ? JSON.parse(readFileSync(MCP_JSON, 'utf8')) : {};
  current.mcpServers = current.mcpServers ?? {};
  current.mcpServers.pilot = pilotMcpServer();
  writeFileSync(MCP_JSON, JSON.stringify(current, null, 2));
  removeRetiredHooks();
}

// Releases <=0.3.0 installed preToolUse/postToolUse/postToolUseFailure
// commands for the hosted control plane. Remove only those; when the file
// then holds nothing but the version Pilot wrote, remove it too.
function removeRetiredHooks() {
  if (!existsSync(HOOKS_JSON)) return;
  const hooks = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
  if (!removeFlatPilotHooks(hooks.hooks, ['preToolUse', 'postToolUse', 'postToolUseFailure'], 'cursor')) return;
  const otherKeys = Object.keys(hooks).filter((key) => key !== 'version' && key !== 'hooks');
  if (Object.keys(hooks.hooks).length === 0 && otherKeys.length === 0) {
    unlinkSync(HOOKS_JSON);
    return;
  }
  writeFileSync(HOOKS_JSON, JSON.stringify(hooks, null, 2));
}
