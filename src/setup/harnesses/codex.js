// Codex CLI (OpenAI): write [mcp_servers.pilot] into ~/.codex/config.toml and
// remove the hook entries earlier Pilot releases wrote into ~/.codex/hooks.json.

import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { PILOT_PACKAGE_SPEC, removeGroupedPilotHooks } from './runtime.js';

const HOME = homedir();
const CONFIG = join(HOME, '.codex', 'config.toml');
const HOOKS = join(HOME, '.codex', 'hooks.json');
const RETIRED_HOOKS_DESCRIPTION = 'Optional local Codex hooks, including Pilot policy enforcement.';

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
  removeRetiredHooks();
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

// Releases <=0.3.0 installed PreToolUse/PostToolUse commands for the hosted
// control plane. Remove only those; when nothing else is left in a file
// Pilot created, remove the file too.
function removeRetiredHooks() {
  if (!existsSync(HOOKS)) return;
  const current = JSON.parse(readFileSync(HOOKS, 'utf8'));
  if (!removeGroupedPilotHooks(current.hooks, ['PreToolUse', 'PostToolUse'], 'codex')) return;
  if (current.description === RETIRED_HOOKS_DESCRIPTION) delete current.description;
  if (Object.keys(current.hooks).length === 0 && Object.keys(current).length === 1) {
    unlinkSync(HOOKS);
    return;
  }
  writeFileSync(HOOKS, JSON.stringify(current, null, 2));
}
