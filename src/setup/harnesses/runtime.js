// Keep generated MCP commands runnable after a one-shot `npx ... setup`.
// Requiring a separate global install makes onboarding appear successful while
// the first real tool call fails with "pilot-mcp: command not found".

import { PACKAGE_SPEC, VERSION } from '../../version.js';

export const PILOT_PACKAGE_VERSION = VERSION;
export const PILOT_PACKAGE_SPEC = PACKAGE_SPEC;

export function pilotMcpServer(extra = {}) {
  return {
    command: 'npx',
    args: ['-y', PILOT_PACKAGE_SPEC],
    ...extra,
  };
}

// Releases <=0.3.0 installed `pilot-mcp hook --harness <id> --phase pre|post`
// as a native pre/post tool hook for the hosted control plane, which has been
// retired. Setup no longer installs hooks; the helpers below recognise and
// remove only the entries Pilot wrote, leaving user and third-party hooks alone.
export function isPilotHookCommand(command, harness) {
  return typeof command === 'string'
    && command.includes(`hook --harness ${harness}`)
    && (command.includes('pilot-mcp') || command.includes('pilotprotocol-mcp'));
}

// Claude-shaped hook maps: { Event: [{ matcher?, hooks: [{ command }] }] }.
// Returns true when anything was removed.
export function removeGroupedPilotHooks(hooks, events, harness) {
  if (!hooks || typeof hooks !== 'object') return false;
  let changed = false;
  for (const event of events) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    let removed = false;
    const retained = groups.flatMap((group) => {
      if (!Array.isArray(group?.hooks)) return [group];
      const kept = group.hooks.filter((hook) => !isPilotHookCommand(hook?.command, harness));
      if (kept.length === group.hooks.length) return [group];
      removed = true;
      return kept.length > 0 ? [{ ...group, hooks: kept }] : [];
    });
    if (!removed) continue;
    changed = true;
    if (retained.length > 0) hooks[event] = retained;
    else delete hooks[event];
  }
  return changed;
}

// Flat hook maps: { event: [{ command | bash | powershell }] }.
// Returns true when anything was removed.
export function removeFlatPilotHooks(hooks, events, harness) {
  if (!hooks || typeof hooks !== 'object') return false;
  let changed = false;
  for (const event of events) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const retained = entries.filter((hook) =>
      !isPilotHookCommand(hook?.command ?? hook?.bash ?? hook?.powershell, harness)
    );
    if (retained.length === entries.length) continue;
    changed = true;
    if (retained.length > 0) hooks[event] = retained;
    else delete hooks[event];
  }
  return changed;
}
