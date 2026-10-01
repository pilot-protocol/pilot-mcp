// OpenHands: write the current user-level ~/.openhands/mcp.json format.
//
// OpenHands discovers hooks.json from the repository, so earlier Pilot releases
// installed their hosted-control hook into the workspace setup ran in. Setup
// removes that entry from the current workspace and keeps any project hooks.

import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';
import { pilotMcpServer, removeGroupedPilotHooks } from './runtime.js';

const HOME = homedir();
const MCP_CONFIG = join(HOME, '.openhands', 'mcp.json');
const LEGACY_CONFIG = join(HOME, '.openhands', 'config.toml');

export async function configure(options = {}) {
  mkdirSync(dirname(MCP_CONFIG), { recursive: true });
  const mcp = existsSync(MCP_CONFIG) ? JSON.parse(readFileSync(MCP_CONFIG, 'utf8')) : {};
  mcp.mcpServers = mcp.mcpServers ?? {};
  mcp.mcpServers.pilot = pilotMcpServer();
  writeFileSync(MCP_CONFIG, JSON.stringify(mcp, null, 2));

  if (existsSync(LEGACY_CONFIG)) {
    const legacy = readFileSync(LEGACY_CONFIG, 'utf8');
    const migrated = removeLegacyPilotMcpBlock(legacy);
    if (migrated !== legacy) writeFileSync(LEGACY_CONFIG, migrated);
  }

  const hooksPath = join(options.cwd ?? process.cwd(), '.openhands', 'hooks.json');
  if (!existsSync(hooksPath)) return;
  const current = JSON.parse(readFileSync(hooksPath, 'utf8'));
  if (!removeGroupedPilotHooks(current, ['PreToolUse', 'PostToolUse'], 'openhands')) return;
  if (Object.keys(current).length === 0) unlinkSync(hooksPath);
  else writeFileSync(hooksPath, JSON.stringify(current, null, 2));
}

export function removeLegacyPilotMcpBlock(source) {
  const lines = String(source).split(/(?<=\n)/);
  const retained = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '[mcp.stdio_servers.pilot]') {
      skipping = true;
      continue;
    }
    if (skipping && trimmed.startsWith('[')) skipping = false;
    if (!skipping) retained.push(line);
  }
  return retained.join('').replace(/\n{3,}/g, '\n\n');
}
