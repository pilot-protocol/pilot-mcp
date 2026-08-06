// Codex CLI (OpenAI): write [mcp_servers.pilot] into ~/.codex/config.toml and
// install the native PreToolUse/PostToolUse boundary in ~/.codex/hooks.json.
// Codex requires users to review non-managed hook definitions in /hooks; an
// administrator can deploy the same definition as a mandatory managed hook.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { hookCommand, isPilotHookCommand } from './runtime.js';

const HOME = homedir();
const CONFIG = join(HOME, '.codex', 'config.toml');
const HOOKS = join(HOME, '.codex', 'hooks.json');

const BLOCK = `
[mcp_servers.pilot]
command = "npx"
args = ["-y", "pilotprotocol-mcp@0.2.8"]
`;

export async function configure() {
  if (existsSync(CONFIG)) {
    const current = readFileSync(CONFIG, 'utf8');
    if (!current.includes('[mcp_servers.pilot]')) writeFileSync(CONFIG, current + BLOCK);
  } else {
    mkdirSync(dirname(CONFIG), { recursive: true });
    writeFileSync(CONFIG, BLOCK.trimStart());
  }
  installHooks();
}

function installHooks() {
  const current = existsSync(HOOKS) ? JSON.parse(readFileSync(HOOKS, 'utf8')) : {};
  current.description = current.description ?? 'Optional local Codex hooks, including Pilot policy enforcement.';
  current.hooks = current.hooks ?? {};
  installHook(current.hooks, 'PreToolUse', 'pre');
  installHook(current.hooks, 'PostToolUse', 'post');
  writeFileSync(HOOKS, JSON.stringify(current, null, 2));
}

function installHook(hooks, event, phase) {
  hooks[event] = hooks[event] ?? [];
  const command = hookCommand('codex', phase);
  const existing = hooks[event].flatMap((group) => group.hooks ?? []).find((hook) =>
    isPilotHookCommand(hook.command, 'codex', phase)
  );
  if (existing) {
    existing.command = command;
  } else {
    hooks[event].push({
      hooks: [{ type: 'command', command, timeout: 30, statusMessage: phase === 'pre' ? 'Checking Pilot policy' : 'Reporting Pilot evidence' }],
    });
  }
}
