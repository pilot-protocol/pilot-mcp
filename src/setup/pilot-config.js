// setup/pilot-config.js — read and update ~/.pilot/config.json, the file
// pilotctl and pilot-daemon both load on every start.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Marks config.json keys that setup wrote on its own judgement (as opposed to
// values the user or install.sh chose), so a later setup may revise them.
export const SETUP_OWNER = 'pilot-mcp';

// setupOwnsTransport reports whether config.json's "transport" is the entry
// setup recorded ("compat" plus the marker). A value changed since, for
// example with `pilotctl config --set transport=udp`, belongs to the user.
export function setupOwnsTransport(config) {
  return config?.transport_set_by === SETUP_OWNER && config?.transport === 'compat';
}

export function pilotConfigPath(home = homedir()) {
  return join(home, '.pilot', 'config.json');
}

// readPilotConfig returns { path, config, error }. A missing file is an empty
// config; an unreadable or malformed one reports `error` and a null config.
export function readPilotConfig(home = homedir()) {
  const path = pilotConfigPath(home);
  if (!existsSync(path)) return { path, config: {} };
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return { path, config: null, error: 'not a JSON object' };
    }
    return { path, config };
  } catch (error) {
    return { path, config: null, error: error.message };
  }
}

export function writePilotConfig(home, config) {
  const path = pilotConfigPath(home);
  mkdirSync(join(home, '.pilot'), { recursive: true, mode: 0o700 });
  // The mode applies only when the file is created; an existing file keeps
  // its permissions.
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  return path;
}
