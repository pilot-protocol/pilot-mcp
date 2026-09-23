// setup/daemon.js — install + start pilot-daemon + smoke-handshake the catalog.
//
// Today's pilot-daemon install writes launchd plist / systemd unit but never
// loads it — user has to manually `brew services start` or
// `sudo systemctl enable --now`. This module closes that gap, plus does:
//   - Smoke test: send a 1-item search to list-agents to confirm the overlay
//     is reachable AND trust with the catalog auto-approved before claiming
//     success in the summary. list-agents lives on the backbone (Network 0),
//     which every daemon joins automatically at registration — no explicit
//     network-join step is required.
//
// Proxy-only sandboxes (Meta Muse: no outbound UDP, poisoned DNS for the
// Pilot hostnames, egress only via an authenticating HTTPS_PROXY that allows
// CONNECT :443) need the daemon in compat mode with its registry and beacon
// traffic tunnelled through the proxy. When a proxy is configured and UDP is
// blocked, and the installed pilot-daemon supports -proxy, the daemon starts
// with -transport=compat -proxy=auto and "transport": "compat" is recorded in
// ~/.pilot/config.json so a plain `pilotctl daemon start` after a VM restart
// comes back the same way. Older daemons keep today's start and get a pointer
// to the pilot-sandbox skill's root-only workaround.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { daemonBinaryPath, execPilotctl, pilotctlBinaryPath, pilotctlJSON } from '../daemon-bridge.js';
import { configuredProxy, redactProxyURL } from '../netproxy.js';
import { ensurePilotRuntime, supportsEgressProxy } from './runtime.js';

export const PILOT_SANDBOX_SKILL_URL = 'https://github.com/TeoSlayer/pilot-skills/tree/main/skills/pilot-sandbox';

// Environment the daemon needs to reach the network through the proxy.
// pilotctl passes these through when it forks pilot-daemon.
export const DAEMON_PROXY_ENV = Object.freeze([
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy',
  'NO_PROXY', 'no_proxy', 'PILOT_PROXY', 'PILOT_TRANSPORT', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);

export async function installDaemon({
  transport,
  autoStart,
  enterpriseControl,
  env = process.env,
  home = homedir(),
  log = defaultLog,
  upgradeRuntime = () => ensurePilotRuntime({ requireProxy: true, home }),
}) {
  // The setup runtime stage has already installed a checksum-verified
  // pilot-daemon/pilotctl pair under ~/.pilot/bin. pilotctl uses the matching
  // sibling daemon and either routes through an existing service definition or
  // starts the user process directly.

  let plan = { mode: 'default' };
  if (autoStart) {
    if (enterpriseControl) {
      const status = await execPilotctl(['daemon', 'status', '--check'], { capture: true });
      if (status.code === 0) {
        const stopped = await execPilotctl(['daemon', 'stop'], { capture: true });
        if (stopped.code !== 0) throw new Error(`could not restart the existing daemon for managed control: ${stopped.stderr.trim()}`);
      }
    }
    plan = planDaemonStart({ transport, env });
    if (plan.mode === 'proxy-unsupported' && !enterpriseControl && upgradeRuntime) {
      // The pinned managed runtime is never swapped for the public release.
      log(`  ${plan.daemon ?? 'pilot-daemon'} predates egress-proxy support; checking for a newer Pilot runtime…`);
      try {
        await upgradeRuntime();
      } catch (error) {
        log(`  Runtime upgrade failed — ${error.message}`);
      }
      plan = planDaemonStart({ transport, env });
    }
    const startArgs = ['daemon', 'start'];
    if (plan.mode === 'compat-proxy') {
      recordTransport(home, 'compat', log);
      startArgs.push('--transport', 'compat');
      // An explicit PILOT_PROXY reaches the daemon through the environment;
      // a -proxy flag would override it.
      if (plan.source !== 'PILOT_PROXY') startArgs.push('--proxy', 'auto');
      log(`  Egress proxy ${redactProxyURL(plan.proxy)} (${plan.source}): starting pilot-daemon with -transport=compat -proxy=${plan.source === 'PILOT_PROXY' ? '$PILOT_PROXY' : 'auto'}.`);
    } else if (plan.mode === 'proxy-unsupported') {
      log(`  Egress proxy ${redactProxyURL(plan.proxy)} is set and UDP is blocked, but ${plan.daemon ?? 'pilot-daemon'}`);
      log('  has no -proxy flag, so it cannot reach the Pilot registry through the proxy.');
      log(`  Update the Pilot runtime, or follow the pilot-sandbox skill: ${PILOT_SANDBOX_SKILL_URL}`);
    }
    if (enterpriseControl) startArgs.push('--enterprise-control', enterpriseControl);
    const started = await execPilotctl(startArgs, { capture: Boolean(enterpriseControl), env: daemonEnvironment(env) });
    if (enterpriseControl && started.code !== 0) {
      throw new Error(`managed daemon start failed: ${String(started.stderr || started.stdout).trim()}`);
    }
  }

  // No explicit network-join is needed. The catalog specialists (list-agents
  // and friends) live on Network 0 — the backbone — which every daemon joins
  // automatically at registration. Earlier docs referenced "Network 9" as a
  // data-exchange network; that network does not exist on the current
  // registry. Specialist hostnames resolve to addresses with the `0:` prefix
  // (e.g. `0:0000.0002.BBE4` for list-agents) because they're backbone-resident.

  // Trust gate: setup is not "complete" until we can verify trust is actually
  // working — daemon registered, backbone reachable, and the list-agents
  // catalog specialist responding via auto-approve. Without this verification,
  // today's
  // install silently leaves the user to discover trust-propagation races,
  // UDP-blocked transports, and stale daemons themselves.
  try {
    const result = await pilotctlJSON([
      'send-message', 'list-agents',
      '--data', '/data {"limit":1}',
      '--wait', '10s',
    ]);
    if (!result?.ok && !result?.data) {
      return {
        reachable: false,
        trust_verified: false,
        hint: 'Daemon is up but trust handshake with list-agents did not complete. Most common cause: UDP blocked (try compat mode) or first-run registry propagation. Run `pilot-mcp doctor` and retry in 60s.',
        ...egressSummary(plan),
      };
    }
    return {
      reachable: true,
      trust_verified: true,
      catalog_sample: result?.data,
      ...egressSummary(plan),
    };
  } catch (err) {
    return {
      reachable: false,
      trust_verified: false,
      error: err.message,
      hint: 'Daemon is running but trust handshake with list-agents failed. Run `pilot-mcp doctor` for diagnostics.',
      ...egressSummary(plan),
    };
  }
}

// planDaemonStart decides how the daemon must start:
//   default            no proxy configured, or UDP works: today's start
//   compat-proxy       proxy configured, UDP blocked, daemon supports -proxy
//   proxy-unsupported  proxy configured, UDP blocked, daemon predates -proxy
export function planDaemonStart({ transport, env = process.env, daemon } = {}) {
  const proxy = configuredProxy(env);
  if (!proxy || transport !== 'compat') return { mode: 'default' };
  const binary = daemon === undefined ? daemonBinaryPath(locatePilotctl(env), env) : daemon;
  return {
    mode: supportsEgressProxy(binary) ? 'compat-proxy' : 'proxy-unsupported',
    proxy: proxy.url,
    source: proxy.source,
    daemon: binary,
  };
}

function daemonEnvironment(env) {
  const forwarded = {};
  for (const name of DAEMON_PROXY_ENV) {
    if (env[name] !== undefined) forwarded[name] = env[name];
  }
  return forwarded;
}

function egressSummary(plan) {
  if (plan.mode === 'default') return {};
  return { proxy: redactProxyURL(plan.proxy), proxy_supported: plan.mode === 'compat-proxy' };
}

function locatePilotctl(env) {
  try {
    return pilotctlBinaryPath(env);
  } catch {
    return null;
  }
}

// recordTransport persists the transport in ~/.pilot/config.json, which both
// pilotctl and pilot-daemon read on every start. The proxy URL is never
// written: it carries credentials and stays in the environment.
function recordTransport(home, transport, log) {
  const path = join(home, '.pilot', 'config.json');
  let config = {};
  try {
    if (existsSync(path)) config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    log(`  Could not record transport in ${path}: ${error.message}`);
    return;
  }
  if (config.transport === transport) return;
  config.transport = transport;
  writeFileSync(path, JSON.stringify(config, null, 2));
}

function defaultLog(line) {
  process.stderr.write(`${line}\n`);
}
