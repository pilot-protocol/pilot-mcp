// GitHub Copilot (VS Code): MCP is configured via VS Code's settings.json under
// "github.copilot.chat.mcp.servers". For non-enterprise, just write it there.
// Enterprise orgs gate MCP servers via admin policy — we cannot bypass that;
// the summary output tells the user.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';

const HOME = homedir();

function vsCodeSettingsPath() {
  switch (platform()) {
    case 'darwin': return join(HOME, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
    case 'linux':  return join(HOME, '.config', 'Code', 'User', 'settings.json');
    case 'win32':  return join(HOME, 'AppData', 'Roaming', 'Code', 'User', 'settings.json');
    default:       return join(HOME, '.config', 'Code', 'User', 'settings.json');
  }
}

export async function configure() {
  const settings = vsCodeSettingsPath();
  mkdirSync(dirname(settings), { recursive: true });
  const current = existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {};
  current['github.copilot.chat.mcp.servers'] = current['github.copilot.chat.mcp.servers'] ?? {};
  current['github.copilot.chat.mcp.servers'].pilot = { command: 'npx', args: ['-y', 'pilotprotocol-mcp'] };
  writeFileSync(settings, JSON.stringify(current, null, 2));
}
