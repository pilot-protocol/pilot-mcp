// Continue.dev: merge Pilot into the current global config.yaml agent format.

import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parseDocument } from 'yaml';
import { PILOT_PACKAGE_SPEC, pilotMcpServer } from './runtime.js';

const HOME = homedir();
const TARGET = join(HOME, '.continue', 'config.yaml');
const LEGACY_TARGET = join(HOME, '.continue', 'mcpServers', 'pilot.yaml');

export async function configure() {
  mkdirSync(dirname(TARGET), { recursive: true });
  const source = existsSync(TARGET)
    ? readFileSync(TARGET, 'utf8')
    : 'name: Pilot-enabled Continue\nversion: 1.0.0\nschema: v1\nmcpServers: []\n';
  const document = parseDocument(source.trim() ? source : '{}\n');
  if (document.errors.length) throw new Error(`cannot merge Continue YAML: ${document.errors[0].message}`);
  const entries = document.getIn(['mcpServers'], true)?.toJSON?.() ?? [];
  if (!Array.isArray(entries)) throw new Error('Continue mcpServers must be a sequence');
  const retained = entries.filter((entry) => !isPilotEntry(entry));
  retained.push({ name: 'Pilot', ...pilotMcpServer() });
  document.setIn(['mcpServers'], retained);
  writeFileSync(TARGET, String(document));

  // Releases <=0.2.11 wrote an isolated block file. Remove only a file that
  // unmistakably belongs to Pilot so Continue does not load the server twice.
  if (existsSync(LEGACY_TARGET)) {
    const legacy = readFileSync(LEGACY_TARGET, 'utf8');
    if (/pilotprotocol-mcp(?:@[^\s"']+)?/.test(legacy)) unlinkSync(LEGACY_TARGET);
  }
}

function isPilotEntry(entry) {
  return String(entry?.name ?? '').toLowerCase() === 'pilot'
    || (Array.isArray(entry?.args) && entry.args.some((arg) => String(arg).startsWith('pilotprotocol-mcp@')))
    || entry?.args?.includes?.(PILOT_PACKAGE_SPEC);
}
