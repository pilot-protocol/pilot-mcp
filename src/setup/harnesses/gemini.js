// Gemini CLI: user-level MCP. Also removes the BeforeTool/AfterTool hook
// entries earlier Pilot releases wrote.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pilotMcpServer, removeGroupedPilotHooks } from './runtime.js';

const SETTINGS = join(homedir(), '.gemini', 'settings.json');

export async function configure() {
  mkdirSync(dirname(SETTINGS), { recursive: true });
  const current = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {};
  current.mcpServers = current.mcpServers ?? {};
  current.mcpServers.pilot = pilotMcpServer();
  // Releases <=0.3.0 installed hosted-control hooks here. hooksConfig is left
  // as found: it also governs the user's own hooks.
  removeGroupedPilotHooks(current.hooks, ['BeforeTool', 'AfterTool'], 'gemini');
  writeFileSync(SETTINGS, JSON.stringify(current, null, 2));
}
