// Cline: write cline_mcp_settings.json in VS Code per-user storage.
// Also drops .clinerules/pilot.md since Cline #5033 (AGENTS.md support) is
// still closed unmerged.

import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { hookCommand, isPilotHookCommand } from './runtime.js';

const HOME = homedir();

function settingsPath() {
  switch (platform()) {
    case 'darwin': return join(HOME, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
    case 'linux':  return join(HOME, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
    case 'win32':  return join(HOME, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
    default:       return join(HOME, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
  }
}

export async function configure() {
  const settings = settingsPath();
  mkdirSync(dirname(settings), { recursive: true });
  const current = existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {};
  current.mcpServers = current.mcpServers ?? {};
  current.mcpServers.pilot = { command: 'npx', args: ['-y', 'pilotprotocol-mcp@0.2.9'] };
  writeFileSync(settings, JSON.stringify(current, null, 2));
  installNativeHook('PreToolUse', 'pre');
  installNativeHook('PostToolUse', 'post');
}

function installNativeHook(event, phase) {
  const directory = join(HOME, 'Documents', 'Cline', 'Hooks');
  const target = join(directory, event);
  const marker = hookCommand('cline', phase);
  if (existsSync(target)) {
    const existing = readFileSync(target, 'utf8');
    if (isPilotHookCommand(existing, 'cline', phase)) {
      if (!existing.includes(marker)) writeFileSync(target, `#!/bin/sh\nexec ${marker}\n`, { mode: 0o700 });
      chmodSync(target, 0o700);
      return;
    }
    throw new Error(`Cline already has a global ${event} hook at ${target}; install Pilot as a workspace hook or compose the scripts explicitly`);
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(target, `#!/bin/sh\nexec ${marker}\n`, { mode: 0o700 });
  chmodSync(target, 0o700);
}
