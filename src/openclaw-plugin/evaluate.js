import { spawn } from 'node:child_process';

const PACKAGE_SPEC = 'pilotprotocol-mcp@0.2.12';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_STDERR_BYTES = 1 << 20;

export async function evaluate(phase, event, options = {}) {
  const spawnProcess = options.spawn ?? spawn;
  const timeoutMs = hookTimeoutMs(options.env ?? process.env);
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    let stderrBytes = 0;
    const child = spawnProcess('npx', ['-y', PACKAGE_SPEC, 'hook', '--harness', 'openclaw', '--phase', phase], {
      stdio: ['pipe', 'pipe', 'pipe'], env: options.env ?? process.env,
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 1000);
      forceKill.unref?.();
      const reason = `Pilot control plane timed out after ${timeoutMs}ms`;
      if (phase === 'pre') finish(null, { blocked: true, reason });
      else finish(new Error(reason));
    }, timeoutMs);
    timer.unref?.();
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_STDERR_BYTES) {
        child.kill();
        const error = new Error(`Pilot hook stderr exceeds ${MAX_STDERR_BYTES} bytes`);
        if (phase === 'pre') finish(null, { blocked: true, reason: error.message });
        else finish(error);
        return;
      }
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (phase === 'pre') finish(null, { blocked: true, reason: `Pilot control plane unavailable: ${error.message}` });
      else finish(error);
    });
    child.on('close', (code) => {
      if (code === 0) return finish(null, { blocked: false });
      const reason = stderr.trim() || `Pilot hook exited ${code}`;
      if (phase === 'pre') return finish(null, { blocked: true, reason });
      return finish(new Error(reason));
    });
    child.stdin.on('error', (error) => {
      if (error?.code === 'EPIPE') return;
      if (phase === 'pre') finish(null, { blocked: true, reason: `Pilot hook input failed: ${error.message}` });
      else finish(error);
    });
    child.stdin.end(JSON.stringify(event));
  });
}

function hookTimeoutMs(env) {
  const configured = Number(env.PILOT_OPENCLAW_HOOK_TIMEOUT_MS ?? env.PILOT_HOOK_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured < 50 || configured > 25_000) return DEFAULT_TIMEOUT_MS;
  return Math.floor(configured);
}
