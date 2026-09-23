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
//
// Setup plans with exactly what the daemon will read: $PILOT_PROXY and
// $PILOT_TRANSPORT are handed over normalized ("off" for every off alias,
// lower-case transports), and a value setup ignores is handed over empty,
// because pilot-daemon (or pilotctl) would refuse to start with it, on any
// transport. $PILOT_TRANSPORT counts only for a runtime that applies it.

import { homedir } from 'node:os';
import process from 'node:process';
import { daemonBinaryPath, execPilotctl, pilotctlBinaryPath, pilotctlJSON } from '../daemon-bridge.js';
import { daemonProxySetting, inspectProxy, parseProxySetting, redactProxyURL } from '../netproxy.js';
import { readPilotConfig, SETUP_OWNER, setupOwnsTransport, writePilotConfig } from './pilot-config.js';
import { managedNodeReason, supportsEgressProxy, upgradeRuntimeForProxy } from './runtime.js';

export const PILOT_SANDBOX_SKILL_URL = 'https://github.com/TeoSlayer/pilot-skills/tree/main/skills/pilot-sandbox';

// The raw-TCP registry `pilotctl init` and setup write into config.json, and
// the TLS registry compat mode uses on TCP/443.
const DEFAULT_REGISTRY = '34.71.57.205:9000';
const COMPAT_REGISTRY = 'registry.pilotprotocol.network:443';

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
    } else {
      for (const line of plan.compatHint ?? []) log(`  ${line}`);
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
// The transport is, as pilotctl resolves it: $PILOT_TRANSPORT (only when the
// runtime applies it), then a config.json "transport" the user (not setup)
// chose, then `transport`, the UDP probe's result. The proxy is the one the
// daemon itself will use: the config.json "proxy" key, then $PILOT_PROXY,
// then the proxy environment. A UDP transport returns before the proxy
// environment is read, so it cannot affect a host that does not need a
// proxy; settings the daemon refuses on any transport are still reported.
export function planDaemonStart({ transport, env = process.env, daemon, home = homedir() } = {}) {
  const { path: configPath, config: loaded } = readPilotConfig(home);
  const config = loaded ?? {};
  const warnings = daemonSettingWarnings(env, config, configPath);
  let binary = daemon;
  const daemonPath = () => {
    if (binary === undefined) binary = daemonBinaryPath(locatePilotctl(env), env);
    return binary;
  };
  let current;
  // A pilot-daemon with -proxy comes with the pilotctl that applies
  // $PILOT_TRANSPORT and --transport; released runtimes before it ignore both.
  const currentRuntime = () => (current ??= supportsEgressProxy(daemonPath()));
  const effective = effectiveTransport(transport, env, config, currentRuntime, warnings);
  const base = { transport: effective.transport, transportSource: effective.source, warnings };
  if (effective.source === 'config.json' && isTransport(transport) && transport !== effective.transport) {
    warnings.push(`the UDP probe suggests "${transport}", but ${configPath} sets "transport": "${effective.transport}", which setup leaves as you chose it`);
  }
  if (effective.transport !== 'compat') return { mode: 'default', ...base };
  const { proxy, warnings: proxyWarnings } = inspectProxy({ ...env, ...daemonSettingsEnv(env) }, {
    spec: configProxySpec(config),
    specSource: 'config.json proxy',
  });
  warnings.push(...proxyWarnings);
  if (!proxy) {
    return { mode: 'default', ...base, compatHint: effective.source === 'probe' ? compatHint(currentRuntime(), config) : undefined };
  }
  return {
    mode: currentRuntime() ? 'compat-proxy' : 'proxy-unsupported',
    proxy: proxy.url,
    source: proxy.source,
    daemon: daemonPath(),
    ...base,
  };
}

// daemonSettingsEnv is the $PILOT_PROXY / $PILOT_TRANSPORT the daemon gets
// from setup: normalized, or '' (unset) for a value setup ignores.
export function daemonSettingsEnv(env = process.env) {
  const settings = {};
  if (env.PILOT_PROXY !== undefined) settings.PILOT_PROXY = daemonProxySetting(env.PILOT_PROXY);
  if (env.PILOT_TRANSPORT !== undefined) settings.PILOT_TRANSPORT = transportSetting(env.PILOT_TRANSPORT);
  return settings;
}

// daemonSettingWarnings reports the settings pilot-daemon or pilotctl would
// refuse, whatever the transport, and what setup does about each.
export function daemonSettingWarnings(env, config, configPath) {
  const warnings = [];
  const proxyEnv = String(env.PILOT_PROXY ?? '').trim();
  const proxySetting = parseProxySetting(proxyEnv);
  if (proxySetting.mode === 'invalid') {
    warnings.push(`PILOT_PROXY is not a usable proxy setting (${proxySetting.error}); pilot-daemon would refuse it, so setup starts the daemon without it (auto). Use auto, off, or an http:// or https:// proxy URL.`);
  }
  const transportEnv = String(env.PILOT_TRANSPORT ?? '').trim();
  if (transportEnv && !transportSetting(transportEnv)) {
    warnings.push(`PILOT_TRANSPORT=${JSON.stringify(transportEnv.slice(0, 40))} is not udp or compat; setup ignores it and starts pilot-daemon without it.`);
  }
  if (typeof config.proxy === 'string' && config.proxy.trim()) {
    const value = config.proxy.trim();
    const setting = parseProxySetting(value);
    if (setting.mode === 'invalid') {
      warnings.push(`${configPath} has a "proxy" that is not a usable proxy setting (${setting.error}); pilotctl refuses to start the daemon with it. Set it with \`pilotctl config --set proxy=auto\` (or off, or an http:// URL), or clear it with \`pilotctl config --set proxy=\`.`);
    } else if (setting.mode !== 'explicit' && value !== setting.mode) {
      // Not a URL, so the value holds no credentials.
      warnings.push(`${configPath} has "proxy": ${JSON.stringify(value)}, which means "${setting.mode}", but pilotctl releases that know only "auto" and "off" refuse to start the daemon with it; set it with \`pilotctl config --set proxy=${setting.mode}\`.`);
    }
  }
  if (typeof config.transport === 'string' && config.transport.trim() && !isTransport(config.transport.trim())) {
    warnings.push(`${configPath} has "transport": ${JSON.stringify(config.transport.slice(0, 40))}, which is not "udp" or "compat"; pilot-daemon and pilotctl refuse to start with it. Fix it with \`pilotctl config --set transport=udp\` (or compat).`);
  }
  return warnings;
}

// configProxySpec is config.json's "proxy" when pilotctl would accept it
// (as far as setup can tell), otherwise undefined.
export function configProxySpec(config) {
  if (typeof config.proxy !== 'string') return undefined;
  return parseProxySetting(config.proxy).mode === 'invalid' ? undefined : config.proxy;
}

// compatHint tells a host that needs compat mode but has no proxy how to
// switch the installed runtime to it. Released runtimes before -proxy ignore
// $PILOT_TRANSPORT, and their pilotctl passes config.json's raw-TCP registry
// explicitly, which keeps a compat daemon off the TLS registry on :443.
function compatHint(current, config) {
  const lines = [
    'No egress proxy is in use, so pilot-daemon starts with its default transport (udp);',
    'setup switches to compat mode on its own only behind a proxy. For compat mode',
    '(WSS over TCP/443), run `pilotctl config --set transport=compat`',
  ];
  if (!current && String(config.registry ?? '').trim() === DEFAULT_REGISTRY) {
    lines.push(`and \`pilotctl config --set registry=${COMPAT_REGISTRY}\``);
    lines.push(`(this runtime hands config.json's registry to the daemon; set it back to ${DEFAULT_REGISTRY} for UDP),`);
  }
  lines.push('then restart the daemon: `pilotctl daemon stop && pilotctl daemon start`.');
  return lines;
}

function isTransport(transport) {
  return transport === 'udp' || transport === 'compat';
}

// transportSetting normalizes a $PILOT_TRANSPORT value the way pilot-daemon
// reads it (trimmed, any case): 'udp', 'compat', or '' for anything else.
function transportSetting(value) {
  const transport = String(value ?? '').trim().toLowerCase();
  return isTransport(transport) ? transport : '';
}

function effectiveTransport(probed, env, config, currentRuntime, warnings) {
  const recorded = typeof config.transport === 'string' ? config.transport.trim() : '';
  const chosen = isTransport(recorded) && !setupOwnsTransport(config) ? recorded : '';
  const forced = transportSetting(env.PILOT_TRANSPORT);
  if (forced) {
    if (currentRuntime()) return { transport: forced, source: 'PILOT_TRANSPORT' };
    // The daemon runs config.json's transport, or its default (udp).
    const runs = recorded && isTransport(recorded) ? recorded : 'udp';
    if (forced !== runs) {
      warnings.push(`PILOT_TRANSPORT=${forced} has no effect: the installed pilot-daemon predates it and runs ${runs}.`);
    }
  }
  if (chosen) return { transport: chosen, source: 'config.json' };
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
  return { ...forwarded, ...daemonSettingsEnv(env) };
}

// egressSummary reports what the daemon was started with. A probe result of
// "compat" only takes effect behind a proxy; otherwise the daemon runs its
// default transport (udp) unless config.json, or $PILOT_TRANSPORT on a
// runtime that applies it, chose one.
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
