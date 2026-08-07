// Junie (JetBrains): writes Junie CLI config for MCP. For the JetBrains AI
// Assistant IDE side, MCP config lives in JetBrains AI Assistant settings —
// we instruct the user via the summary output to add it manually in Settings →
// Tools → AI Assistant → MCP.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const CLI_CONFIG = join(HOME, '.junie', 'config.json');

export async function configure() {
  if (!existsSync(CLI_CONFIG)) {
    mkdirSync(dirname(CLI_CONFIG), { recursive: true });
    writeFileSync(CLI_CONFIG, JSON.stringify({ mcpServers: { pilot: { command: 'npx', args: ['-y', 'pilotprotocol-mcp@0.2.11'] } } }, null, 2));
    return;
  }
  const current = JSON.parse(readFileSync(CLI_CONFIG, 'utf8'));
  current.mcpServers = current.mcpServers ?? {};
  current.mcpServers.pilot = { command: 'npx', args: ['-y', 'pilotprotocol-mcp@0.2.11'] };
  writeFileSync(CLI_CONFIG, JSON.stringify(current, null, 2));
}
