// daemon-bridge.js — talks to the local pilot-daemon.
//
// All MCP tool invocations route through here. We do NOT re-implement Pilot's
// wire protocol in JS — we shell out to `pilotctl` (the Go binary in the
// resolved platform subpackage) or open the daemon's Unix socket directly.
//
// Two access modes:
//   1. execPilotctl(args)  — shell out to pilotctl <args>, capture stdout/stderr.
//      Simple, robust, matches the user's mental model of "what pilotctl does".
//   2. socketRequest(req)  — open ~/.pilot/daemon.sock (or /tmp/pilot.sock),
//      send framed JSON, read framed response. Lower latency but couples us
//      to daemon's internal IPC protocol — use sparingly.
//
// Both modes surface daemon-not-running as MCP error 503 with a setup hint.

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function platformKey() {
  const { platform, arch } = process;
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  throw new Error(`unsupported platform: ${platform}/${arch}`);
}

export function pilotctlBinaryPath() {
  // First preference: the optionalDependency subpackage installed alongside us.
  const subpkg = join(__dirname, '..', 'node_modules', `pilot-mcp-${platformKey()}`, 'bin', 'pilotctl');
  if (existsSync(subpkg)) return subpkg;

  // Second preference: a system pilotctl on PATH (user installed via brew or
  // curl install.sh and we're just providing the MCP shim).
  // Resolve via process.env.PATH lookup.
  const pathEnv = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  for (const dir of pathEnv) {
    const candidate = join(dir, process.platform === 'win32' ? 'pilotctl.exe' : 'pilotctl');
    if (existsSync(candidate)) return candidate;
  }

  // Third preference: ~/.pilot/bin/pilotctl from the legacy install.sh.
  const legacy = join(homedir(), '.pilot', 'bin', process.platform === 'win32' ? 'pilotctl.exe' : 'pilotctl');
  if (existsSync(legacy)) return legacy;

  throw new Error('pilotctl binary not found. Run `pilot-mcp setup` or install pilot-daemon first.');
}

export function daemonSocketPath() {
  // Convention: /tmp/pilot.sock on macOS/Linux, named pipe on Windows.
  // Override via $PILOT_SOCKET.
  if (process.env.PILOT_SOCKET) return process.env.PILOT_SOCKET;
  if (process.platform === 'win32') return '\\\\.\\pipe\\pilot';
  return '/tmp/pilot.sock';
}

export async function execPilotctl(args, opts = {}) {
  const bin = pilotctlBinaryPath();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let stdout = '';
    let stderr = '';
    if (opts.capture) {
      child.stdout.on('data', (b) => { stdout += b.toString(); });
      child.stderr.on('data', (b) => { stderr += b.toString(); });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (opts.capture) {
        resolve({ code: code ?? 0, stdout, stderr });
      } else {
        resolve(code ?? 0);
      }
    });
  });
}

export async function pilotctlJSON(args) {
  // Wrapper that adds --json and parses the response, with a clear error if
  // pilotctl is missing or daemon isn't reachable.
  const governed = withEnterpriseControl(args);
  const result = await execPilotctl([...governed, '--json'], { capture: true });
  if (result.code !== 0) {
    const hint = result.stderr.includes('socket')
      ? '\nDaemon not running. Run: pilot-mcp setup'
      : '';
    throw new Error(`pilotctl ${args.join(' ')} failed (exit ${result.code}): ${result.stderr.trim()}${hint}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    throw new Error(`pilotctl returned non-JSON: ${result.stdout.slice(0, 200)}`);
  }
}

// withEnterpriseControl is deliberately opt-in. Existing MCP installations
// produce byte-for-byte equivalent pilotctl arguments unless the host sets
// PILOT_ENTERPRISE_CONTROL. Message and file operations then use Pilot's real
// governed dataexchange path; unsupported commands remain unchanged instead
// of pretending to be controlled.
export function withEnterpriseControl(args, env = process.env) {
  const controlPath = String(env.PILOT_ENTERPRISE_CONTROL ?? '').trim();
  if (!controlPath || !Array.isArray(args) || args.length < 2 || args.includes('--enterprise-control')) {
    return [...args];
  }
  const [command, target] = args;
  if (command !== 'send-message' && command !== 'send-file') return [...args];
  const template = String(env.PILOT_GOVERNED_RESOURCE_TEMPLATE ?? 'agent:{target}/inbox').trim();
  if (!template || !template.includes('{target}')) {
    throw new Error('PILOT_GOVERNED_RESOURCE_TEMPLATE must contain {target}');
  }
  const resource = template.replaceAll('{target}', String(target));
  return [...args, '--enterprise-control', controlPath, '--governed-resource', resource];
}

export async function daemonHealthy() {
  if (!existsSync(daemonSocketPath())) return false;
  return new Promise((resolve) => {
    const sock = connect(daemonSocketPath(), () => { sock.end(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(500, () => { sock.destroy(); resolve(false); });
  });
}
