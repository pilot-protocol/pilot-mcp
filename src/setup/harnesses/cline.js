// Cline: write cline_mcp_settings.json in VS Code per-user storage.
// Also drops .clinerules/pilot.md since Cline #5033 (AGENTS.md support) is
// still closed unmerged.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';

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
  current.mcpServers.pilot = { command: 'npx', args: ['-y', 'pilotprotocol-mcp'] };
  writeFileSync(settings, JSON.stringify(current, null, 2));
}
