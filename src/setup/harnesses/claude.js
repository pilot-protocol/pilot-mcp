// Claude Code: register the Pilot MCP server in ~/.claude.json and clean up
// the hook entries earlier Pilot releases wrote into ~/.claude/settings.json.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pilotMcpServer, removeGroupedPilotHooks } from './runtime.js';

const HOME = homedir();
const SETTINGS = join(HOME, '.claude', 'settings.json');
const MCP_CONFIG = join(HOME, '.claude.json');

export async function configure() {
  await registerMcp();
  removeRetiredHooks();
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

// Releases <=0.3.0 installed PreToolUse/PostToolUse/PostToolUseFailure
// commands for the hosted control plane, and releases <=0.2.5 a
// UserPromptSubmit heartbeat. Both are retired; remove only those Pilot
// commands while preserving all user and third-party hooks.
function removeRetiredHooks() {
  if (!existsSync(SETTINGS)) return;
  const current = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  if (!current.hooks || typeof current.hooks !== 'object') return;
  const before = JSON.stringify(current.hooks);
  removeObsoletePromptHook(current.hooks);
  removeGroupedPilotHooks(current.hooks, ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'], 'claude');
  if (JSON.stringify(current.hooks) === before) return;
  if (Object.keys(current.hooks).length === 0) delete current.hooks;
  writeFileSync(SETTINGS, JSON.stringify(current, null, 2));
}

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
