// Cursor: write ~/.cursor/mcp.json and the current user-level native hook
// contract. Cursor's generic PreToolUse boundary covers Agent/Cmd+K tools;
// failClosed prevents a crashed, timed-out, or malformed Pilot hook from
// becoming permission to execute. Repository/cloud agents need the same file
// committed as .cursor/hooks.json because they cannot read the user's home.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { hookCommand, isPilotHookCommand } from './runtime.js';

const HOME = homedir();
const MCP_JSON = join(HOME, '.cursor', 'mcp.json');
const HOOKS_JSON = join(HOME, '.cursor', 'hooks.json');

export async function configure() {
  mkdirSync(dirname(MCP_JSON), { recursive: true });
  const current = existsSync(MCP_JSON) ? JSON.parse(readFileSync(MCP_JSON, 'utf8')) : {};
  current.mcpServers = current.mcpServers ?? {};
  current.mcpServers.pilot = { command: 'npx', args: ['-y', 'pilotprotocol-mcp@0.2.8'] };
  writeFileSync(MCP_JSON, JSON.stringify(current, null, 2));

  const hooks = existsSync(HOOKS_JSON) ? JSON.parse(readFileSync(HOOKS_JSON, 'utf8')) : { version: 1, hooks: {} };
  hooks.version = 1;
  hooks.hooks = hooks.hooks ?? {};
  installHook(hooks.hooks, 'preToolUse', 'pre', true);
  installHook(hooks.hooks, 'postToolUse', 'post', false);
  installHook(hooks.hooks, 'postToolUseFailure', 'post', false);
  writeFileSync(HOOKS_JSON, JSON.stringify(hooks, null, 2));
}

function installHook(hooks, event, phase, failClosed) {
  hooks[event] = hooks[event] ?? [];
  const command = hookCommand('cursor', phase);
  const existing = hooks[event].find((hook) => isPilotHookCommand(hook.command, 'cursor', phase));
  if (existing) {
    existing.command = command;
    if (failClosed) existing.failClosed = true;
  } else {
    hooks[event].push({ command, timeout: 30, ...(failClosed ? { failClosed: true } : {}) });
  }
}
