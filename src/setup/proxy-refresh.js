// setup/proxy-refresh.js — keep the daemon's egress-proxy credentials fresh
// where the proxy rotates them.
//
// Hosted agent sandboxes (Meta Muse) put proxy credentials in HTTPS_PROXY and
// rotate them every few minutes. A daemon keeps the credentials it started
// with, so once they rotate every new registry or beacon connection fails
// with 407 while the node still looks online. In order of preference, setup:
//
//   1. hands a pilot-daemon with -proxy-cmd a proxy command: the one the user
//      configured ($PILOT_PROXY_CMD, config.json "proxy_cmd"), or in a
//      sandbox whose proxy carries credentials the sandbox default (a fresh
//      bash, which sees the current credentials), which it also saves as
//      config.json "proxy_cmd", as install.sh does, so later starts keep it;
//   2. for a daemon with -proxy but without -proxy-cmd, points its
//      HTTPS_PROXY at the pilot-sandbox skill's egress_relay.py on
//      127.0.0.1:3128 (started if it is not running), which re-reads the
//      credentials for every connection;
//   3. otherwise says what goes wrong and points at the pilot-sandbox skill.
//
// A daemon without -proxy at all cannot use the proxy; daemon.js points
// that one at the pilot-sandbox skill already.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';
import {
  configuredProxyCommand,
  findExecutable,
  proxyHasCredentials,
  SANDBOX_PROXY_CMD,
  sandboxHost,
} from '../netproxy.js';

export const EGRESS_RELAY_URL = 'https://github.com/TeoSlayer/pilot-skills/blob/main/skills/pilot-sandbox/scripts/egress_relay.py';

// The address egress_relay.py listens on.
export const EGRESS_RELAY_ADDRESS = Object.freeze({ host: '127.0.0.1', port: 3128 });

// Skill folders the pilot-sandbox skill is installed into: Meta Muse's
// workspace, then the harness folders the Pilot skill installer knows.
const SKILL_DIRS = [
  ['workspace', 'skills'],
  ['.claude', 'skills'],
  ['.agents', 'skills'],
  ['.codex', 'skills'],
  ['.openclaw', 'skills'],
  ['.picoclaw', 'workspace', 'skills'],
  ['.hermes', 'skills'],
  ['.config', 'goose', 'skills'],
  ['.config', 'opencode', 'skills'],
];

// planProxyRefresh decides how the daemon setup starts keeps its proxy
// credentials fresh. It returns:
//   mode     'none'        nothing to do: no proxy for this start, no
//                          credentials to rotate, or not a sandbox and
//                          nothing configured
//            'proxy-cmd'   the daemon re-reads them with a proxy command
//            'relay'       the daemon goes through egress_relay.py
//            'stale'       none of that is possible: the daemon keeps the
//                          credentials it starts with
//   source   where the proxy command came from (proxy-cmd)
//   env      environment overrides for `pilotctl daemon start`
//   save     a proxy_cmd to save in config.json, or undefined
//   lines    log lines (never a credential or the command's output)
// `plan` is planDaemonStart's; `features` describes the daemon. `relay`
// ({ find, ensure, address }) overrides how egress_relay.py is found and
// started, and where it listens (tests).
export async function planProxyRefresh({ plan, features, env = process.env, config = {}, home = homedir(), host = sandboxHost(env), relay = {} }) {
  const none = { mode: 'none', env: {}, lines: [] };
  // Only a daemon that runs compat through the proxy uses it.
  if (!plan.proxy || (plan.mode !== 'compat-proxy' && plan.mode !== 'auto')) return none;
  const configured = configuredProxyCommand(env, config);
  // The sandbox default reads HTTPS_PROXY / https_proxy, so it only stands in
  // for the proxy the environment supplies, never an explicit PILOT_PROXY or
  // config.json "proxy" URL (it would replace that one).
  const fromEnvironment = plan.source === 'HTTPS_PROXY' || plan.source === 'https_proxy';
  const sandboxDefault = !configured && host.sandbox && host.bash && fromEnvironment && proxyHasCredentials(plan.proxy);
  if (!configured && !sandboxDefault) return none;
  const daemon = plan.daemon ?? 'pilot-daemon';

  if (features.proxyCmd) {
    if (configured) {
      return { mode: 'proxy-cmd', source: configured.source, env: {}, lines: [`Proxy credentials: pilot-daemon re-reads them with the proxy command from ${configured.source} (every 60s and on a 407).`] };
    }
    return {
      mode: 'proxy-cmd',
      source: 'sandbox default',
      env: { PILOT_PROXY_CMD: SANDBOX_PROXY_CMD },
      save: SANDBOX_PROXY_CMD,
      lines: [
        'This sandbox\'s proxy credentials can rotate: pilot-daemon re-reads them every 60s and on a 407',
        `with the proxy command ${SANDBOX_PROXY_CMD}.`,
      ],
    };
  }

  const reason = configured
    ? `${daemon} predates -proxy-cmd, so it ignores the proxy command from ${configured.source}`
    : `${daemon} predates -proxy-cmd`;
  // The relay stands in for the environment's proxy (HTTPS_PROXY outranks
  // the other proxy variables); an explicit PILOT_PROXY or config.json
  // "proxy" URL is left alone.
  if (!ENVIRONMENT_PROXY_VARS.has(plan.source)) {
    return stale(reason, `the proxy is set explicitly (${plan.source}), which the egress relay does not replace`);
  }
  const script = (relay.find ?? findEgressRelay)({ home, env });
  if (!script) return stale(reason, 'no egress relay (egress_relay.py) was found');
  const address = relay.address ?? EGRESS_RELAY_ADDRESS;
  const started = await (relay.ensure ?? ensureEgressRelay)({ script, env, command: configured?.command, address });
  if (!started.ok) return stale(reason, `the egress relay ${script} could not be used: ${started.error}`);
  const url = `http://${address.host}:${address.port}`;
  const overrides = { HTTPS_PROXY: url };
  if (env.https_proxy !== undefined) overrides.https_proxy = url;
  return {
    mode: 'relay',
    env: overrides,
    lines: [
      `Proxy credentials can rotate and ${reason}: it goes through the pilot-sandbox egress relay`,
      `(${script}, ${started.reused ? 'already running' : 'started'} on ${address.host}:${address.port}), which re-reads them for every connection.`,
      'After a VM restart, start the relay again before the daemon (see the pilot-sandbox skill).',
    ],
  };
}

const ENVIRONMENT_PROXY_VARS = new Set(['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']);

function stale(reason, detail) {
  return {
    mode: 'stale',
    env: {},
    lines: [
      `Warning: proxy credentials can rotate, but ${reason} and ${detail}.`,
      'pilot-daemon keeps the credentials it starts with, so once they rotate its new connections fail with 407.',
      `Update the Pilot runtime, or run the pilot-sandbox egress relay (${EGRESS_RELAY_URL}) and re-run setup.`,
    ],
  };
}

// findEgressRelay returns the path of the pilot-sandbox skill's
// egress_relay.py: $PILOT_EGRESS_RELAY, else the first installed copy in the
// known skill folders (Meta Muse: ~/workspace/skills). null when none.
export function findEgressRelay({ home = homedir(), env = process.env } = {}) {
  const explicit = String(env.PILOT_EGRESS_RELAY ?? '').trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  const dirs = [];
  const muse = String(env.MUSE_SKILLS_DIR ?? '').trim();
  if (muse) dirs.push(muse);
  for (const parts of SKILL_DIRS) dirs.push(join(home, ...parts));
  for (const dir of dirs) {
    const candidate = join(dir, 'pilot-sandbox', 'scripts', 'egress_relay.py');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ensureEgressRelay makes sure egress_relay.py is listening: an instance
// already running is reused; otherwise it is started with python3, detached
// so it outlives setup, reading the credentials with `command` (a proxy
// command the user configured) or its own default (a fresh bash). A port
// held by something else is never used. Resolves { ok, reused } or
// { ok: false, error }.
export async function ensureEgressRelay({
  script,
  env = process.env,
  command,
  address = EGRESS_RELAY_ADDRESS,
  running = egressRelayRunning,
  waitMs = 3_000,
}) {
  if (await listening(address)) {
    return running() ? { ok: true, reused: true } : { ok: false, error: `${address.host}:${address.port} is in use by another program` };
  }
  const python = findExecutable('python3', env);
  if (!python) return { ok: false, error: 'python3 is not installed' };
  if (!findExecutable('bash', env)) return { ok: false, error: 'bash is not installed' };
  const childEnv = command ? { ...env, RELAY_CRED_CMD: command } : { ...env };
  let child;
  try {
    child = spawn(python, [script], { detached: true, stdio: 'ignore', env: childEnv });
  } catch (error) {
    return { ok: false, error: `python3 could not start it (${error.code ?? 'spawn failed'})` };
  }
  let exited = false;
  child.once('error', () => { exited = true; });
  child.once('exit', () => { exited = true; });
  child.unref();
  for (const deadline = Date.now() + waitMs; Date.now() < deadline && !exited;) {
    if (await listening(address)) return { ok: true, reused: false };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (await listening(address)) return { ok: true, reused: false };
  return { ok: false, error: exited ? 'it exited at once (see /tmp/egress_relay.log)' : `it did not listen on ${address.host}:${address.port} within ${waitMs / 1000}s` };
}

// egressRelayRunning reports whether an egress_relay.py process runs: from
// /proc where there is one (Linux), else from ps.
export function egressRelayRunning() {
  if (existsSync('/proc/self/cmdline')) {
    let pids = [];
    try {
      pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
    } catch {
      return false;
    }
    return pids.some((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, 'latin1').includes('egress_relay.py');
      } catch {
        return false;
      }
    });
  }
  const ps = spawnSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8', timeout: 5_000 });
  return ps.status === 0 && ps.stdout.includes('egress_relay.py');
}

function listening({ host, port }) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}
