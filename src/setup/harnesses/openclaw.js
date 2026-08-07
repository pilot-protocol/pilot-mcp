// OpenClaw: defer to the @openclaw/pilot extension if installed; otherwise
// write a minimal MCP server registration into the user's OpenClaw config.
//
// Best path: the openclaw/extensions/pilot channel plugin already exists in
// the OpenClaw monorepo (TypeScript, registers before_prompt_build hook +
// channel plugin + 5 tools). That gives per-turn injection plus native channel
// integration that MCP alone cannot match.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

const HOME = homedir();
const CONFIG = join(HOME, '.openclaw', 'openclaw.json');
const SOURCE_PLUGIN = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'openclaw-plugin');
const INSTALLED_PLUGIN = join(HOME, '.pilot', 'integrations', 'openclaw-policy');
const execFileAsync = promisify(execFile);

export async function configure() {
  if (!existsSync(CONFIG)) return; // OpenClaw not configured yet — caller already skipped
  const current = JSON.parse(readFileSync(CONFIG, 'utf8'));
  current.mcpServers = current.mcpServers ?? {};
  current.mcpServers.pilot = { command: 'npx', args: ['-y', 'pilotprotocol-mcp@0.2.11'] };
  writeFileSync(CONFIG, JSON.stringify(current, null, 2));
  mkdirSync(join(HOME, '.pilot', 'integrations'), { recursive: true });
  cpSync(SOURCE_PLUGIN, INSTALLED_PLUGIN, { recursive: true, force: true });
  await execFileAsync('openclaw', ['plugins', 'install', '--link', INSTALLED_PLUGIN], {
    env: process.env, timeout: 60000, maxBuffer: 1 << 20,
  });
}
