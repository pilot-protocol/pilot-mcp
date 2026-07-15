// Codex CLI (OpenAI): write [mcp_servers.pilot] into ~/.codex/config.toml.
// Codex has no per-turn hook surface — only AGENTS.md, which is session-start.
// We rely on MCP tool surface + AGENTS.md (handled by skillinject) for Codex.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const CONFIG = join(HOME, '.codex', 'config.toml');

const BLOCK = `
[mcp_servers.pilot]
command = "npx"
args = ["-y", "pilotprotocol-mcp"]
`;

export async function configure() {
  if (existsSync(CONFIG)) {
    const current = readFileSync(CONFIG, 'utf8');
    if (current.includes('[mcp_servers.pilot]')) return;
    writeFileSync(CONFIG, current + BLOCK);
  } else {
    mkdirSync(dirname(CONFIG), { recursive: true });
    writeFileSync(CONFIG, BLOCK.trimStart());
  }
}
