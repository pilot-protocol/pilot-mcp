// Cline: write cline_mcp_settings.json in VS Code per-user storage.
// Also drops .clinerules/pilot.md since Cline #5033 (AGENTS.md support) is
// still closed unmerged.

import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { hookCommand, isPilotHookCommand, pilotMcpServer } from './runtime.js';

const HOME = homedir();

function legacySettingsPath() {
  switch (platform()) {
    case 'darwin': return join(HOME, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
    case 'linux':  return join(HOME, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
    case 'win32':  return join(HOME, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
    default:       return join(HOME, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
  }
}

export async function configure() {
  const canonical = join(HOME, '.cline', 'data', 'settings', 'cline_mcp_settings.json');
  const paths = [canonical, ...(existsSync(legacySettingsPath()) ? [legacySettingsPath()] : [])];
  for (const settings of new Set(paths)) {
    mkdirSync(dirname(settings), { recursive: true });
    const current = existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {};
    current.mcpServers = current.mcpServers ?? {};
    current.mcpServers.pilot = pilotMcpServer();
    writeFileSync(settings, JSON.stringify(current, null, 2));
  }
  installNativeHook('PreToolUse', 'pre', platform());
  installNativeHook('PostToolUse', 'post', platform());
}

export function installNativeHook(event, phase, os = platform()) {
  const directory = join(HOME, '.cline', 'hooks');
  const target = join(directory, os === 'win32' ? `${event}.ps1` : event);
  const marker = hookCommand('cline', phase);
  const content = os === 'win32'
    ? `& ${marker}\nexit $LASTEXITCODE\n`
    : `#!/bin/sh\nexec ${marker}\n`;
  if (existsSync(target)) {
    const existing = readFileSync(target, 'utf8');
    if (isPilotHookCommand(existing, 'cline', phase)) {
      if (!existing.includes(marker)) writeFileSync(target, content, { mode: 0o700 });
      if (os !== 'win32') chmodSync(target, 0o700);
      removeOwnedCompatibilityHook(event, phase, os);
      return;
    }
    throw new Error(`Cline already has a global ${event} hook at ${target}; install Pilot as a workspace hook or compose the scripts explicitly`);
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(target, content, { mode: 0o700 });
  if (os !== 'win32') chmodSync(target, 0o700);
  removeOwnedCompatibilityHook(event, phase, os);
}

function removeOwnedCompatibilityHook(event, phase, os) {
  const legacy = join(HOME, 'Documents', 'Cline', 'Hooks', os === 'win32' ? `${event}.ps1` : event);
  if (!existsSync(legacy)) return;
  const source = readFileSync(legacy, 'utf8');
  if (isPilotHookCommand(source, 'cline', phase)) unlinkSync(legacy);
}
