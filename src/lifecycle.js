import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

export async function runLifecycle(command, args, options = {}) {
  const home = options.home ?? homedir();
  const identity = join(home, '.pilot', 'identity.json');
  const force = args.includes('--force');
  const file = args.find((arg) => !arg.startsWith('--'));
  if (command === 'export-identity') {
    if (!existsSync(identity)) throw new Error(`Pilot identity not found: ${identity}`);
    const destination = resolve(file ?? join(process.cwd(), 'pilot-identity.json'));
    if (existsSync(destination) && !force) throw new Error(`destination already exists: ${destination} (pass --force to replace)`);
    const value = parseIdentity(readFileSync(identity, 'utf8'), identity);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(destination, 0o600);
    process.stdout.write(`Exported Pilot identity to ${destination}\n`);
    return destination;
  }
  if (command === 'import-identity') {
    if (!file) throw new Error('import-identity requires a source file');
    const source = resolve(file);
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('identity source must be a regular, non-symbolic-link file');
    if (existsSync(identity) && !force) throw new Error(`identity already exists: ${identity} (pass --force to replace)`);
    const value = parseIdentity(readFileSync(source, 'utf8'), source);
    mkdirSync(dirname(identity), { recursive: true });
    writeFileSync(identity, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(identity, 0o600);
    process.stdout.write(`Imported Pilot identity into ${identity}\n`);
    return identity;
  }
  throw new Error('adapter uninstall is not yet available; remove Pilot through each harness and core runtime explicitly');
}

function parseIdentity(source, path) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`identity is not valid JSON: ${path}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new Error(`identity must be a non-empty JSON object: ${path}`);
  }
  return value;
}
