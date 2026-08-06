// GitHub Copilot: configure the VS Code MCP server and Copilot CLI's user-level
// pre/post hooks. Cloud agent jobs require committing the same hook file under
// .github/hooks/ because they do not load a user's home directory.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { hookCommand, isPilotHookCommand } from './runtime.js';

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
  current['github.copilot.chat.mcp.servers'].pilot = { command: 'npx', args: ['-y', 'pilotprotocol-mcp@0.2.10'] };
  writeFileSync(settings, JSON.stringify(current, null, 2));
  installHooks();
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
