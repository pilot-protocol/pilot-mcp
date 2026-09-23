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
// with -transport=compat; its own -proxy default ("auto") then uses the
// proxy environment, and setup never passes -proxy, so a config.json "proxy"
// or $PILOT_PROXY the user chose still wins. "transport": "compat" is recorded
// in ~/.pilot/config.json, marked as setup's own, so a plain `pilotctl daemon
// start` after a VM restart comes back the same way; a later setup that finds
// UDP working (or no proxy) removes it again. A transport the user or
// install.sh set is never changed. Older daemons keep today's start and get a
// pointer to the pilot-sandbox skill's workaround.

import { homedir } from 'node:os';
import process from 'node:process';
import { daemonBinaryPath, execPilotctl, pilotctlBinaryPath, pilotctlJSON } from '../daemon-bridge.js';
import { inspectProxy, redactProxyURL } from '../netproxy.js';
import { readPilotConfig, SETUP_OWNER, setupOwnsTransport, writePilotConfig } from './pilot-config.js';
import { managedNodeReason, supportsEgressProxy, upgradeRuntimeForProxy } from './runtime.js';

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
  upgradeRuntime = () => upgradeRuntimeForProxy({ home, env }),
}) {
  // The setup runtime stage has already installed a checksum-verified
  // pilot-daemon/pilotctl pair under ~/.pilot/bin. pilotctl uses the matching
  // sibling daemon and either routes through an existing service definition or
  // starts the user process directly.

  let plan = { mode: 'default', transport, transportSource: 'probe', warnings: [] };
  if (autoStart) {
    if (enterpriseControl) {
      const status = await execPilotctl(['daemon', 'status', '--check'], { capture: true });
      if (status.code === 0) {
        const stopped = await execPilotctl(['daemon', 'stop'], { capture: true });
        if (stopped.code !== 0) throw new Error(`could not restart the existing daemon for managed control: ${stopped.stderr.trim()}`);
      }
    }
    plan = planDaemonStart({ transport, env, home });
    if (plan.mode === 'proxy-unsupported' && upgradeRuntime) {
      // A managed node's pinned runtime is never swapped for the public
      // release, whether or not --managed-url was given on this run.
      const managed = enterpriseControl ? 'managed control' : managedNodeReason({ home, env });
      if (managed) {
        log(`  ${plan.daemon ?? 'pilot-daemon'} predates egress-proxy support; this node is managed (${managed}), so its pinned runtime is kept.`);
      } else {
        log(`  ${plan.daemon ?? 'pilot-daemon'} predates egress-proxy support; checking for a newer Pilot runtime…`);
        try {
          const result = await upgradeRuntime();
          if (result?.upgraded) log(`  Upgraded the Pilot runtime from ${result.from} to ${result.to}.`);
          else if (result?.reason) log(`  Keeping the installed runtime: ${result.reason}.`);
        } catch (error) {
          log(`  Runtime upgrade failed — ${error.message}`);
        }
        plan = planDaemonStart({ transport, env, home });
      }
    }
    for (const warning of plan.warnings) log(`  Warning: ${warning}`);
    syncRecordedTransport(home, plan, log);
    const startArgs = ['daemon', 'start'];
    if (plan.mode === 'compat-proxy') {
      startArgs.push('--transport', 'compat');
      log(`  Egress proxy ${redactProxyURL(plan.proxy)} (${plan.source}): starting pilot-daemon with -transport=compat through it.`);
    } else if (plan.mode === 'proxy-unsupported') {
      log(`  Egress proxy ${redactProxyURL(plan.proxy)} is set and UDP is blocked, but ${plan.daemon ?? 'pilot-daemon'}`);
      log('  has no -proxy flag, so it cannot reach the Pilot registry through the proxy.');
      log(`  Update the Pilot runtime, or follow the pilot-sandbox skill: ${PILOT_SANDBOX_SKILL_URL}`);
    } else if (plan.transport === 'compat' && plan.transportSource === 'probe') {
      log('  No egress proxy is configured, so pilot-daemon starts with its default transport;');
      log('  setup applies compat mode automatically only behind a proxy (set PILOT_TRANSPORT=compat to force it).');
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
//   default            no proxy selected, or the transport is not compat:
//                      today's start
//   compat-proxy       proxy selected, transport compat, daemon has -proxy
//   proxy-unsupported  proxy selected, transport compat, daemon predates -proxy
//
// The transport is, as pilotctl resolves it: $PILOT_TRANSPORT, then a
// config.json "transport" the user (not setup) chose, then `transport`, the
// UDP probe's result. The proxy is the one the daemon itself will use: the
// config.json "proxy" key, then $PILOT_PROXY, then the proxy environment.
// A UDP transport returns before any proxy setting is read, so no proxy
// setting can affect a host that does not need a proxy.
export function planDaemonStart({ transport, env = process.env, daemon, home = homedir() } = {}) {
  const config = readPilotConfig(home).config ?? {};
  const effective = effectiveTransport(transport, env, config);
  const base = { transport: effective.transport, transportSource: effective.source, warnings: [] };
  if (effective.source === 'config.json' && isTransport(transport) && transport !== effective.transport) {
    base.warnings.push(`the UDP probe suggests "${transport}", but ${readPilotConfig(home).path} sets "transport": "${effective.transport}", which setup leaves as you chose it`);
  }
  if (effective.transport !== 'compat') return { mode: 'default', ...base };
  const spec = typeof config.proxy === 'string' ? config.proxy : undefined;
  const { proxy, warnings } = inspectProxy(env, { spec, specSource: 'config.json proxy' });
  base.warnings.push(...warnings.map((warning) => (warning.startsWith('config.json proxy ')
    ? `${warning}. pilotctl refuses to start the daemon with it; fix it or clear it with \`pilotctl config --set proxy=\``
    : warning)));
  if (!proxy) return { mode: 'default', ...base };
  const binary = daemon === undefined ? daemonBinaryPath(locatePilotctl(env), env) : daemon;
  return {
    mode: supportsEgressProxy(binary) ? 'compat-proxy' : 'proxy-unsupported',
    proxy: proxy.url,
    source: proxy.source,
    daemon: binary,
    ...base,
  };
}

function isTransport(transport) {
  return transport === 'udp' || transport === 'compat';
}

function effectiveTransport(probed, env, config) {
  const forced = String(env.PILOT_TRANSPORT ?? '').trim().toLowerCase();
  if (forced === 'udp' || forced === 'compat') return { transport: forced, source: 'PILOT_TRANSPORT' };
  const recorded = typeof config.transport === 'string' ? config.transport.trim() : '';
  if (recorded && !setupOwnsTransport(config)) return { transport: recorded, source: 'config.json' };
  return { transport: probed, source: 'probe' };
}

// syncRecordedTransport keeps setup's own "transport" entry in config.json in
// step with this run's plan. It is written only when the daemon must run in
// compat mode through a proxy, marked with "transport_set_by": "pilot-mcp",
// and removed by a later run that no longer needs it. A transport without
// that marker was chosen by the user or install.sh and is never touched.
function syncRecordedTransport(home, plan, log) {
  const { path, config, error } = readPilotConfig(home);
  if (!config) {
    log(`  Could not read ${path} (${error}); the transport is not recorded.`);
    return;
  }
  const owned = setupOwnsTransport(config);
  const wanted = plan.mode === 'compat-proxy' && plan.transportSource !== 'config.json';
  if (wanted) {
    if (owned) return;
    config.transport = 'compat';
    config.transport_set_by = SETUP_OWNER;
    writePilotConfig(home, config);
    log(`  Recorded "transport": "compat" in ${path}; setup removes it again once UDP works.`);
  } else if (owned) {
    delete config.transport;
    delete config.transport_set_by;
    writePilotConfig(home, config);
    log(`  Removed the "transport" setting an earlier setup recorded in ${path}; the daemon uses its default again.`);
  } else if ('transport_set_by' in config) {
    // The user changed or removed setup's entry since: theirs now.
    delete config.transport_set_by;
    writePilotConfig(home, config);
  }
}

function daemonEnvironment(env) {
  const forwarded = {};
  for (const name of DAEMON_PROXY_ENV) {
    if (env[name] !== undefined) forwarded[name] = env[name];
  }
  return forwarded;
}

// egressSummary reports what the daemon was started with. A probe result of
// "compat" only takes effect behind a proxy; otherwise the daemon runs its
// default transport (udp) unless $PILOT_TRANSPORT or config.json chose one.
function egressSummary(plan) {
  let transport = 'udp';
  if (plan.mode === 'compat-proxy') transport = 'compat';
  else if (plan.transportSource !== 'probe' && plan.transport) transport = plan.transport;
  const summary = { transport };
  if (plan.mode === 'default') return summary;
  return { ...summary, proxy: redactProxyURL(plan.proxy), proxy_supported: plan.mode === 'compat-proxy' };
}

function locatePilotctl(env) {
  try {
    return pilotctlBinaryPath(env);
  } catch {
    return null;
  }
}

function defaultLog(line) {
  process.stderr.write(`${line}\n`);
}
