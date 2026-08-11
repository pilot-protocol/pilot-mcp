// OpenClaw: install and enable Pilot's native policy plugin. The plugin manifest
// owns its MCP server definition, while runtime hooks enforce tools and outbound
// messages before the host's side effect occurs.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

const SOURCE_PLUGIN = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'openclaw-plugin');
const execFileAsync = promisify(execFile);

export async function configure(options = {}) {
  const home = options.home ?? homedir();
  const config = join(home, '.openclaw', 'openclaw.json');
  const installedPlugin = join(home, '.pilot', 'integrations', 'openclaw-policy');
  const execute = options.execFileAsync ?? execFileAsync;
  removeObsoleteMcpEntry(config);
  mkdirSync(join(home, '.pilot', 'integrations'), { recursive: true });
  cpSync(SOURCE_PLUGIN, installedPlugin, { recursive: true, force: true });
  try {
    // No --force: OpenClaw rejects it alongside --link, and a linked install already
    // points at installedPlugin, which the cpSync above just refreshed.
    await execute('openclaw', ['plugins', 'install', '--link', installedPlugin], {
      env: process.env, timeout: 60000, maxBuffer: 1 << 20,
    });
    await execute('openclaw', ['plugins', 'enable', 'pilot-policy'], {
      env: process.env, timeout: 60000, maxBuffer: 1 << 20,
    });
    await execute('openclaw', ['plugins', 'inspect', 'pilot-policy', '--json'], {
      env: process.env, timeout: 60000, maxBuffer: 1 << 20,
    });
  } catch (error) {
    if (options.allowMissingHost === true && error?.code === 'ENOENT') {
      return { skipped: true, reason: 'OpenClaw CLI is not installed' };
    }
    throw error;
  }
  return { skipped: false };
}

function removeObsoleteMcpEntry(config) {
  if (!existsSync(config)) return;
  const current = JSON.parse(readFileSync(config, 'utf8'));
  if (isPilotMcp(current.mcpServers?.pilot)) {
    delete current.mcpServers.pilot;
    if (Object.keys(current.mcpServers).length === 0) delete current.mcpServers;
    writeFileSync(config, JSON.stringify(current, null, 2));
  }
}

function isPilotMcp(server) {
  return server?.command === 'npx'
    && Array.isArray(server.args)
    && server.args.some((arg) => String(arg).startsWith('pilotprotocol-mcp'));
}
