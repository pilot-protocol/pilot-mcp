// Cline: write cline_mcp_settings.json in the current ~/.cline location and,
// when present, the legacy VS Code per-user storage. Also removes the global
// hook shims earlier Pilot releases installed.

import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { isPilotHookCommand, pilotMcpServer } from './runtime.js';

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
  removeRetiredHooks();
}

// Releases <=0.3.0 wrote PreToolUse/PostToolUse shims that exec'd the retired
// hosted-control hook. Delete a shim only when it is unmistakably Pilot's; a
// user's own hook at the same path is left untouched.
export function removeRetiredHooks(home = HOME) {
  for (const directory of [join(home, '.cline', 'hooks'), join(home, 'Documents', 'Cline', 'Hooks')]) {
    for (const event of ['PreToolUse', 'PostToolUse']) {
      for (const target of [join(directory, event), join(directory, `${event}.ps1`)]) {
        if (!existsSync(target)) continue;
        if (isPilotHookCommand(readFileSync(target, 'utf8'), 'cline')) unlinkSync(target);
      }
    }
  }
}
