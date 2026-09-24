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
import { existsSync, realpathSync } from 'node:fs';
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

export function pilotctlBinaryPath(env = process.env) {
  const explicit = String(env.PILOTCTL_BIN ?? '').trim();
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`PILOTCTL_BIN does not exist: ${explicit}`);
    return explicit;
  }
  // First preference: the optionalDependency subpackage installed alongside us.
  const subpkg = join(__dirname, '..', 'node_modules', `pilot-mcp-${platformKey()}`, 'bin', 'pilotctl');
  if (existsSync(subpkg)) return subpkg;

  // Second preference: the per-user runtime installed by setup. Managed
  // adoption may deliberately replace an older system binary with a release
  // that understands the hosted enrollment contract.
  const legacy = join(homedir(), '.pilot', 'bin', process.platform === 'win32' ? 'pilotctl.exe' : 'pilotctl');
  if (existsSync(legacy)) return legacy;

  // Third preference: a system pilotctl on PATH (user installed via brew or
  // curl install.sh and we're just providing the MCP shim).
  // Resolve via process.env.PATH lookup.
  const pathEnv = (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  for (const dir of pathEnv) {
    const candidate = join(dir, process.platform === 'win32' ? 'pilotctl.exe' : 'pilotctl');
    if (existsSync(candidate)) return candidate;
  }

  throw new Error('pilotctl binary not found. Run `pilot-mcp setup` or install pilot-daemon first.');
}

// daemonBinaryPath mirrors pilotctl's companion lookup ($PILOT_DAEMON_BIN,
// then the pilot-daemon beside the resolved pilotctl, then $PATH) so setup
// inspects the same daemon `pilotctl daemon start` will launch. Returns null
// when none is found.
export function daemonBinaryPath(pilotctl, env = process.env) {
  const explicit = String(env.PILOT_DAEMON_BIN ?? '').trim();
  if (explicit) return explicit;
  const name = process.platform === 'win32' ? 'pilot-daemon.exe' : 'pilot-daemon';
  if (pilotctl) {
    let self = pilotctl;
    try {
      self = realpathSync(pilotctl);
    } catch {
      // Fall back to the unresolved path, as pilotctl itself does.
    }
    const sibling = join(dirname(self), name);
    if (existsSync(sibling)) return sibling;
  }
  for (const dir of (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
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
  const timeoutMs = positiveNumber(opts.timeoutMs, 'timeoutMs');
  const maxBufferBytes = positiveNumber(opts.maxBufferBytes, 'maxBufferBytes');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: opts.capture ? ['pipe', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let settled = false;
    let killTimer;
    const timer = timeoutMs === null ? null : setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(`pilotctl timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      killTimer.unref?.();
      reject(error);
    }, timeoutMs);
    timer?.unref?.();
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    if (opts.capture) {
      const append = (channel, chunk) => {
        if (settled) return;
        outputBytes += chunk.byteLength;
        if (maxBufferBytes !== null && outputBytes > maxBufferBytes) {
          settled = true;
          if (timer) clearTimeout(timer);
          child.kill();
          reject(new Error(`pilotctl output exceeds ${maxBufferBytes} bytes`));
          return;
        }
        if (channel === 'stdout') stdout += chunk.toString();
        else stderr += chunk.toString();
      };
      child.stdout.on('data', (chunk) => append('stdout', chunk));
      child.stderr.on('data', (chunk) => append('stderr', chunk));
      // A short-lived pilotctl may finish before Node flushes stdin. Linux
      // reports that normal close as EPIPE; without a listener it becomes an
      // uncaught process error even though the child's exit status and output
      // are already authoritative.
      child.stdin.on('error', (error) => {
        if (error?.code !== 'EPIPE' && !settled) {
          settled = true;
          if (timer) clearTimeout(timer);
          reject(error);
        }
      });
      child.stdin.end(opts.input ?? '');
    }
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (opts.capture) {
        resolve({ code: code ?? 0, stdout, stderr });
      } else {
        resolve(code ?? 0);
      }
    });
  });
}

function positiveNumber(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(parsed);
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
  } catch {
    throw new Error(`pilotctl returned non-JSON: ${result.stdout.slice(0, 200)}`);
  }
}

// withEnterpriseControl is deliberately opt-in. Existing MCP installations
// produce byte-for-byte equivalent pilotctl arguments unless the host sets
// PILOT_ENTERPRISE_CONTROL. Message and file operations then use Pilot's real
// governed dataexchange path; unsupported commands remain unchanged instead
// of pretending to be controlled.
export function withEnterpriseControl(args, env = process.env) {
  const adoptedPath = join(homedir(), '.pilot', 'managed', 'enterprise-control.json');
  const controlPath = String(env.PILOT_ENTERPRISE_CONTROL ?? '').trim() || (existsSync(adoptedPath) ? adoptedPath : '');
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
