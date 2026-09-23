// Daemon start behind an egress proxy (Meta Muse): with HTTPS_PROXY set and
// UDP blocked, a pilot-daemon that supports -proxy starts in compat mode
// through the proxy; an older daemon keeps today's start and points at the
// pilot-sandbox skill.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { daemonBinaryPath } from '../src/daemon-bridge.js';
import { installDaemon, PILOT_SANDBOX_SKILL_URL, planDaemonStart } from '../src/setup/daemon.js';
import { daemonFeatures, supportsEgressProxy } from '../src/setup/runtime.js';
import { probeTransport } from '../src/setup/transport.js';

const PROXY = 'http://muse-agent:s3cr3t@proxy.muse.internal:3128';
const REDACTED = 'http://***@proxy.muse.internal:3128';
const skip = process.platform === 'win32' ? 'fake runtimes are POSIX shell scripts' : false;

// execPilotctl resolves pilotctl from the process environment.
const originalPilotctl = process.env.PILOTCTL_BIN;
after(() => {
  if (originalPilotctl === undefined) delete process.env.PILOTCTL_BIN;
  else process.env.PILOTCTL_BIN = originalPilotctl;
});

const PROXY_USAGE = `Usage of pilot-daemon:
  -proxy string
    \tegress proxy: auto, off, or http(s)://[user:pass@]host:port (default "auto")
  -transport string
    \ttunnel transport: 'udp' (default) or 'compat' (default "udp")
`;
// A runtime with -transport=auto (web4 feat/native-https-proxy a3ed59f4),
// trimmed to the flags that matter; its install.sh saves "transport": "auto".
const AUTO_USAGE = `Usage of pilot-daemon:
  -compat-beacon string
    \tbeacon WSS URL for -transport=compat (default "wss://beacon.pilotprotocol.network/v1/compat")
  -proxy string
    \toutbound proxy for registry, beacon and HTTP connections: 'auto' (the default: with compat, HTTPS_PROXY/ALL_PROXY from the environment, honoring NO_PROXY; nothing with udp), 'off' (also none, no, false, direct), or an http:// or https:// proxy URL, http://[user:pass@]host:port, used for every connection except loopback. Precedence: this flag, $PILOT_PROXY, config.json "proxy", auto.
  -transport string
    \ttunnel transport: 'udp' (the default), 'compat' (registry over TLS and beacon over WSS, TCP 443 only, for UDP-blocked or proxy-only hosts) or 'auto' (udp when the beacon answers over UDP, otherwise compat when TCP 443 is reachable, through the proxy if there is one). Precedence: this flag, $PILOT_TRANSPORT, config.json "transport", udp.
  -trust-auto-approve
    \tauto-approve all incoming handshake requests
`;
const LEGACY_USAGE = `Usage of pilot-daemon:
  -registry-tls
    \tuse TLS for registry connection
  -transport string
    \ttunnel transport: 'udp' (default) or 'compat' (default "udp")
`;

test('proxy with UDP blocked starts the daemon in compat mode through the proxy', { skip }, async (t) => {
  const fx = fixture(t, PROXY_USAGE);
  const lines = [];
  const result = await installDaemon({
    transport: 'compat',
    autoStart: true,
    env: fx.env({ HTTPS_PROXY: PROXY, NO_PROXY: 'localhost' }),
    home: fx.home,
    log: (line) => lines.push(line),
    upgradeRuntime: () => assert.fail('a proxy-capable runtime must not be replaced'),
  });
  const calls = fx.calls();
  // No --proxy: the daemon's own -proxy default is auto, and a flag would
  // override a config.json "proxy" or $PILOT_PROXY the user chose.
  assert.deepEqual(calls[0].args, ['daemon', 'start', '--transport', 'compat']);
  assert.equal(calls[0].env.HTTPS_PROXY, PROXY);
  assert.equal(calls[0].env.NO_PROXY, 'localhost');
  const config = JSON.parse(readFileSync(fx.config, 'utf8'));
  assert.equal(config.transport, 'compat');
  assert.equal(config.transport_set_by, 'pilot-mcp');
  assert.equal(config.registry, '34.71.57.205:9000');
  assert.equal(config.proxy, undefined);
  assert.equal(result.trust_verified, true);
  assert.equal(result.transport, 'compat');
  assert.equal(result.proxy, REDACTED);
  assert.equal(result.proxy_supported, true);
  assert.match(lines.join('\n'), /Egress proxy http:\/\/\*\*\*@proxy\.muse\.internal:3128 \(HTTPS_PROXY\): starting pilot-daemon with -transport=compat through it/);
  assert.doesNotMatch(`${lines.join('\n')}${readFileSync(fx.config, 'utf8')}`, /s3cr3t|muse-agent/);
});

test('an explicit PILOT_PROXY reaches the daemon through the environment, not a flag', { skip }, async (t) => {
  const fx = fixture(t, PROXY_USAGE);
  await installDaemon({
    transport: 'compat',
    autoStart: true,
    env: fx.env({ PILOT_PROXY: PROXY }),
    home: fx.home,
    log: () => {},
  });
  const [start] = fx.calls();
  assert.deepEqual(start.args, ['daemon', 'start', '--transport', 'compat']);
  assert.equal(start.env.PILOT_PROXY, PROXY);
});

test('a daemon without -proxy keeps today\'s start and points at the pilot-sandbox skill', { skip }, async (t) => {
  const fx = fixture(t, LEGACY_USAGE);
  const lines = [];
  let upgrades = 0;
  const result = await installDaemon({
    transport: 'compat',
    autoStart: true,
    env: fx.env({ HTTPS_PROXY: PROXY }),
    home: fx.home,
    log: (line) => lines.push(line),
    upgradeRuntime: async () => { upgrades += 1; },
  });
  assert.equal(upgrades, 1);
  assert.deepEqual(fx.calls()[0].args, ['daemon', 'start']);
  assert.equal(JSON.parse(readFileSync(fx.config, 'utf8')).transport, undefined);
  assert.equal(result.proxy, REDACTED);
  assert.equal(result.proxy_supported, false);
  const output = lines.join('\n');
  assert.ok(output.includes(PILOT_SANDBOX_SKILL_URL), output);
  assert.match(output, /has no -proxy flag/);
  assert.doesNotMatch(output, /s3cr3t|muse-agent/);
});

test('a runtime upgrade that adds -proxy switches the start to compat through the proxy', { skip }, async (t) => {
  const fx = fixture(t, LEGACY_USAGE);
  await installDaemon({
    transport: 'compat',
    autoStart: true,
    env: fx.env({ HTTPS_PROXY: PROXY }),
    home: fx.home,
    log: () => {},
    upgradeRuntime: async () => fx.writeDaemon(PROXY_USAGE),
  });
  assert.deepEqual(fx.calls()[0].args, ['daemon', 'start', '--transport', 'compat']);
});

test('managed nodes never swap their pinned runtime for proxy support', { skip }, async (t) => {
  const fx = fixture(t, LEGACY_USAGE);
  await installDaemon({
    transport: 'compat',
    autoStart: true,
    enterpriseControl: '/secure/control.json',
    env: fx.env({ HTTPS_PROXY: PROXY }),
    home: fx.home,
    log: () => {},
    upgradeRuntime: () => assert.fail('managed runtimes are pinned'),
  });
  const start = fx.calls().find((call) => call.args[1] === 'start');
  assert.deepEqual(start.args, ['daemon', 'start', '--enterprise-control', '/secure/control.json']);
});

test('a node adopted on an earlier run keeps its pinned runtime without --managed-url', { skip }, async (t) => {
  for (const [name, adopt, evidence] of [
    ['runtime tag', (fx) => {
      mkdirSync(join(fx.home, '.pilot', 'bin'), { recursive: true });
      writeFileSync(join(fx.home, '.pilot', 'bin', '.pilot-version'), 'managed-runtime-v0.1.5\n');
    }, /runtime managed-runtime-v0\.1\.5/],
    ['control attachment', (fx) => {
      mkdirSync(join(fx.home, '.pilot', 'managed'), { recursive: true });
      writeFileSync(join(fx.home, '.pilot', 'managed', 'enterprise-control.json'), '{}', { mode: 0o600 });
    }, /enterprise control attachment/],
    ['config key', (fx) => {
      const config = JSON.parse(readFileSync(fx.config, 'utf8'));
      writeFileSync(fx.config, JSON.stringify({ ...config, enterprise_control: '/secure/control.json' }));
    }, /config\.json enterprise_control/],
  ]) {
    const fx = fixture(t, LEGACY_USAGE);
    adopt(fx);
    const lines = [];
    await installDaemon({
      transport: 'compat',
      autoStart: true,
      env: fx.env({ HTTPS_PROXY: PROXY }),
      home: fx.home,
      log: (line) => lines.push(line),
      upgradeRuntime: () => assert.fail(`managed runtimes are pinned (${name})`),
    });
    assert.deepEqual(fx.calls()[0].args, ['daemon', 'start'], name);
    assert.match(lines.join('\n'), evidence, name);
    assert.match(lines.join('\n'), /pinned runtime is kept/, name);
  }
  // PILOT_ENTERPRISE_CONTROL (set by setup after hosted enrollment) counts too.
  const fx = fixture(t, LEGACY_USAGE);
  await installDaemon({
    transport: 'compat',
    autoStart: true,
    env: fx.env({ HTTPS_PROXY: PROXY, PILOT_ENTERPRISE_CONTROL: '/secure/control.json' }),
    home: fx.home,
    log: () => {},
    upgradeRuntime: () => assert.fail('managed runtimes are pinned (env)'),
  });
});

test('the upgrade outcome is reported, and a kept runtime still gets the pilot-sandbox pointer', { skip }, async (t) => {
  const fx = fixture(t, LEGACY_USAGE);
  const lines = [];
  const result = await installDaemon({
    transport: 'compat',
    autoStart: true,
    env: fx.env({ HTTPS_PROXY: PROXY }),
    home: fx.home,
    log: (line) => lines.push(line),
    upgradeRuntime: async () => ({ upgraded: false, reason: 'the latest stable release v1.13.9 does not support -proxy yet' }),
  });
  const output = lines.join('\n');
  assert.match(output, /Keeping the installed runtime: the latest stable release v1\.13\.9 does not support -proxy yet\./);
  assert.ok(output.includes(PILOT_SANDBOX_SKILL_URL), output);
  assert.equal(result.proxy_supported, false);
  assert.deepEqual(fx.calls()[0].args, ['daemon', 'start']);
});

test('without a proxy, with UDP available, or with PILOT_PROXY=off the start is unchanged', { skip }, async (t) => {
  for (const [transport, extra] of [
    ['compat', {}],
    ['udp', { HTTPS_PROXY: PROXY }],
    ['compat', { HTTPS_PROXY: PROXY, PILOT_PROXY: 'off' }],
  ]) {
    const fx = fixture(t, PROXY_USAGE);
    const result = await installDaemon({
      transport, autoStart: true, env: fx.env(extra), home: fx.home, log: () => {},
      upgradeRuntime: () => assert.fail('no upgrade without a proxy need'),
    });
    assert.deepEqual(fx.calls()[0].args, ['daemon', 'start'], `${transport} ${JSON.stringify(extra)}`);
    assert.equal(JSON.parse(readFileSync(fx.config, 'utf8')).transport, undefined);
    assert.equal(result.proxy, undefined);
    // The summary reports what the daemon runs, not the probe's guess.
    assert.equal(result.transport, 'udp');
  }
});

test('planDaemonStart only routes through the proxy when UDP is blocked', { skip }, (t) => {
  const fx = fixture(t, PROXY_USAGE);
  const home = fx.home;
  assert.equal(planDaemonStart({ transport: 'udp', env: { HTTPS_PROXY: PROXY }, home }).mode, 'default');
  assert.equal(planDaemonStart({ transport: 'compat', env: {}, home }).mode, 'default');
  const plan = planDaemonStart({ transport: 'compat', env: fx.env({ https_proxy: PROXY }), home });
  assert.equal(plan.mode, 'compat-proxy');
  assert.equal(plan.source, 'https_proxy');
  assert.equal(plan.daemon, fx.daemon);
  assert.equal(planDaemonStart({ transport: 'compat', env: { HTTPS_PROXY: PROXY }, daemon: null, home }).mode, 'proxy-unsupported');
  // $PILOT_TRANSPORT decides before the probe, as it does for pilotctl.
  assert.equal(planDaemonStart({ transport: 'udp', env: fx.env({ HTTPS_PROXY: PROXY, PILOT_TRANSPORT: 'compat' }), home }).mode, 'compat-proxy');
  assert.equal(planDaemonStart({ transport: 'compat', env: fx.env({ HTTPS_PROXY: PROXY, PILOT_TRANSPORT: 'udp' }), home }).mode, 'default');
});

test('an unusable proxy setting never blocks a UDP host and never throws', { skip }, async (t) => {
  for (const extra of [
    { PILOT_PROXY: 'socks5://proxy:1080' },
    { PILOT_PROXY: 'proxy.corp:3128' },
    { HTTPS_PROXY: 'socks5://proxy:1080', ALL_PROXY: PROXY },
  ]) {
    const fx = fixture(t, PROXY_USAGE);
    const result = await installDaemon({
      transport: 'udp', autoStart: true, env: fx.env(extra), home: fx.home, log: () => {},
      upgradeRuntime: () => assert.fail('no upgrade on a UDP host'),
    });
    assert.deepEqual(fx.calls()[0].args, ['daemon', 'start'], JSON.stringify(extra));
    assert.equal(result.trust_verified, true);
    assert.doesNotThrow(() => planDaemonStart({ transport: 'compat', env: fx.env(extra), home: fx.home }));
  }
  // Go's netproxy takes the first non-empty variable, so an unusable
  // HTTPS_PROXY means no proxy (with a warning) rather than ALL_PROXY.
  const fx = fixture(t, PROXY_USAGE);
  const lines = [];
  await installDaemon({
    transport: 'compat', autoStart: true, env: fx.env({ HTTPS_PROXY: 'socks5://u:s3cr3t@proxy:1080', ALL_PROXY: PROXY }),
    home: fx.home, log: (line) => lines.push(line),
  });
  assert.deepEqual(fx.calls()[0].args, ['daemon', 'start']);
  assert.match(lines.join('\n'), /Warning: HTTPS_PROXY is not a usable proxy \(unsupported scheme "socks5"/);
  assert.doesNotMatch(lines.join('\n'), /s3cr3t/);
});

test('an unusable proxy setting never blocks a UDP host and never throws, and is kept from the daemon', { skip }, async (t) => {
  // Setup ignores these, so the daemon, which would refuse them (or, before
  // it validated them, take a bare word as the proxy host), never sees them.
  for (const value of ['socks5://127.0.0.1:1080', 'proxy.corp:3128', 'nonee']) {
    for (const [transport, extra] of [['udp', {}], ['compat', { HTTPS_PROXY: PROXY }]]) {
      const fx = fixture(t, PROXY_USAGE);
      const lines = [];
      const result = await installDaemon({
        transport, autoStart: true, env: fx.env({ PILOT_PROXY: value, ...extra }), home: fx.home, log: (line) => lines.push(line),
      });
      const [start] = fx.calls();
      const label = `${value} ${transport}`;
      assert.equal(start.env.PILOT_PROXY, '', label);
      assert.equal(result.trust_verified, true, label);
      assert.match(lines.join('\n'), /Warning: PILOT_PROXY is not a usable proxy setting .*setup starts the daemon without it \(auto\)/, label);
      // Behind a proxy, auto applies: compat through HTTPS_PROXY.
      assert.deepEqual(start.args, transport === 'udp' ? ['daemon', 'start'] : ['daemon', 'start', '--transport', 'compat'], label);
      if (transport === 'compat') assert.equal(result.proxy, REDACTED, label);
    }
  }
});

test('PILOT_PROXY off aliases reach the daemon as "off", on every transport', { skip }, async (t) => {
  for (const value of ['none', 'NONE', 'no', 'false', 'direct', 'Off']) {
    for (const [transport, extra] of [['udp', {}], ['compat', { HTTPS_PROXY: PROXY }]]) {
      const fx = fixture(t, PROXY_USAGE);
      const lines = [];
      const result = await installDaemon({
        transport, autoStart: true, env: fx.env({ PILOT_PROXY: value, ...extra }), home: fx.home, log: (line) => lines.push(line),
        upgradeRuntime: () => assert.fail('no proxy is in use'),
      });
      const [start] = fx.calls();
      const label = `${value} ${transport}`;
      // Before this, the daemon got "none" and dialed everything through http://none.
      assert.equal(start.env.PILOT_PROXY, 'off', label);
      assert.deepEqual(start.args, ['daemon', 'start'], label);
      assert.equal(result.proxy, undefined, label);
      assert.equal(result.trust_verified, true, label);
      assert.doesNotMatch(lines.join('\n'), /Warning/, label);
    }
  }
  // Valid settings pass through as they are; an unset one stays unset.
  const fx = fixture(t, PROXY_USAGE);
  await installDaemon({ transport: 'udp', autoStart: true, env: fx.env({ PILOT_PROXY: ' AUTO ' }), home: fx.home, log: () => {} });
  await installDaemon({ transport: 'udp', autoStart: true, env: fx.env({}), home: fx.home, log: () => {} });
  assert.deepEqual(fx.calls().filter((call) => call.args[0] === 'daemon').map((call) => call.env.PILOT_PROXY), ['auto', '<unset>']);
});

test('PILOT_TRANSPORT reaches pilotctl normalized, and an unusable one not at all', { skip }, async (t) => {
  for (const [value, forwarded, warned] of [['COMPAT', 'compat', false], [' udp ', 'udp', false], ['tcp', '', true]]) {
    const fx = fixture(t, PROXY_USAGE);
    const lines = [];
    const result = await installDaemon({ transport: 'udp', autoStart: true, env: fx.env({ PILOT_TRANSPORT: value }), home: fx.home, log: (line) => lines.push(line) });
    const [start] = fx.calls();
    assert.equal(start.env.PILOT_TRANSPORT, forwarded, value);
    assert.equal(result.trust_verified, true, value);
    if (warned) assert.match(lines.join('\n'), /Warning: PILOT_TRANSPORT="tcp" is not udp, compat or auto; setup ignores it/);
    else assert.doesNotMatch(lines.join('\n'), /Warning/, value);
  }
});

test('a config.json "proxy" that pilotctl refuses is reported, whatever the transport', { skip }, async (t) => {
  const withProxyKey = (fx, value) => {
    const config = JSON.parse(readFileSync(fx.config, 'utf8'));
    writeFileSync(fx.config, JSON.stringify({ ...config, proxy: value }));
  };
  for (const [value, pattern] of [
    ['none', /"proxy": "none", which means "off", but pilotctl releases that know only "auto" and "off" refuse.*pilotctl config --set proxy=off/],
    ['OFF', /"proxy": "OFF", which means "off".*pilotctl config --set proxy=off/],
    ['Auto', /"proxy": "Auto", which means "auto".*pilotctl config --set proxy=auto/],
    ['proxy.corp:3128', /has a "proxy" that is not a usable proxy setting \(not auto, off, or an http:\/\/ or https:\/\/ proxy URL\); pilotctl refuses/],
  ]) {
    for (const transport of ['udp', 'compat']) {
      const fx = fixture(t, PROXY_USAGE);
      withProxyKey(fx, value);
      const plan = planDaemonStart({ transport, env: fx.env({ HTTPS_PROXY: PROXY }), home: fx.home });
      assert.match(plan.warnings.join('\n'), pattern, `${value} ${transport}`);
      assert.equal(JSON.parse(readFileSync(fx.config, 'utf8')).proxy, value);
    }
  }
  // An alias pilotctl may refuse still plans as what it means.
  const fx = fixture(t, PROXY_USAGE);
  withProxyKey(fx, 'none');
  assert.equal(planDaemonStart({ transport: 'compat', env: fx.env({ HTTPS_PROXY: PROXY }), home: fx.home }).mode, 'default');
  // "auto", "off" and a URL are accepted everywhere: no warning.
  for (const value of ['auto', 'off', 'http://egress2.corp:8080']) {
    withProxyKey(fx, value);
    assert.deepEqual(planDaemonStart({ transport: 'udp', env: fx.env({}), home: fx.home }).warnings, [], value);
  }
});

test('compat without a proxy: the hint and the summary match what the installed runtime does', { skip }, async (t) => {
  // A released runtime before -proxy (v1.13.9) ignores PILOT_TRANSPORT: its
  // daemon's -transport defaults to udp. Only config.json switches it, and
  // its pilotctl passes config.json's raw-TCP registry explicitly.
  let fx = fixture(t, LEGACY_USAGE);
  let lines = [];
  let result = await installDaemon({
    transport: 'compat', autoStart: true, env: fx.env({ PILOT_TRANSPORT: 'compat' }), home: fx.home, log: (line) => lines.push(line),
    upgradeRuntime: () => assert.fail('no proxy need'),
  });
  let output = lines.join('\n');
  assert.equal(result.transport, 'udp');
  assert.deepEqual(fx.calls()[0].args, ['daemon', 'start']);
  assert.match(output, /Warning: PILOT_TRANSPORT=compat has no effect: the installed pilot-daemon predates it and runs udp/);
  assert.match(output, /pilotctl config --set transport=compat/);
  assert.match(output, /pilotctl config --set registry=registry\.pilotprotocol\.network:443/);
  assert.match(output, /pilotctl daemon stop && pilotctl daemon start/);
  assert.doesNotMatch(output, /set PILOT_TRANSPORT=compat/);

  // Once config.json says compat, that runtime runs compat, and says so.
  writeFileSync(fx.config, JSON.stringify({ ...JSON.parse(readFileSync(fx.config, 'utf8')), transport: 'compat' }));
  lines = [];
  result = await installDaemon({ transport: 'compat', autoStart: true, env: fx.env({ PILOT_TRANSPORT: 'compat' }), home: fx.home, log: (line) => lines.push(line) });
  assert.equal(result.transport, 'compat');
  assert.doesNotMatch(lines.join('\n'), /has no effect|pilotctl config --set transport/);

  // The probe alone on that runtime: the same hint, no PILOT_TRANSPORT advice.
  fx = fixture(t, LEGACY_USAGE);
  lines = [];
  result = await installDaemon({ transport: 'compat', autoStart: true, env: fx.env({}), home: fx.home, log: (line) => lines.push(line) });
  output = lines.join('\n');
  assert.equal(result.transport, 'udp');
  assert.match(output, /No egress proxy is in use.*\n.*\n.*pilotctl config --set transport=compat/);
  assert.match(output, /pilotctl config --set registry=registry\.pilotprotocol\.network:443/);
  assert.doesNotMatch(output, /PILOT_TRANSPORT/);

  // A runtime with -proxy applies PILOT_TRANSPORT, so compat is what runs.
  fx = fixture(t, PROXY_USAGE);
  lines = [];
  result = await installDaemon({ transport: 'compat', autoStart: true, env: fx.env({ PILOT_TRANSPORT: 'compat' }), home: fx.home, log: (line) => lines.push(line) });
  assert.equal(result.transport, 'compat');
  assert.equal(fx.calls()[0].env.PILOT_TRANSPORT, 'compat');
  assert.doesNotMatch(lines.join('\n'), /has no effect|pilotctl config --set/);

  // And its pilotctl leaves the default registry out in compat mode itself.
  fx = fixture(t, PROXY_USAGE);
  lines = [];
  result = await installDaemon({ transport: 'compat', autoStart: true, env: fx.env({}), home: fx.home, log: (line) => lines.push(line) });
  output = lines.join('\n');
  assert.equal(result.transport, 'udp');
  assert.match(output, /pilotctl config --set transport=compat/);
  assert.doesNotMatch(output, /registry=|PILOT_TRANSPORT/);
});

test('the daemon\'s config.json "proxy" key is honoured, never overridden', { skip }, async (t) => {
  const withProxyKey = (fx, value) => {
    const config = JSON.parse(readFileSync(fx.config, 'utf8'));
    writeFileSync(fx.config, JSON.stringify({ ...config, proxy: value }));
  };
  // "off" in config.json beats HTTPS_PROXY: setup does not route the daemon
  // through a proxy the daemon will not use.
  let fx = fixture(t, PROXY_USAGE);
  withProxyKey(fx, 'off');
  let result = await installDaemon({ transport: 'compat', autoStart: true, env: fx.env({ HTTPS_PROXY: PROXY }), home: fx.home, log: () => {} });
  assert.deepEqual(fx.calls()[0].args, ['daemon', 'start']);
  assert.equal(result.proxy, undefined);
  assert.equal(JSON.parse(readFileSync(fx.config, 'utf8')).proxy, 'off');

  // An explicit proxy in config.json is the one the daemon uses, even with
  // HTTPS_PROXY and PILOT_PROXY pointing elsewhere.
  fx = fixture(t, PROXY_USAGE);
  withProxyKey(fx, 'http://egress2.corp:8080');
  const lines = [];
  result = await installDaemon({
    transport: 'compat', autoStart: true, env: fx.env({ HTTPS_PROXY: PROXY, PILOT_PROXY: 'http://other:1' }), home: fx.home, log: (line) => lines.push(line),
  });
  assert.deepEqual(fx.calls()[0].args, ['daemon', 'start', '--transport', 'compat']);
  assert.equal(result.proxy, 'http://egress2.corp:8080');
  assert.match(lines.join('\n'), /\(config\.json proxy\)/);
  assert.equal(JSON.parse(readFileSync(fx.config, 'utf8')).proxy, 'http://egress2.corp:8080');

  // An unusable config.json "proxy" is reported (pilotctl rejects it), not
  // silently replaced, and never echoed with its credentials.
  fx = fixture(t, PROXY_USAGE);
  withProxyKey(fx, 'socks5://u:s3cr3t@egress:1080');
  const plan = planDaemonStart({ transport: 'compat', env: fx.env({ HTTPS_PROXY: PROXY }), home: fx.home });
  assert.equal(plan.mode, 'compat-proxy');
  assert.equal(plan.source, 'HTTPS_PROXY');
  assert.match(plan.warnings.join('\n'), /config\.json has a "proxy" that is not a usable proxy setting \(unsupported scheme "socks5".*pilotctl refuses to start the daemon.*pilotctl config --set proxy=/);
  assert.doesNotMatch(plan.warnings.join('\n'), /s3cr3t/);
});

test('a runtime with -transport=auto takes PILOT_PROXY over config.json "proxy", as its pilotctl and daemon do', { skip }, async (t) => {
  const env = { HTTPS_PROXY: PROXY, PILOT_PROXY: 'http://u:s3cr3t@egress.corp:3128' };
  let fx = fixture(t, AUTO_USAGE);
  withConfig(fx, { proxy: 'off' });
  let plan = planDaemonStart({ transport: 'compat', env: fx.env(env), home: fx.home });
  assert.equal(plan.mode, 'auto');
  assert.equal(plan.source, 'PILOT_PROXY');
  assert.equal(plan.proxy.hostname, 'egress.corp');
  // Without PILOT_PROXY, config.json's "off" holds.
  plan = planDaemonStart({ transport: 'compat', env: fx.env({ HTTPS_PROXY: PROXY }), home: fx.home });
  assert.equal(plan.proxy, undefined);
  // -proxy runtimes before auto let config.json win.
  fx = fixture(t, PROXY_USAGE);
  withConfig(fx, { proxy: 'off' });
  plan = planDaemonStart({ transport: 'compat', env: fx.env(env), home: fx.home });
  assert.equal(plan.mode, 'default');
  assert.equal(plan.proxy, undefined);
});

test('setup records compat only as its own entry, and removes it once UDP works', { skip }, async (t) => {
  const fx = fixture(t, PROXY_USAGE);
  const readConfig = () => JSON.parse(readFileSync(fx.config, 'utf8'));
  const run = (transport, extra = { HTTPS_PROXY: PROXY }) => installDaemon({
    transport, autoStart: true, env: fx.env(extra), home: fx.home, log: () => {},
  });

  await run('compat');
  assert.equal(readConfig().transport, 'compat');
  assert.equal(readConfig().transport_set_by, 'pilot-mcp');

  // A later setup on a network where UDP works undoes it.
  await run('udp');
  assert.equal(readConfig().transport, undefined);
  assert.equal(readConfig().transport_set_by, undefined);
  assert.equal(readConfig().email, 'agent@example.com');

  // So does one where the proxy requirement is gone.
  await run('compat');
  assert.equal(readConfig().transport, 'compat');
  await run('compat', {});
  assert.equal(readConfig().transport, undefined);

  // Once the user changes setup's entry (pilotctl config --set transport=udp)
  // it is theirs: kept, and the stale marker is dropped.
  await run('compat');
  writeFileSync(fx.config, JSON.stringify({ ...readConfig(), transport: 'udp' }));
  await run('compat');
  assert.equal(readConfig().transport, 'udp');
  assert.equal(readConfig().transport_set_by, undefined);
});

test('a transport the user or install.sh chose is never changed', { skip }, async (t) => {
  for (const chosen of ['compat', 'udp']) {
    const fx = fixture(t, PROXY_USAGE);
    const config = JSON.parse(readFileSync(fx.config, 'utf8'));
    writeFileSync(fx.config, JSON.stringify({ ...config, transport: chosen }));
    for (const probed of ['udp', 'compat']) {
      const lines = [];
      const result = await installDaemon({
        transport: probed, autoStart: true, env: fx.env({ HTTPS_PROXY: PROXY }), home: fx.home, log: (line) => lines.push(line),
      });
      const saved = JSON.parse(readFileSync(fx.config, 'utf8'));
      assert.equal(saved.transport, chosen, `${chosen}/${probed}`);
      assert.equal(saved.transport_set_by, undefined, `${chosen}/${probed}`);
      assert.equal(result.transport, chosen, `${chosen}/${probed}`);
      if (chosen !== probed) assert.match(lines.join('\n'), /which setup leaves as you chose it/);
    }
    const starts = fx.calls().map((call) => call.args).filter((args) => args[0] === 'daemon');
    const expected = chosen === 'compat' ? ['daemon', 'start', '--transport', 'compat'] : ['daemon', 'start'];
    assert.deepEqual(starts, [expected, expected], chosen);
  }
});

test('the "transport": "auto" install.sh saves is valid, kept, and left to the daemon', { skip }, async (t) => {
  for (const saved of ['auto', 'AUTO', ' Auto ']) {
    for (const [probed, extra] of [['udp', {}], ['compat', { HTTPS_PROXY: PROXY }], ['compat', {}]]) {
      const label = `${JSON.stringify(saved)} ${probed} ${extra.HTTPS_PROXY ? 'proxy' : 'direct'}`;
      const fx = fixture(t, AUTO_USAGE);
      withConfig(fx, { transport: saved });
      const lines = [];
      const result = await installDaemon({
        transport: probed, autoStart: true, env: fx.env(extra), home: fx.home, log: (line) => lines.push(line),
        upgradeRuntime: () => assert.fail('a runtime with -transport=auto must not be replaced'),
      });
      const output = lines.join('\n');
      assert.doesNotMatch(output, /Warning|Recorded/, label);
      // No --transport: pilotctl hands the daemon config.json's auto.
      assert.deepEqual(fx.calls()[0].args, ['daemon', 'start'], label);
      assert.equal(fx.calls()[0].env.PILOT_TRANSPORT, '<unset>', label);
      assert.equal(readConfig(fx).transport, saved, label);
      assert.equal(readConfig(fx).transport_set_by, undefined, label);
      assert.equal(result.trust_verified, true, label);
      assert.equal(result.transport, 'auto', label);
      if (extra.HTTPS_PROXY) {
        assert.equal(result.proxy, REDACTED, label);
        assert.equal(result.proxy_supported, true, label);
        assert.match(output, /Egress proxy http:\/\/\*\*\*@proxy\.muse\.internal:3128 \(HTTPS_PROXY\): pilot-daemon picks its transport itself \(-transport=auto\) and, with UDP blocked, runs compat through it/, label);
      } else {
        assert.equal(result.proxy, undefined, label);
        if (probed === 'compat') assert.match(output, /picks its transport itself on every start \(-transport=auto\)/, label);
        assert.doesNotMatch(output, /pilotctl config --set/, label);
      }
      assert.doesNotMatch(output, /s3cr3t|muse-agent/, label);
    }
  }
});

test('"transport": "auto" on a runtime that predates it is reported, and never overwritten', { skip }, async (t) => {
  for (const usage of [PROXY_USAGE, LEGACY_USAGE]) {
    const fx = fixture(t, usage);
    withConfig(fx, { transport: 'auto' });
    const lines = [];
    const result = await installDaemon({
      transport: 'compat', autoStart: true, env: fx.env({ HTTPS_PROXY: PROXY }), home: fx.home, log: (line) => lines.push(line),
      upgradeRuntime: () => ({ upgraded: false, reason: 'test' }),
    });
    const output = lines.join('\n');
    assert.match(output, /config\.json has "transport": "auto", but the installed pilot-daemon predates -transport=auto and cannot start with it\. Update the Pilot runtime/);
    assert.equal(readConfig(fx).transport, 'auto');
    assert.equal(readConfig(fx).transport_set_by, undefined);
    assert.doesNotMatch(output, /Recorded/);
    if (usage === PROXY_USAGE) {
      // This start still gets through the proxy; --transport beats config.json.
      assert.deepEqual(fx.calls()[0].args, ['daemon', 'start', '--transport', 'compat']);
      assert.equal(result.transport, 'compat');
    } else {
      assert.equal(result.proxy_supported, false);
    }
  }
  // A value no runtime accepts is reported and left alone too, even when this
  // start runs compat through the proxy.
  const fx = fixture(t, PROXY_USAGE);
  withConfig(fx, { transport: 'tcp' });
  const lines = [];
  await installDaemon({ transport: 'compat', autoStart: true, env: fx.env({ HTTPS_PROXY: PROXY }), home: fx.home, log: (line) => lines.push(line) });
  assert.match(lines.join('\n'), /"transport": "tcp", which is not "udp", "compat" or "auto"; .*pilotctl config --set transport=udp` \(or compat\)/);
  assert.deepEqual(fx.calls()[0].args, ['daemon', 'start', '--transport', 'compat']);
  assert.equal(readConfig(fx).transport, 'tcp');
  assert.equal(readConfig(fx).transport_set_by, undefined);
});

test('config.json transports are read in any case only by a runtime with -transport=auto', { skip }, async (t) => {
  let fx = fixture(t, AUTO_USAGE);
  withConfig(fx, { transport: 'Compat' });
  let plan = planDaemonStart({ transport: 'udp', env: fx.env({ HTTPS_PROXY: PROXY }), home: fx.home });
  assert.equal(plan.transport, 'compat');
  assert.equal(plan.transportSource, 'config.json');
  assert.equal(plan.mode, 'compat-proxy');
  assert.doesNotMatch(plan.warnings.join('\n'), /which means/);
  fx = fixture(t, PROXY_USAGE);
  withConfig(fx, { transport: 'Compat' });
  plan = planDaemonStart({ transport: 'udp', env: fx.env({ HTTPS_PROXY: PROXY }), home: fx.home });
  assert.equal(plan.transportSource, 'probe');
  assert.match(plan.warnings.join('\n'), /"transport": "Compat", which means "compat", but pilot-daemon and pilotctl releases before -transport=auto refuse it; set it with `pilotctl config --set transport=compat`/);
  // An unusable value on a runtime with auto: the fix names auto first.
  fx = fixture(t, AUTO_USAGE);
  withConfig(fx, { transport: 'quic' });
  plan = planDaemonStart({ transport: 'udp', env: fx.env({}), home: fx.home });
  assert.match(plan.warnings.join('\n'), /"transport": "quic", which is not "udp", "compat" or "auto".*pilotctl config --set transport=auto` \(or udp, or compat\)/);
});

test('PILOT_TRANSPORT=auto is passed on as auto where the runtime takes it, and beats config.json', { skip }, async (t) => {
  // A runtime with -transport=auto: passed on, and it beats a config.json udp.
  let fx = fixture(t, AUTO_USAGE);
  withConfig(fx, { transport: 'udp' });
  let lines = [];
  let result = await installDaemon({
    transport: 'compat', autoStart: true, env: fx.env({ PILOT_TRANSPORT: ' AUTO ', HTTPS_PROXY: PROXY }), home: fx.home, log: (line) => lines.push(line),
  });
  assert.deepEqual(fx.calls()[0].args, ['daemon', 'start']);
  assert.equal(fx.calls()[0].env.PILOT_TRANSPORT, 'auto');
  assert.doesNotMatch(lines.join('\n'), /Warning/);
  assert.equal(result.trust_verified, true);
  assert.equal(result.transport, 'auto');
  assert.equal(result.proxy, REDACTED);
  assert.deepEqual(readConfig(fx), { registry: '34.71.57.205:9000', email: 'agent@example.com', transport: 'udp' });

  // A runtime with -proxy but no auto: its pilotctl would refuse auto, so it
  // is held back, and the start is planned as if it were unset.
  fx = fixture(t, PROXY_USAGE);
  lines = [];
  result = await installDaemon({
    transport: 'compat', autoStart: true, env: fx.env({ PILOT_TRANSPORT: 'auto', HTTPS_PROXY: PROXY }), home: fx.home, log: (line) => lines.push(line),
  });
  assert.equal(fx.calls()[0].env.PILOT_TRANSPORT, '');
  assert.deepEqual(fx.calls()[0].args, ['daemon', 'start', '--transport', 'compat']);
  assert.match(lines.join('\n'), /Warning: PILOT_TRANSPORT=auto needs a pilot-daemon with -transport=auto, which the installed one predates; setup ignores it/);
  assert.equal(result.trust_verified, true);

  // A released runtime before -proxy ignores PILOT_TRANSPORT altogether.
  fx = fixture(t, LEGACY_USAGE);
  lines = [];
  result = await installDaemon({ transport: 'udp', autoStart: true, env: fx.env({ PILOT_TRANSPORT: 'auto' }), home: fx.home, log: (line) => lines.push(line) });
  assert.match(lines.join('\n'), /Warning: PILOT_TRANSPORT=auto has no effect: the installed pilot-daemon predates it and runs udp/);
  assert.equal(result.transport, 'udp');
});

test('a runtime with -transport=auto gets no recorded transport, and loses the one an earlier setup recorded', { skip }, async (t) => {
  // An earlier setup, run while the runtime lacked auto, recorded compat.
  let fx = fixture(t, AUTO_USAGE);
  withConfig(fx, { transport: 'compat', transport_set_by: 'pilot-mcp' });
  const lines = [];
  const result = await installDaemon({ transport: 'compat', autoStart: true, env: fx.env({ HTTPS_PROXY: PROXY }), home: fx.home, log: (line) => lines.push(line) });
  assert.deepEqual(fx.calls()[0].args, ['daemon', 'start']);
  assert.equal(readConfig(fx).transport, undefined);
  assert.equal(readConfig(fx).transport_set_by, undefined);
  assert.match(lines.join('\n'), /Removed the "transport" setting an earlier setup recorded/);
  assert.equal(result.transport, 'auto');
  assert.equal(result.proxy, REDACTED);

  // A fresh config stays without one, on every network, and with an
  // exported PILOT_TRANSPORT=compat too (auto finds compat after a restart).
  for (const [probed, extra] of [['compat', { HTTPS_PROXY: PROXY }], ['udp', { HTTPS_PROXY: PROXY }], ['compat', {}]]) {
    fx = fixture(t, AUTO_USAGE);
    await installDaemon({ transport: probed, autoStart: true, env: fx.env(extra), home: fx.home, log: () => {} });
    assert.deepEqual(fx.calls()[0].args, ['daemon', 'start']);
    assert.deepEqual(readConfig(fx), { registry: '34.71.57.205:9000', email: 'agent@example.com' });
  }
  fx = fixture(t, AUTO_USAGE);
  const forced = await installDaemon({ transport: 'compat', autoStart: true, env: fx.env({ PILOT_TRANSPORT: 'compat', HTTPS_PROXY: PROXY }), home: fx.home, log: () => {} });
  assert.deepEqual(fx.calls()[0].args, ['daemon', 'start', '--transport', 'compat']);
  assert.equal(fx.calls()[0].env.PILOT_TRANSPORT, 'compat');
  assert.equal(forced.transport, 'compat');
  assert.deepEqual(readConfig(fx), { registry: '34.71.57.205:9000', email: 'agent@example.com' });
});

test('-proxy support is read from the daemon\'s flag list', { skip }, (t) => {
  const fx = fixture(t, PROXY_USAGE);
  assert.equal(supportsEgressProxy(fx.daemon), true);
  fx.writeDaemon(LEGACY_USAGE);
  assert.equal(supportsEgressProxy(fx.daemon), false);
  fx.writeDaemon('  -proxy-ca string\n    \tsee -proxy\n');
  assert.equal(supportsEgressProxy(fx.daemon), false);
  assert.equal(supportsEgressProxy(join(fx.work, 'missing')), false);
  assert.equal(supportsEgressProxy(null), false);
});

test('-transport=auto support is read from the -transport usage alone', { skip }, (t) => {
  const fx = fixture(t, AUTO_USAGE);
  assert.deepEqual(daemonFeatures(fx.daemon), { known: true, proxy: true, autoTransport: true });
  fx.writeDaemon(PROXY_USAGE);
  assert.deepEqual(daemonFeatures(fx.daemon), { known: true, proxy: true, autoTransport: false });
  fx.writeDaemon(LEGACY_USAGE);
  assert.deepEqual(daemonFeatures(fx.daemon), { known: true, proxy: false, autoTransport: false });
  // 'auto' in another flag's usage (-proxy's default) does not count.
  fx.writeDaemon("  -proxy string\n    \tproxy: 'auto' or 'off'\n  -transport string\n    \t'udp' or 'compat'\n  -zz\n    \tsee 'auto'\n");
  assert.deepEqual(daemonFeatures(fx.daemon), { known: true, proxy: true, autoTransport: false });
  fx.writeDaemon('not a daemon\n');
  assert.deepEqual(daemonFeatures(fx.daemon), { known: false, proxy: false, autoTransport: false });
  assert.deepEqual(daemonFeatures(join(fx.work, 'missing')), { known: false, proxy: false, autoTransport: false });
  assert.deepEqual(daemonFeatures(null), { known: false, proxy: false, autoTransport: false });
});

test('the daemon is located the way pilotctl locates it', { skip }, (t) => {
  const fx = fixture(t, PROXY_USAGE);
  assert.equal(daemonBinaryPath(fx.pilotctl, {}), fx.daemon);
  assert.equal(daemonBinaryPath(fx.pilotctl, { PILOT_DAEMON_BIN: '/opt/pilot/daemon' }), '/opt/pilot/daemon');
  const linked = join(fx.work, 'links');
  mkdirSync(linked);
  symlinkSync(fx.pilotctl, join(linked, 'pilotctl'));
  assert.equal(daemonBinaryPath(join(linked, 'pilotctl'), {}), fx.daemon);
  assert.equal(daemonBinaryPath(join(fx.work, 'nowhere', 'pilotctl'), { PATH: fx.bin }), fx.daemon);
  assert.equal(daemonBinaryPath(null, { PATH: fx.work }), null);
});

test('the UDP probe sends a real beacon discover and needs a discover reply', { timeout: 10_000 }, async (t) => {
  const beacon = createSocket('udp4');
  const received = [];
  let reply = true;
  beacon.on('message', (message, remote) => {
    received.push([...message]);
    if (reply) beacon.send(Buffer.from([0x02, 4, 127, 0, 0, 1, 0x1f, 0x90]), remote.port, remote.address);
  });
  await new Promise((resolve) => beacon.bind(0, '127.0.0.1', resolve));
  t.after(() => beacon.close());
  const { port } = beacon.address();
  assert.equal(await probeTransport('127.0.0.1', port, { env: {} }), 'udp');
  assert.deepEqual(received, [[0x01, 0, 0, 0, 0]]);
  reply = false;
  assert.equal(await probeTransport('127.0.0.1', port, { env: {}, timeoutMs: 300 }), 'compat');
  // A blocked network is only concluded after every attempt went unanswered.
  assert.equal(received.length, 4);
  assert.equal(await probeTransport('127.0.0.1', port, { env: { PILOT_TRANSPORT: 'compat' } }), 'compat');
  assert.equal(await probeTransport('127.0.0.1', port, { env: { PILOT_TRANSPORT: 'udp' }, timeoutMs: 200 }), 'udp');
  assert.equal(received.length, 4);
});

test('one lost datagram does not make a working network look UDP-blocked', { timeout: 10_000 }, async (t) => {
  const beacon = createSocket('udp4');
  let seen = 0;
  beacon.on('message', (message, remote) => {
    seen += 1;
    // Drop the first discover, answer the retry.
    if (seen > 1) beacon.send(Buffer.from([0x02, 4, 127, 0, 0, 1, 0x1f, 0x90]), remote.port, remote.address);
  });
  await new Promise((resolve) => beacon.bind(0, '127.0.0.1', resolve));
  t.after(() => beacon.close());
  assert.equal(await probeTransport('127.0.0.1', beacon.address().port, { env: {}, timeoutMs: 600 }), 'udp');
  assert.equal(seen, 2);
});

test('doctor reports the proxy, ignored settings and the recorded transport without credentials', { skip }, async (t) => {
  const fx = fixture(t, PROXY_USAGE);
  const config = JSON.parse(readFileSync(fx.config, 'utf8'));
  writeFileSync(fx.config, JSON.stringify({ ...config, transport: 'compat', transport_set_by: 'pilot-mcp' }));
  const cli = new URL('../cli.js', import.meta.url).pathname;
  const env = {
    HOME: fx.home,
    PATH: '/usr/bin:/bin',
    PILOTCTL_BIN: fx.pilotctl,
    PILOT_SOCKET: join(fx.work, 'missing.sock'),
    HTTPS_PROXY: PROXY,
    HTTP_PROXY: 'socks5://muse-agent:s3cr3t@proxy:1080',
  };
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'doctor', '--json'], { env });
  const report = JSON.parse(stdout);
  assert.deepEqual(report.network.transport, { value: 'compat', set_by: 'pilot-mcp' });
  assert.equal(report.network.proxy, REDACTED);
  assert.equal(report.network.source, 'HTTPS_PROXY');
  assert.equal(report.network.daemon_proxy_support, true);
  assert.equal(report.network.warnings.length, 1);
  assert.match(report.network.warnings[0], /^HTTP_PROXY is not a usable proxy/);
  assert.equal(report.network.mode, 'auto');
  assert.doesNotMatch(stdout, /s3cr3t|muse-agent/);

  // An off alias shows as off, with where it came from, not as a bare null.
  const off = JSON.parse((await promisify(execFile)(process.execPath, [cli, 'doctor', '--json'], { env: { ...env, PILOT_PROXY: 'none' } })).stdout);
  assert.equal(off.network.proxy, null);
  assert.equal(off.network.mode, 'off');
  assert.equal(off.network.setting, 'PILOT_PROXY');
  const text = (await promisify(execFile)(process.execPath, [cli, 'doctor'], { env: { ...env, PILOT_PROXY: 'none' } })).stdout;
  assert.match(text, /^Egress proxy: off \(PILOT_PROXY\)$/m);
  // A setting pilot-daemon would refuse is reported, without its credentials.
  const refused = JSON.parse((await promisify(execFile)(process.execPath, [cli, 'doctor', '--json'], {
    env: { ...env, PILOT_PROXY: 'socks5://muse-agent:s3cr3t@proxy:1080' },
  })).stdout);
  assert.equal(refused.network.proxy, REDACTED);
  assert.match(refused.network.warnings.join('\n'), /^PILOT_PROXY is not a usable proxy setting .*pilot-daemon would refuse it/m);
  assert.doesNotMatch(JSON.stringify(refused), /s3cr3t|muse-agent/);
});

test('doctor takes the "transport": "auto" install.sh saves as valid, unless the daemon predates it', { skip }, async (t) => {
  const cli = new URL('../cli.js', import.meta.url).pathname;
  const doctor = async (fx, extra = {}) => JSON.parse((await promisify(execFile)(process.execPath, [cli, 'doctor', '--json'], {
    env: { HOME: fx.home, PATH: '/usr/bin:/bin', PILOTCTL_BIN: fx.pilotctl, PILOT_SOCKET: join(fx.work, 'missing.sock'), ...extra },
  })).stdout);
  let fx = fixture(t, AUTO_USAGE);
  withConfig(fx, { transport: 'auto' });
  let report = await doctor(fx, { PILOT_TRANSPORT: 'auto', HTTPS_PROXY: PROXY });
  assert.equal(report.network.warnings, undefined);
  assert.deepEqual(report.network.transport, { value: 'auto', set_by: 'user' });
  assert.equal(report.network.daemon_proxy_support, true);
  const text = (await promisify(execFile)(process.execPath, [cli, 'doctor'], {
    env: { HOME: fx.home, PATH: '/usr/bin:/bin', PILOTCTL_BIN: fx.pilotctl, PILOT_SOCKET: join(fx.work, 'missing.sock') },
  })).stdout;
  assert.doesNotMatch(text, /warning/i);
  assert.match(text, /^Transport: auto \(config\.json, set by you or install\.sh\)$/m);

  fx = fixture(t, LEGACY_USAGE);
  withConfig(fx, { transport: 'auto' });
  report = await doctor(fx);
  assert.equal(report.network.warnings.length, 1);
  assert.match(report.network.warnings[0], /has "transport": "auto", but the installed pilot-daemon predates -transport=auto/);
});

// fixture builds a HOME with a Pilot config plus a fake pilotctl (recording
// its argv and proxy environment) and a sibling fake pilot-daemon whose -h
// output is `usage`.
function fixture(t, usage) {
  // Resolved so paths compare equal to pilotctl-style symlink resolution
  // (macOS tmpdir lives behind the /var -> /private/var link).
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'pilot-proxy-daemon-')));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const home = join(work, 'home');
  const bin = join(work, 'bin');
  mkdirSync(join(home, '.pilot'), { recursive: true });
  mkdirSync(bin);
  const config = join(home, '.pilot', 'config.json');
  writeFileSync(config, JSON.stringify({ registry: '34.71.57.205:9000', email: 'agent@example.com' }, null, 2));
  const log = join(work, 'pilotctl.log');
  const pilotctl = join(bin, 'pilotctl');
  // `daemon start` refuses what pilot-daemon's -proxy and pilotctl's
  // transport check refuse, as the real ones do on every transport, and a
  // daemon that did not start answers no send-message.
  const dead = join(work, 'daemon-dead');
  writeFileSync(pilotctl, `#!/bin/sh
{
  printf 'ARGS'; for arg in "$@"; do printf '\\t%s' "$arg"; done; printf '\\n'
  printf 'ENV\\tHTTPS_PROXY=%s\\tNO_PROXY=%s\\tPILOT_PROXY=%s\\tPILOT_TRANSPORT=%s\\n' "\${HTTPS_PROXY-}" "\${NO_PROXY-}" "\${PILOT_PROXY-<unset>}" "\${PILOT_TRANSPORT-<unset>}"
} >> '${log}'
if [ "$1 $2" = "daemon start" ]; then
  case "\${PILOT_TRANSPORT-}" in
    ''|udp|compat) ;;
    auto) grep -q "'auto'" '${join(bin, 'pilot-daemon')}' || { echo "daemon start: invalid transport" >&2; : > '${dead}'; exit 1; } ;;
    *) echo "daemon start: invalid transport" >&2; : > '${dead}'; exit 1 ;;
  esac
  case "\${PILOT_PROXY-}" in ''|auto|off|http://?*|https://?*) ;; *) echo "-proxy: invalid proxy" >&2; : > '${dead}'; exit 1 ;; esac
fi
if [ "$1" = send-message ]; then
  if [ -e '${dead}' ]; then printf '%s\\n' '{"ok":false}'; exit 1; fi
  printf '%s\\n' '{"ok":true,"data":{"items":[]}}'
fi
exit 0
`);
  chmodSync(pilotctl, 0o755);
  const daemon = join(bin, 'pilot-daemon');
  const writeDaemon = (text) => {
    writeFileSync(daemon, `#!/bin/sh\ncat >&2 <<'USAGE'\n${text}USAGE\nexit 0\n`);
    chmodSync(daemon, 0o755);
  };
  writeDaemon(usage);

  process.env.PILOTCTL_BIN = pilotctl;

  return {
    work,
    home,
    bin,
    config,
    pilotctl,
    daemon,
    writeDaemon,
    env: (extra) => ({ PILOTCTL_BIN: pilotctl, PATH: '/usr/bin:/bin', ...extra }),
    calls: () => {
      let text = '';
      try {
        text = readFileSync(log, 'utf8');
      } catch {
        return [];
      }
      const calls = [];
      for (const line of text.trim().split('\n')) {
        const [kind, ...fields] = line.split('\t');
        if (kind === 'ARGS') calls.push({ args: fields, env: {} });
        else calls.at(-1).env = Object.fromEntries(fields.map((field) => field.split(/=(.*)/s).slice(0, 2)));
      }
      return calls;
    },
  };
}

function readConfig(fx) {
  return JSON.parse(readFileSync(fx.config, 'utf8'));
}

// withConfig merges keys into the fixture's config.json.
function withConfig(fx, keys) {
  writeFileSync(fx.config, JSON.stringify({ ...readConfig(fx), ...keys }));
}
