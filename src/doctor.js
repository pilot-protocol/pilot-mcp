import process from 'node:process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { daemonBinaryPath, daemonHealthy, pilotctlBinaryPath } from './daemon-bridge.js';
import { configuredProxy, redactProxyURL } from './netproxy.js';
import { PILOT_SANDBOX_SKILL_URL } from './setup/daemon.js';
import { detectHarnesses } from './setup/detect.js';
import { supportsEgressProxy } from './setup/runtime.js';
import { VERSION } from './version.js';

export async function runDoctor(flags = {}, options = {}) {
  const home = options.home ?? homedir();
  const write = options.write ?? ((value) => process.stdout.write(`${value}\n`));
  const report = {
    version: VERSION,
    runtime: runtimeCheck(),
    daemon: { healthy: await daemonHealthy() },
    network: networkCheck(options.env ?? process.env),
    management: managedCheck(join(home, '.pilot', 'managed', 'enterprise-control.json')),
    harnesses: (await detectHarnesses()).map(({ id, name }) => ({ id, name })),
  };
  report.ok = report.runtime.ok && (report.management.attached ? report.management.secure : true);
  if (flags.json) {
    write(JSON.stringify(report));
  } else {
    write(`Pilot adapter ${report.version}`);
    write(`Runtime: ${report.runtime.ok ? report.runtime.path : report.runtime.error}`);
    write(`Daemon: ${report.daemon.healthy ? 'reachable' : 'not reachable'}`);
    if (report.network.error) write(`Egress proxy: ${report.network.error}`);
    if (report.network.proxy) {
      write(`Egress proxy: ${report.network.proxy} via ${report.network.source} (pilot-daemon -proxy: ${report.network.daemon_proxy_support ? 'supported' : `not supported; see ${PILOT_SANDBOX_SKILL_URL}`})`);
    }
    write(`Management: ${report.management.attached ? (report.management.secure ? 'attached (owner-only)' : report.management.error) : 'not attached (unmanaged pass-through)'}`);
    write(`Harnesses detected: ${report.harnesses.map((entry) => entry.id).join(', ') || 'none'}`);
  }
  if (!report.ok) process.exitCode = 1;
  return report;
}

function runtimeCheck() {
  try {
    return { ok: true, path: pilotctlBinaryPath() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// networkCheck reports the egress proxy the environment selects (redacted)
// and whether the daemon pilotctl would launch can use it.
function networkCheck(env) {
  let proxy;
  try {
    proxy = configuredProxy(env);
  } catch (error) {
    return { proxy: null, error: error.message };
  }
  if (!proxy) return { proxy: null };
  let daemon = null;
  try {
    daemon = daemonBinaryPath(pilotctlBinaryPath(env), env);
  } catch {
    // No runtime: reported by runtimeCheck.
  }
  return { proxy: redactProxyURL(proxy.url), source: proxy.source, daemon_proxy_support: supportsEgressProxy(daemon) };
}

function managedCheck(path) {
  if (!existsSync(path)) return { attached: false, secure: true };
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { attached: true, secure: false, error: 'attachment is not a regular file' };
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      return { attached: true, secure: false, error: 'attachment permissions are not owner-only (0600)' };
    }
    return { attached: true, secure: true };
  } catch (error) {
    return { attached: true, secure: false, error: error.message };
  }
}
