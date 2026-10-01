// PicoClaw: register the Pilot MCP server and remove the process hook earlier
// Pilot releases registered for the hosted control plane.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pilotMcpServer } from './runtime.js';

export async function configure(options = {}) {
  const config = join(options.home ?? homedir(), '.picoclaw', 'config.json');
  if (!existsSync(config)) {
    if (options.allowMissingHost === true) {
      return { skipped: true, reason: 'PicoClaw configuration was not found' };
    }
    throw new Error(`PicoClaw configuration was not found at ${config}`);
  }
  const current = JSON.parse(readFileSync(config, 'utf8'));
  current.tools = current.tools ?? {};
  current.tools.mcp = current.tools.mcp ?? {};
  current.tools.mcp.enabled = true;
  current.tools.mcp.servers = current.tools.mcp.servers ?? {};
  current.tools.mcp.servers.pilot = pilotMcpServer({ enabled: true });
  // hooks.enabled and hooks.defaults are left as found: they also govern the
  // user's own process hooks.
  if (isPilotProcessHook(current.hooks?.processes?.pilot)) {
    delete current.hooks.processes.pilot;
    if (Object.keys(current.hooks.processes).length === 0) delete current.hooks.processes;
  }
  writeFileSync(config, JSON.stringify(current, null, 2));
  return { skipped: false };
}

function isPilotProcessHook(entry) {
  return Array.isArray(entry?.command)
    && entry.command.includes('picoclaw-hook')
    && entry.command.some((arg) => /^(?:pilot-mcp|pilotprotocol-mcp)(?:@|$)/.test(String(arg)));
}
