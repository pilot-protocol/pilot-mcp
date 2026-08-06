// Keep generated hook commands runnable after a one-shot `npx ... setup`.
// Requiring a separate global install makes onboarding appear successful while
// the first real tool call fails with "pilot-mcp: command not found".

export const PILOT_RUNNER = 'npx -y pilotprotocol-mcp@0.2.8';

export function hookCommand(harness, phase) {
  return `${PILOT_RUNNER} hook --harness ${harness} --phase ${phase}`;
}

export function isPilotHookCommand(command, harness, phase) {
  return typeof command === 'string'
    && command.includes(`hook --harness ${harness} --phase ${phase}`)
    && (command.includes('pilot-mcp') || command.includes('pilotprotocol-mcp'));
}
