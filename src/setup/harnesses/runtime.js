// Keep generated hook commands runnable after a one-shot `npx ... setup`.
// Requiring a separate global install makes onboarding appear successful while
// the first real tool call fails with "pilot-mcp: command not found".

import { PACKAGE_SPEC, VERSION } from '../../version.js';

export const PILOT_PACKAGE_VERSION = VERSION;
export const PILOT_PACKAGE_SPEC = PACKAGE_SPEC;
export const PILOT_RUNNER = `npx -y ${PILOT_PACKAGE_SPEC}`;

export function pilotMcpServer(extra = {}) {
  return {
    command: 'npx',
    args: ['-y', PILOT_PACKAGE_SPEC],
    ...extra,
  };
}

export function hookCommand(harness, phase) {
  return `${PILOT_RUNNER} hook --harness ${harness} --phase ${phase}`;
}

export function isPilotHookCommand(command, harness, phase) {
  return typeof command === 'string'
    && command.includes(`hook --harness ${harness} --phase ${phase}`)
    && (command.includes('pilot-mcp') || command.includes('pilotprotocol-mcp'));
}
