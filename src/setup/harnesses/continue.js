// Continue.dev: write .continue/mcpServers/pilot.yaml.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const TARGET = join(HOME, '.continue', 'mcpServers', 'pilot.yaml');

const CONTENT = `name: Pilot
version: 0.1.0
schema: v1
mcpServers:
  - name: pilot
    command: npx
    args: ["-y", "pilotprotocol-mcp@0.2.10"]
`;

export async function configure() {
  mkdirSync(dirname(TARGET), { recursive: true });
  writeFileSync(TARGET, CONTENT);
}
