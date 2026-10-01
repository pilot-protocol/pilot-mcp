// setup/identity.js — capture email + hostname, write ~/.pilot/config.json.
//
// Today's install drops the ball on these inputs — install.sh prompts for
// email only via TTY (silently skipped on pipes), hostname is never asked at
// install time. This module captures both up front.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const CONFIG = join(HOME, '.pilot', 'config.json');

export async function writeIdentity({ email, hostname }) {
  mkdirSync(dirname(CONFIG), { recursive: true });
  const current = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {};
  if (email) current.email = email;
  if (hostname) current.hostname = hostname;
  current.registry = current.registry ?? '34.71.57.205:9000';
  current.beacon = current.beacon ?? '34.71.57.205:9001';
  current.socket = current.socket ?? '/tmp/pilot.sock';
  current.encrypt = current.encrypt ?? true;
  current.identity = current.identity ?? join(HOME, '.pilot', 'identity.json');
  writeFileSync(CONFIG, JSON.stringify(current, null, 2));
}
