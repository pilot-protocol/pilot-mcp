// OpenClaw: install and enable Pilot's native policy plugin. The plugin manifest
// owns its MCP server definition, while runtime hooks enforce tools and outbound
// messages before the host's side effect occurs.

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
  removeObsoleteMcpEntry();
  mkdirSync(join(HOME, '.pilot', 'integrations'), { recursive: true });
  cpSync(SOURCE_PLUGIN, INSTALLED_PLUGIN, { recursive: true, force: true });
  await execFileAsync('openclaw', ['plugins', 'install', '--link', '--force', INSTALLED_PLUGIN], {
    env: process.env, timeout: 60000, maxBuffer: 1 << 20,
  });
  await execFileAsync('openclaw', ['plugins', 'enable', 'pilot-policy'], {
    env: process.env, timeout: 60000, maxBuffer: 1 << 20,
  });
  await execFileAsync('openclaw', ['plugins', 'inspect', 'pilot-policy', '--json'], {
    env: process.env, timeout: 60000, maxBuffer: 1 << 20,
  });
}

function removeObsoleteMcpEntry() {
  if (!existsSync(CONFIG)) return;
  const current = JSON.parse(readFileSync(CONFIG, 'utf8'));
  if (isPilotMcp(current.mcpServers?.pilot)) {
    delete current.mcpServers.pilot;
    if (Object.keys(current.mcpServers).length === 0) delete current.mcpServers;
    writeFileSync(CONFIG, JSON.stringify(current, null, 2));
  }
}

function isPilotMcp(server) {
  return server?.command === 'npx'
    && Array.isArray(server.args)
    && server.args.some((arg) => String(arg).startsWith('pilotprotocol-mcp'));
}
