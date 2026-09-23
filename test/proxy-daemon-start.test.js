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
import { supportsEgressProxy } from '../src/setup/runtime.js';
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
  assert.match(plan.warnings.join('\n'), /^config\.json proxy is not a usable proxy \(unsupported scheme "socks5".*pilotctl config --set proxy=/);
  assert.doesNotMatch(plan.warnings.join('\n'), /s3cr3t/);
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
  assert.doesNotMatch(stdout, /s3cr3t|muse-agent/);
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
  writeFileSync(pilotctl, `#!/bin/sh
{
  printf 'ARGS'; for arg in "$@"; do printf '\\t%s' "$arg"; done; printf '\\n'
  printf 'ENV\\tHTTPS_PROXY=%s\\tNO_PROXY=%s\\tPILOT_PROXY=%s\\n' "\${HTTPS_PROXY-}" "\${NO_PROXY-}" "\${PILOT_PROXY-}"
} >> '${log}'
if [ "$1" = send-message ]; then printf '%s\\n' '{"ok":true,"data":{"items":[]}}'; fi
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
