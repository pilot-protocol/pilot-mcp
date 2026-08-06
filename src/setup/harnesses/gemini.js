// Gemini CLI: user-level MCP plus native BeforeTool/AfterTool hooks.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { hookCommand, isPilotHookCommand } from './runtime.js';

const SETTINGS = join(homedir(), '.gemini', 'settings.json');

export async function configure() {
  mkdirSync(dirname(SETTINGS), { recursive: true });
  const current = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {};
  current.mcpServers = current.mcpServers ?? {};
  current.mcpServers.pilot = { command: 'npx', args: ['-y', 'pilotprotocol-mcp@0.2.10'] };
  current.hooksConfig = current.hooksConfig ?? {};
  if (current.hooksConfig.enabled === undefined) current.hooksConfig.enabled = true;
  current.hooks = current.hooks ?? {};
  installHook(current.hooks, 'BeforeTool', 'pre');
  installHook(current.hooks, 'AfterTool', 'post');
  writeFileSync(SETTINGS, JSON.stringify(current, null, 2));
}

function installHook(hooks, event, phase) {
  hooks[event] = hooks[event] ?? [];
  const command = hookCommand('gemini', phase);
  const existing = hooks[event].flatMap((group) => group.hooks ?? []).find((hook) =>
    isPilotHookCommand(hook.command, 'gemini', phase)
  );
  if (existing) {
    existing.command = command;
  } else {
    hooks[event].push({
      matcher: '.*',
      sequential: true,
      hooks: [{ type: 'command', name: `pilot-${phase}-tool`, command, timeout: 30000 }],
    });
  }
}
