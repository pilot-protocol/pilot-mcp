import process from 'node:process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { daemonBinaryPath, daemonHealthy, pilotctlBinaryPath } from './daemon-bridge.js';
import { configuredProxyCommand, redactProxyURL } from './netproxy.js';
import { daemonProxyView, daemonSettingWarnings, PILOT_SANDBOX_SKILL_URL } from './setup/daemon.js';
import { detectHarnesses } from './setup/detect.js';
import { readPilotConfig, SETUP_OWNER, setupOwnsTransport } from './setup/pilot-config.js';
import { EGRESS_RELAY_URL } from './setup/proxy-refresh.js';
import { daemonFeatures } from './setup/runtime.js';
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
    } else if (report.network.mode === 'off') {
      write(`Egress proxy: off (${report.network.setting})`);
    }
    if (report.network.proxy_cmd?.daemon_support) {
      write(`Proxy credentials: re-read by pilot-daemon with the proxy command from ${report.network.proxy_cmd.source}`);
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

// networkCheck reports the egress proxy the daemon would use (redacted) and
// the mode behind it, whether the daemon pilotctl would launch supports it,
// any proxy or transport setting that is ignored or refused (judged against
// that daemon: "auto" is valid for one with -transport=auto), the proxy
// command that re-reads rotating credentials (never the command itself), and
// the transport recorded in ~/.pilot/config.json.
function networkCheck(env, home) {
  const { path, config } = readPilotConfig(home);
  let features;
  const runtime = () => {
    if (!features) {
      let daemon = null;
      try {
        daemon = daemonBinaryPath(pilotctlBinaryPath(env), env);
      } catch {
        // No runtime: reported by runtimeCheck.
      }
      features = daemonFeatures(daemon);
    }
    return features;
  };
  const warnings = daemonSettingWarnings(env, config ?? {}, path, runtime);
  const view = daemonProxyView(env, config ?? {}, runtime);
  warnings.push(...view.warnings);
  const { proxy } = view;
  const report = { proxy: null, mode: view.mode };
  if (view.setting) report.setting = view.setting;
  if (proxy) {
    Object.assign(report, { proxy: redactProxyURL(proxy.url), source: proxy.source, daemon_proxy_support: runtime().proxy });
  }
  const command = configuredProxyCommand(env, config ?? {});
  if (command) {
    report.proxy_cmd = { source: command.source, daemon_support: runtime().proxyCmd };
    if (runtime().known && !runtime().proxyCmd) {
      warnings.push(`${command.source} is set, but the installed pilot-daemon predates -proxy-cmd and ignores it, so rotated proxy credentials are not re-read. Update the Pilot runtime, or use the pilot-sandbox egress relay (${EGRESS_RELAY_URL}).`);
    }
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
