// GitHub Copilot CLI: configure the user-level MCP server and remove the hook
// file earlier Pilot releases wrote under ~/.copilot/hooks.

import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { pilotMcpServer, removeFlatPilotHooks } from './runtime.js';

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
  const config = join(HOME, '.copilot', 'mcp-config.json');
  mkdirSync(dirname(config), { recursive: true });
  const current = existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')) : {};
  current.mcpServers = current.mcpServers ?? {};
  current.mcpServers.pilot = pilotMcpServer();
  writeFileSync(config, JSON.stringify(current, null, 2));
  removeObsoleteVSCodeEntry();
  removeRetiredHooks();
}

function removeObsoleteVSCodeEntry() {
  const settings = vsCodeSettingsPath();
  if (!existsSync(settings)) return;
  let current;
  try {
    current = JSON.parse(readFileSync(settings, 'utf8'));
  } catch {
    // VS Code settings may be JSONC. Leaving an inert legacy entry is safer
    // than rewriting a commented user file with a lossy parser.
    return;
  }
  const key = 'github.copilot.chat.mcp.servers';
  if (!current[key]?.pilot) return;
  delete current[key].pilot;
  if (Object.keys(current[key]).length === 0) delete current[key];
  writeFileSync(settings, JSON.stringify(current, null, 2));
}

// Releases <=0.3.0 wrote ~/.copilot/hooks/pilot.json for the hosted control
// plane. Remove Pilot's entries; the file is Pilot's own, so drop it once it
// holds no other hook.
function removeRetiredHooks() {
  const path = join(HOME, '.copilot', 'hooks', 'pilot.json');
  if (!existsSync(path)) return;
  const current = JSON.parse(readFileSync(path, 'utf8'));
  if (!removeFlatPilotHooks(current.hooks, ['preToolUse', 'postToolUse', 'postToolUseFailure'], 'copilot')) return;
  if (Object.keys(current.hooks).length === 0) {
    unlinkSync(path);
    return;
  }
  writeFileSync(path, JSON.stringify(current, null, 2));
}
