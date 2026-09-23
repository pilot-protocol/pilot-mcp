// Daemon start behind an egress proxy (Meta Muse): with HTTPS_PROXY set and
// UDP blocked, a pilot-daemon that supports -proxy starts in compat mode
// through the proxy; an older daemon keeps today's start and points at the
// pilot-sandbox skill.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  assert.deepEqual(calls[0].args, ['daemon', 'start', '--transport', 'compat', '--proxy', 'auto']);
  assert.equal(calls[0].env.HTTPS_PROXY, PROXY);
  assert.equal(calls[0].env.NO_PROXY, 'localhost');
  const config = JSON.parse(readFileSync(fx.config, 'utf8'));
  assert.equal(config.transport, 'compat');
  assert.equal(config.registry, '34.71.57.205:9000');
  assert.equal(config.proxy, undefined);
  assert.equal(result.trust_verified, true);
  assert.equal(result.proxy, REDACTED);
  assert.equal(result.proxy_supported, true);
  assert.match(lines.join('\n'), /Egress proxy http:\/\/\*\*\*@proxy\.muse\.internal:3128 \(HTTPS_PROXY\): starting pilot-daemon with -transport=compat -proxy=auto/);
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
  assert.deepEqual(fx.calls()[0].args, ['daemon', 'start', '--transport', 'compat', '--proxy', 'auto']);
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
  }
});

test('planDaemonStart only routes through the proxy when UDP is blocked', { skip }, (t) => {
  const fx = fixture(t, PROXY_USAGE);
  assert.deepEqual(planDaemonStart({ transport: 'udp', env: { HTTPS_PROXY: PROXY } }), { mode: 'default' });
  assert.deepEqual(planDaemonStart({ transport: 'compat', env: {} }), { mode: 'default' });
  const plan = planDaemonStart({ transport: 'compat', env: fx.env({ https_proxy: PROXY }) });
  assert.equal(plan.mode, 'compat-proxy');
  assert.equal(plan.source, 'https_proxy');
  assert.equal(plan.daemon, fx.daemon);
  assert.equal(planDaemonStart({ transport: 'compat', env: { HTTPS_PROXY: PROXY }, daemon: null }).mode, 'proxy-unsupported');
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
  assert.equal(await probeTransport('127.0.0.1', port, { env: {}, timeoutMs: 200 }), 'compat');
  assert.equal(await probeTransport('127.0.0.1', port, { env: { PILOT_TRANSPORT: 'compat' } }), 'compat');
  assert.equal(await probeTransport('127.0.0.1', port, { env: { PILOT_TRANSPORT: 'udp' }, timeoutMs: 200 }), 'udp');
  assert.equal(received.length, 2);
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
