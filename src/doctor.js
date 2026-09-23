import process from 'node:process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { daemonBinaryPath, daemonHealthy, pilotctlBinaryPath } from './daemon-bridge.js';
import { inspectProxy, redactProxyURL } from './netproxy.js';
import { PILOT_SANDBOX_SKILL_URL } from './setup/daemon.js';
import { detectHarnesses } from './setup/detect.js';
import { readPilotConfig, SETUP_OWNER, setupOwnsTransport } from './setup/pilot-config.js';
import { supportsEgressProxy } from './setup/runtime.js';
import { VERSION } from './version.js';

export async function runDoctor(flags = {}, options = {}) {
  const home = options.home ?? homedir();
  const write = options.write ?? ((value) => process.stdout.write(`${value}\n`));
  const report = {
    version: VERSION,
    runtime: runtimeCheck(),
    daemon: { healthy: await daemonHealthy() },
    network: networkCheck(options.env ?? process.env, home),
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
    if (report.network.proxy) {
      write(`Egress proxy: ${report.network.proxy} via ${report.network.source} (pilot-daemon -proxy: ${report.network.daemon_proxy_support ? 'supported' : `not supported; see ${PILOT_SANDBOX_SKILL_URL}`})`);
    }
    for (const warning of report.network.warnings ?? []) write(`Egress proxy warning: ${warning}`);
    if (report.network.transport) {
      write(`Transport: ${report.network.transport.value} (config.json, set by ${report.network.transport.set_by === SETUP_OWNER ? 'pilot-mcp setup' : 'you or install.sh'})`);
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

// networkCheck reports the egress proxy the daemon would use (redacted),
// whether the daemon pilotctl would launch supports it, any proxy setting
// that is ignored, and the transport recorded in ~/.pilot/config.json.
function networkCheck(env, home) {
  const { config } = readPilotConfig(home);
  const spec = typeof config?.proxy === 'string' ? config.proxy : undefined;
  const { proxy, warnings } = inspectProxy(env, { spec, specSource: 'config.json proxy' });
  const report = { proxy: null };
  if (proxy) {
    let daemon = null;
    try {
      daemon = daemonBinaryPath(pilotctlBinaryPath(env), env);
    } catch {
      // No runtime: reported by runtimeCheck.
    }
    Object.assign(report, { proxy: redactProxyURL(proxy.url), source: proxy.source, daemon_proxy_support: supportsEgressProxy(daemon) });
  }
  if (warnings.length) report.warnings = warnings;
  if (typeof config?.transport === 'string' && config.transport) {
    report.transport = { value: config.transport, set_by: setupOwnsTransport(config) ? SETUP_OWNER : 'user' };
  }
  return report;
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
