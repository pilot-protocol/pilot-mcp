// Hermes: install Pilot MCP plus the native pre/post shell-hook boundary.
//
// Hermes runs these command hooks in both CLI and Gateway sessions. Its
// pre_tool_call response can block execution, but non-zero hook exits do not;
// the adapter therefore emits Hermes' documented JSON block object.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parseDocument } from 'yaml';
import { hookCommand, isPilotHookCommand } from './runtime.js';

const CONFIG = join(homedir(), '.hermes', 'config.yaml');

export async function configure() {
  mkdirSync(dirname(CONFIG), { recursive: true });
  const source = existsSync(CONFIG) ? readFileSync(CONFIG, 'utf8') : '{}\n';
  const document = parseDocument(source.trim() ? source : '{}\n');
  if (document.errors.length) {
    throw new Error(`cannot merge Hermes YAML: ${document.errors[0].message}`);
  }
  document.setIn(['mcp_servers', 'pilot'], {
    command: 'npx',
    args: ['-y', 'pilotprotocol-mcp@0.2.10'],
  });
  installHook(document, 'pre_tool_call', 'pre');
  installHook(document, 'post_tool_call', 'post');
  writeFileSync(CONFIG, String(document));
}

function installHook(document, event, phase) {
  const command = hookCommand('hermes', phase);
  const node = document.getIn(['hooks', event], true);
  const entries = node?.toJSON?.() ?? [];
  if (!Array.isArray(entries)) {
    throw new Error(`Hermes hooks.${event} must be a sequence`);
  }
  const existing = entries.find((entry) => isPilotHookCommand(entry?.command, 'hermes', phase));
  if (existing) {
    existing.command = command;
  } else {
    entries.push({ matcher: '.*', command, timeout: 30 });
  }
  document.setIn(['hooks', event], entries);
}
