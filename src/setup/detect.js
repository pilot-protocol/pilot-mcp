// setup/detect.js — find installed agent harnesses on the local machine.
//
// We look for canonical config files / directories per harness. Presence of
// the config dir is the strongest signal the user has the harness installed
// and configured. Absence means we skip configuration; the user can re-run
// `pilot-mcp setup` after installing the harness.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();

const PROBES = [
  { id: 'claude',     name: 'Claude Code',  marker: join(HOME, '.claude') },
  { id: 'cursor',     name: 'Cursor',       marker: join(HOME, '.cursor') },
  { id: 'cline',      name: 'Cline',        marker: clineSettingsPath() },
  { id: 'continue',   name: 'Continue.dev', marker: join(HOME, '.continue') },
  { id: 'openclaw',   name: 'OpenClaw',     marker: join(HOME, '.openclaw') },
  { id: 'hermes',     name: 'Hermes',       marker: join(HOME, '.hermes') },
  { id: 'picoclaw',   name: 'PicoClaw',     marker: join(HOME, '.picoclaw') },
  { id: 'openhands',  name: 'OpenHands',    marker: join(HOME, '.openhands') },
  { id: 'codex',      name: 'Codex CLI',    marker: join(HOME, '.codex') },
  { id: 'gemini',     name: 'Gemini CLI',   marker: join(HOME, '.gemini') },
  { id: 'junie',      name: 'Junie',        marker: join(HOME, '.junie') },
  { id: 'copilot',    name: 'GitHub Copilot CLI', marker: join(HOME, '.copilot') },
];

function clineSettingsPath() {
  // Cline lives inside VS Code's per-user storage. Probe both platforms.
  const candidates = [
    join(HOME, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'),
    join(HOME, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'),
    join(HOME, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

export async function detectHarnesses() {
  return PROBES.filter((p) => existsSync(p.marker));
}
