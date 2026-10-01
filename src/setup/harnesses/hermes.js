// Hermes: install the Pilot MCP server and remove the shell hooks (and their
// allowlist approvals) earlier Pilot releases wrote.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parseDocument } from 'yaml';
import { isPilotHookCommand, pilotMcpServer } from './runtime.js';

const CONFIG = join(homedir(), '.hermes', 'config.yaml');
const ALLOWLIST = join(homedir(), '.hermes', 'shell-hooks-allowlist.json');
const RETIRED_EVENTS = ['pre_tool_call', 'post_tool_call'];

export async function configure() {
  mkdirSync(dirname(CONFIG), { recursive: true });
  const source = existsSync(CONFIG) ? readFileSync(CONFIG, 'utf8') : '{}\n';
  const document = parseDocument(source.trim() ? source : '{}\n');
  if (document.errors.length) {
    throw new Error(`cannot merge Hermes YAML: ${document.errors[0].message}`);
  }
  document.setIn(['mcp_servers', 'pilot'], pilotMcpServer());
  for (const event of RETIRED_EVENTS) removeRetiredHook(document, event);
  const remaining = document.getIn(['hooks'], true)?.toJSON?.();
  if (remaining && typeof remaining === 'object' && Object.keys(remaining).length === 0) {
    document.deleteIn(['hooks']);
  }
  writeFileSync(CONFIG, String(document));
  removeRetiredConsent();
}

// Releases <=0.3.0 installed pre_tool_call/post_tool_call commands for the
// hosted control plane. Remove only those; other hooks are left as written.
function removeRetiredHook(document, event) {
  const entries = document.getIn(['hooks', event], true)?.toJSON?.();
  if (!Array.isArray(entries)) return;
  const retained = entries.filter((entry) => !isPilotHookCommand(entry?.command, 'hermes'));
  if (retained.length === entries.length) return;
  if (retained.length > 0) document.setIn(['hooks', event], retained);
  else document.deleteIn(['hooks', event]);
}

function removeRetiredConsent() {
  if (!existsSync(ALLOWLIST)) return;
  const current = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  if (!Array.isArray(current.approvals)) return;
  const retained = current.approvals.filter((approval) =>
    !(approval && typeof approval === 'object'
      && RETIRED_EVENTS.includes(approval.event)
      && isPilotHookCommand(approval.command, 'hermes'))
  );
  if (retained.length === current.approvals.length) return;
  current.approvals = retained;
  writeFileSync(ALLOWLIST, JSON.stringify(current, null, 2));
}
