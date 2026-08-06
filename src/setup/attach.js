// Adapter-only attachment for nodes already adopted by core Pilot.
//
// This command deliberately does not install or replace pilotctl/pilot-daemon,
// create an identity, claim enrollment, or manage a service. Those are core
// Pilot responsibilities. It only writes the selected harness's native hook
// and MCP configuration after verifying an owner-only managed attachment.

import process from 'node:process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { lstatSync } from 'node:fs';

import harnesses from './harnesses/index.js';

export const ATTACHABLE_HARNESSES = Object.freeze([
  'claude', 'cursor', 'cline', 'continue', 'openclaw', 'hermes', 'picoclaw',
  'openhands', 'codex', 'gemini', 'junie', 'copilot',
]);

export async function runAttach(flags, options = {}) {
  const home = options.home ?? homedir();
  const controlPath = join(home, '.pilot', 'managed', 'enterprise-control.json');
  const stat = (options.lstat ?? lstatSync)(controlPath);
  verifyManagedControl(stat, controlPath, options.platform ?? process.platform, options.uid ?? currentUID());

  const selected = selectedHarnesses(flags);
  const writers = options.harnesses ?? harnesses;
  const configured = [];
  for (const id of selected) {
    const writer = writers[id];
    if (!writer?.configure) throw new Error(`unsupported harness ${id}`);
    await writer.configure({ id, name: id, transport: 'managed', enterpriseControl: controlPath });
    configured.push(id);
  }

  const write = options.write ?? ((message) => process.stdout.write(`${message}\n`));
  write(`Attached ${configured.join(', ')} to the existing core Pilot node.`);
  write('Core runtime and node identity were not changed.');
  return { controlPath, configured };
}

export function selectedHarnesses(flags) {
  if (flags.all === true) return [...ATTACHABLE_HARNESSES];
  const selected = ATTACHABLE_HARNESSES.filter((id) => flags[id] === true);
  if (selected.length === 0) {
    throw new Error(`choose at least one harness: ${ATTACHABLE_HARNESSES.map((id) => `--${id}`).join(', ')}`);
  }
  return selected;
}

function verifyManagedControl(stat, path, platform, uid) {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`core managed attachment is not a regular file: ${path}`);
  }
  if (platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`core managed attachment must be owner-only (0600): ${path}`);
  }
  if (platform !== 'win32' && uid !== null && stat.uid !== uid) {
    throw new Error(`core managed attachment is not owned by the current user: ${path}`);
  }
}

function currentUID() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}
