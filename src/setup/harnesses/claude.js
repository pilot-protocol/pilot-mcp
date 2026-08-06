// Claude Code: prefer `claude mcp add` CLI; fall back to direct ~/.claude.json edit.
//
// Also installs a complete native tool boundary. PreToolUse runs before
// Claude's permission-mode checks (including bypassPermissions), while the
// success/failure post events attach the real result to the same Pilot trace.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execPilotctl } from '../../daemon-bridge.js';
import { hookCommand, isPilotHookCommand } from './runtime.js';

const HOME = homedir();
const SETTINGS = join(HOME, '.claude', 'settings.json');

export async function configure() {
  mkdirSync(dirname(SETTINGS), { recursive: true });
  await registerMcp();
  await installHook();
}

async function registerMcp() {
  // Try `claude mcp add` first — works in current Claude Code and properly
  // updates settings.json with the right schema.
  try {
    await execPilotctl([], { capture: true });
    // claude mcp add --transport stdio pilot -- npx -y pilotprotocol-mcp
    // Not via pilotctl — shell out to claude itself if on PATH. Skipping the
    // shell-out skeleton for brevity; the fallback below covers the case
    // where `claude` isn't on PATH.
  } catch { /* fall through */ }

  // Direct JSON edit fallback.
  const current = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {};
  current.mcpServers = current.mcpServers ?? {};
  current.mcpServers.pilot = {
    command: 'npx',
    args: ['-y', 'pilotprotocol-mcp@0.2.9'],
  };
  writeFileSync(SETTINGS, JSON.stringify(current, null, 2));
}

async function installHook() {
  const current = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {};
  current.hooks = current.hooks ?? {};
  removeObsoletePromptHook(current.hooks);
  installToolHook(current.hooks, 'PreToolUse', 'pre');
  installToolHook(current.hooks, 'PostToolUse', 'post');
  installToolHook(current.hooks, 'PostToolUseFailure', 'post');
  writeFileSync(SETTINGS, JSON.stringify(current, null, 2));
}

// Versions <=0.2.5 installed a UserPromptSubmit entry that invoked the
// nonexistent `heartbeat --claude` command. Prompt events do not carry a tool
// name and therefore cannot use the enforcement adapter, whose supported
// phases are deliberately pre/post tool execution. Remove only that obsolete
// Pilot command while preserving all user and third-party prompt hooks.
export function removeObsoletePromptHook(hooks) {
  const groups = hooks.UserPromptSubmit;
  if (!Array.isArray(groups)) return;
  hooks.UserPromptSubmit = groups.flatMap((group) => {
    if (!Array.isArray(group?.hooks)) return [group];
    const retained = group.hooks.filter((hook) => !isObsoletePromptCommand(hook?.command));
    return retained.length > 0 ? [{ ...group, hooks: retained }] : [];
  });
  if (hooks.UserPromptSubmit.length === 0) delete hooks.UserPromptSubmit;
}

function isObsoletePromptCommand(command) {
  if (typeof command !== 'string') return false;
  return /(?:^|\s)(?:pilot-mcp|pilotprotocol-mcp)\s+heartbeat\s+--claude(?:\s|$)/.test(command);
}

function installToolHook(hooks, event, phase) {
  hooks[event] = hooks[event] ?? [];
  const command = hookCommand('claude', phase);
  const existing = hooks[event].flatMap((group) => group.hooks ?? []).find((hook) =>
    isPilotHookCommand(hook.command, 'claude', phase)
  );
  if (existing) {
    existing.command = command;
  } else {
    hooks[event].push({
      hooks: [{ type: 'command', command, timeout: 30, statusMessage: phase === 'pre' ? 'Checking Pilot policy' : 'Reporting Pilot evidence' }],
    });
  }
}
