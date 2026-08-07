// GitHub Copilot: configure the VS Code MCP server and Copilot CLI's user-level
// pre/post hooks. Cloud agent jobs require committing the same hook file under
// .github/hooks/ because they do not load a user's home directory.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { hookCommand, isPilotHookCommand, pilotMcpServer } from './runtime.js';

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
  installHooks();
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

function installHooks() {
  const hooksDirectory = join(HOME, '.copilot', 'hooks');
  const path = join(hooksDirectory, 'pilot.json');
  mkdirSync(hooksDirectory, { recursive: true });
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, hooks: {} };
  current.version = 1;
  current.hooks = current.hooks ?? {};
  installHook(current.hooks, 'preToolUse', 'pre');
  installHook(current.hooks, 'postToolUse', 'post');
  installHook(current.hooks, 'postToolUseFailure', 'post');
  writeFileSync(path, JSON.stringify(current, null, 2));
}

function installHook(hooks, event, phase) {
  hooks[event] = hooks[event] ?? [];
  const command = hookCommand('copilot', phase);
  const existing = hooks[event].find((hook) =>
    isPilotHookCommand(hook.command ?? hook.bash ?? hook.powershell, 'copilot', phase)
  );
  if (existing) {
    delete existing.command;
    Object.assign(existing, { type: 'command', bash: command, powershell: command, timeoutSec: 30 });
  } else {
    hooks[event].push({ type: 'command', bash: command, powershell: command, timeoutSec: 30 });
  }
}
