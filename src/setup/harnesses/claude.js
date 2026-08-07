// Claude Code: prefer `claude mcp add` CLI; fall back to direct ~/.claude.json edit.
//
// Also installs a complete native tool boundary. PreToolUse runs before
// Claude's permission-mode checks (including bypassPermissions), while the
// success/failure post events attach the real result to the same Pilot trace.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { hookCommand, isPilotHookCommand, pilotMcpServer } from './runtime.js';

const HOME = homedir();
const SETTINGS = join(HOME, '.claude', 'settings.json');
const MCP_CONFIG = join(HOME, '.claude.json');

export async function configure() {
  mkdirSync(dirname(SETTINGS), { recursive: true });
  await registerMcp();
  await installHook();
}

async function registerMcp() {
  // Claude Code stores user-scope MCP servers in ~/.claude.json. Hooks remain
  // in ~/.claude/settings.json; putting mcpServers there looks plausible but
  // is not loaded by current Claude Code.
  const current = existsSync(MCP_CONFIG) ? JSON.parse(readFileSync(MCP_CONFIG, 'utf8')) : {};
  current.mcpServers = current.mcpServers ?? {};
  current.mcpServers.pilot = pilotMcpServer();
  writeFileSync(MCP_CONFIG, JSON.stringify(current, null, 2));

  // Repair the misplaced entry written by older Pilot releases without
  // touching any user-owned MCP entry or setting.
  if (existsSync(SETTINGS)) {
    const settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
    if (settings.mcpServers?.pilot) {
      delete settings.mcpServers.pilot;
      if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
      writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
    }
  }
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
  return /(?:^|\s)(?:pilot-mcp|pilotprotocol-mcp)(?:@[^\s]+)?\s+heartbeat\s+--claude(?:\s|$)/.test(command);
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
