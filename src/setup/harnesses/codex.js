// Codex CLI (OpenAI): write [mcp_servers.pilot] into ~/.codex/config.toml and
// install the native PreToolUse/PostToolUse boundary in ~/.codex/hooks.json.
// Codex requires users to review non-managed hook definitions in /hooks; an
// administrator can deploy the same definition as a mandatory managed hook.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { hookCommand, isPilotHookCommand, PILOT_PACKAGE_SPEC } from './runtime.js';

const HOME = homedir();
const CONFIG = join(HOME, '.codex', 'config.toml');
const HOOKS = join(HOME, '.codex', 'hooks.json');

function pilotBlock() {
  return `[mcp_servers.pilot]\ncommand = "npx"\nargs = ["-y", "${PILOT_PACKAGE_SPEC}"]\n`;
}

export async function configure() {
  if (existsSync(CONFIG)) {
    const current = readFileSync(CONFIG, 'utf8');
    writeFileSync(CONFIG, upsertPilotMcpBlock(current));
  } else {
    mkdirSync(dirname(CONFIG), { recursive: true });
    writeFileSync(CONFIG, pilotBlock());
  }
  installHooks();
}

export function upsertPilotMcpBlock(source) {
  const lines = String(source).split(/(?<=\n)/);
  const retained = [];
  let replaced = false;
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '[mcp_servers.pilot]') {
      if (!replaced) retained.push(`${retained.length && !retained.at(-1).endsWith('\n\n') ? '\n' : ''}${pilotBlock()}`);
      replaced = true;
      skipping = true;
      continue;
    }
    if (skipping && trimmed.startsWith('[')) skipping = false;
    if (!skipping) retained.push(line);
  }
  if (!replaced) {
    const separator = retained.length && !retained.join('').endsWith('\n\n') ? '\n' : '';
    retained.push(`${separator}${pilotBlock()}`);
  }
  return retained.join('');
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
