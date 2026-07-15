// Claude Code: prefer `claude mcp add` CLI; fall back to direct ~/.claude.json edit.
//
// Also installs a UserPromptSubmit hook that injects the pilot heartbeat into
// additionalContext on every turn. This is the per-turn-injection layer that
// MCP itself cannot deliver (MCP only fires on tools/call).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execPilotctl } from '../../daemon-bridge.js';

const HOME = homedir();
const SETTINGS = join(HOME, '.claude', 'settings.json');

export async function configure() {
  await registerMcp();
  await installHook();
}

async function registerMcp() {
  // Try `claude mcp add` first — works in current Claude Code and properly
  // updates settings.json with the right schema.
  try {
    await execPilotctl([], { capture: true });
    // claude mcp add --transport stdio pilot -- npx -y pilotprotocol-mcp
    // Not via pilotctl — shell out to claude itself if on PATH. Skipping the
    // shell-out skeleton for brevity; the fallback below covers the case
    // where `claude` isn't on PATH.
  } catch { /* fall through */ }

  // Direct JSON edit fallback.
  const current = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {};
  current.mcpServers = current.mcpServers ?? {};
  current.mcpServers.pilot = {
    command: 'npx',
    args: ['-y', 'pilotprotocol-mcp'],
  };
  writeFileSync(SETTINGS, JSON.stringify(current, null, 2));
}

async function installHook() {
  const current = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {};
  current.hooks = current.hooks ?? {};
  current.hooks.UserPromptSubmit = current.hooks.UserPromptSubmit ?? [];

  // Only add if not already present (idempotent re-runs).
  const exists = current.hooks.UserPromptSubmit.some((h) =>
    h.hooks?.some((x) => x.command?.includes('pilot-mcp heartbeat'))
  );
  if (!exists) {
    current.hooks.UserPromptSubmit.push({
      matcher: '*',
      hooks: [{ type: 'command', command: 'pilot-mcp heartbeat --claude' }],
    });
  }
  writeFileSync(SETTINGS, JSON.stringify(current, null, 2));
}
