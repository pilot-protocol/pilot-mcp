import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { daemonBinaryPath, pilotctlBinaryPath } from '../daemon-bridge.js';
import { proxyAwareFetch } from '../netproxy.js';
import { readPilotConfig } from './pilot-config.js';

const DEFAULT_MANIFEST = 'https://pilotprotocol.network/.well-known/latest.json';
const MAX_RUNTIME_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MANAGED_RUNTIME = Object.freeze({
  tag: 'managed-runtime-v0.1.5',
  platforms: Object.freeze({
    'darwin-amd64': Object.freeze({
      url: 'https://github.com/pilot-protocol/pilotprotocol/releases/download/managed-runtime-v0.1.5/pilot-darwin-amd64.tar.gz',
      sha256: '0d8bbda818bbfa1df9544fe114353eca097d3f7b7e356c4c5ceac1eaaf3f6d63',
    }),
    'darwin-arm64': Object.freeze({
      url: 'https://github.com/pilot-protocol/pilotprotocol/releases/download/managed-runtime-v0.1.5/pilot-darwin-arm64.tar.gz',
      sha256: '9df13081c5340f24c18c7941ad964c7c8c67b64d0f7a7fe98eee5043ee2fe915',
    }),
    'linux-amd64': Object.freeze({
      url: 'https://github.com/pilot-protocol/pilotprotocol/releases/download/managed-runtime-v0.1.5/pilot-linux-amd64.tar.gz',
      sha256: '432c04cd27b66e422b5d50778a7f7c220cd20b248348d2fcbad7e0a13e4de498',
    }),
    'linux-arm64': Object.freeze({
      url: 'https://github.com/pilot-protocol/pilotprotocol/releases/download/managed-runtime-v0.1.5/pilot-linux-arm64.tar.gz',
      sha256: 'ce873cc9838a7845956028050358f66a33f87af7c8983d2e63065d89104c2181',
    }),
  }),
});

// Downloads go through proxyAwareFetch: in proxy-only sandboxes (Meta Muse)
// the manifest and archive are fetched via the HTTPS_PROXY CONNECT tunnel,
// and the archive is still checked against the pinned SHA-256 either way.
//
// requireProxy asks for a runtime whose pilot-daemon supports -proxy; see
// upgradeRuntimeForProxy for when the installed runtime may be replaced.
export async function ensurePilotRuntime({ requireManaged = false, requireProxy = false, home = homedir(), fetchImpl = proxyAwareFetch, env = process.env } = {}) {
  let existing = null;
  try {
    existing = pilotctlBinaryPath(env);
  } catch {
    // A first install is expected not to have a runtime yet.
  }
  if (existing
    && (!requireManaged || supportsManagedAdoption(existing))
    && (!requireProxy || supportsEgressProxy(daemonBinaryPath(existing, env)))) return existing;

  if (requireProxy && !requireManaged && existing) {
    return (await upgradeRuntimeForProxy({ home, fetchImpl, env })).path ?? existing;
  }

  const release = requireManaged ? managedRuntimeRelease() : await latestRelease(fetchImpl, env);
  const archive = await downloadRelease(fetchImpl, release);
  const stage = stageRuntime(home, archive);
  try {
    installStagedRuntime(stage, home, release.tag);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  const installed = join(home, '.pilot', 'bin', 'pilotctl');
  if (requireManaged && !supportsManagedAdoption(installed)) {
    throw new Error(`Pilot ${release.tag} does not contain hosted adoption support`);
  }
  return installed;
}

// upgradeRuntimeForProxy replaces the installed runtime with one whose
// pilot-daemon supports -proxy, and only when all of these hold:
//   - the runtime is the per-user one setup manages (~/.pilot/bin); a
//     runtime installed elsewhere (brew, $PATH, PILOTCTL_BIN) is left alone;
//   - the node is not managed: a pinned enterprise runtime is never swapped
//     for the public release (see managedNodeReason);
//   - the installed version is known and the latest stable release is
//     strictly newer, so this never downgrades (for example a beta);
//   - the new release's pilot-daemon, checked in the staging directory
//     before anything is replaced, actually lists -proxy.
// Otherwise the installed runtime is kept. Resolves to
// { upgraded, path, reason?, from?, to? }; `reason` is log-ready.
export async function upgradeRuntimeForProxy({ home = homedir(), fetchImpl = proxyAwareFetch, env = process.env } = {}) {
  let existing;
  try {
    existing = pilotctlBinaryPath(env);
  } catch {
    return { upgraded: false, path: null, reason: 'no Pilot runtime is installed' };
  }
  if (supportsEgressProxy(daemonBinaryPath(existing, env))) {
    return { upgraded: false, path: existing, reason: 'the installed pilot-daemon already supports -proxy' };
  }
  const perUser = join(home, '.pilot', 'bin', 'pilotctl');
  if (existing !== perUser) {
    return { upgraded: false, path: existing, reason: `${existing} was not installed by setup, so setup does not replace it` };
  }
  const managed = managedNodeReason({ home, env });
  if (managed) {
    return { upgraded: false, path: existing, reason: `this node is managed (${managed}), and its pinned runtime is never replaced` };
  }
  const installed = installedRuntimeTag(home);
  if (!parseVersionTag(installed)) {
    return {
      upgraded: false,
      path: existing,
      reason: installed ? `the installed runtime ${installed} is not a release version` : 'the installed runtime has no recorded version',
    };
  }
  const release = await latestRelease(fetchImpl, env);
  if (compareVersionTags(release.tag, installed) <= 0) {
    return { upgraded: false, path: existing, reason: `the latest stable release ${release.tag} is not newer than the installed ${installed}` };
  }
  const archive = await downloadRelease(fetchImpl, release);
  const stage = stageRuntime(home, archive);
  try {
    if (!supportsEgressProxy(join(stage, 'daemon'))) {
      return { upgraded: false, path: existing, reason: `the latest stable release ${release.tag} does not support -proxy yet` };
    }
    installStagedRuntime(stage, home, release.tag);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return { upgraded: true, path: perUser, from: installed, to: release.tag };
}

// managedNodeReason names the evidence that this node runs under enterprise
// management, or returns null. Any one of them pins the runtime: a managed
// runtime tag, the owner-only control attachment, an enterprise_control key
// in config.json, or PILOT_ENTERPRISE_CONTROL.
export function managedNodeReason({ home = homedir(), env = process.env } = {}) {
  const tag = installedRuntimeTag(home);
  if (tag.startsWith('managed-runtime-')) return `runtime ${tag}`;
  try {
    lstatSync(join(home, '.pilot', 'managed', 'enterprise-control.json'));
    return 'enterprise control attachment';
  } catch {
    // Not attached.
  }
  if (String(env.PILOT_ENTERPRISE_CONTROL ?? '').trim()) return 'PILOT_ENTERPRISE_CONTROL';
  const { config } = readPilotConfig(home);
  if (config && String(config.enterprise_control ?? '').trim()) return 'config.json enterprise_control';
  return null;
}

// compareVersionTags orders release tags by semantic-version precedence
// (a pre-release sorts before its release). Returns <0, 0 or >0; both tags
// must satisfy parseVersionTag.
export function compareVersionTags(a, b) {
  const left = parseVersionTag(a);
  const right = parseVersionTag(b);
  if (!left || !right) throw new Error(`cannot compare versions ${a} and ${b}`);
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  }
  if (!left.pre.length || !right.pre.length) return right.pre.length - left.pre.length;
  for (let i = 0; i < Math.min(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return left.pre.length - right.pre.length;
}

export function parseVersionTag(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(tag ?? '').trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] };
}

async function latestRelease(fetchImpl, env) {
  const manifestURL = env.PILOT_RELEASE_MANIFEST_URL ?? DEFAULT_MANIFEST;
  return validateRuntimeManifest(await fetchJSON(fetchImpl, manifestURL));
}

async function downloadRelease(fetchImpl, release) {
  const archive = await fetchBytes(fetchImpl, release.url);
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== release.sha256) throw new Error('Pilot runtime archive checksum did not match the pinned distribution digest');
  return archive;
}

// stageRuntime extracts a verified archive into a fresh staging directory
// under ~/.pilot and returns it; the caller removes it.
function stageRuntime(home, archive) {
  const pilotRoot = join(home, '.pilot');
  mkdirSync(pilotRoot, { recursive: true, mode: 0o700 });
  chmodSync(pilotRoot, 0o700);
  const stage = mkdtempSync(join(pilotRoot, '.runtime-stage-'));
  try {
    const archivePath = join(stage, 'runtime.tar.gz');
    writeFileSync(archivePath, archive, { mode: 0o600 });
    const listed = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8', timeout: 30_000 });
    if (listed.status !== 0) throw new Error(`could not inspect Pilot runtime archive: ${String(listed.stderr).trim()}`);
    const entries = listed.stdout.split(/\r?\n/).map((entry) => entry.replace(/^\.\//, '')).filter(Boolean);
    if (!entries.includes('daemon') || !entries.includes('pilotctl') || entries.some((entry) => !['daemon', 'pilotctl', 'updater'].includes(entry))) {
      throw new Error('Pilot runtime archive contains an unexpected file layout');
    }
    const extracted = spawnSync('tar', ['-xzf', archivePath, '-C', stage], { encoding: 'utf8', timeout: 60_000 });
    if (extracted.status !== 0) throw new Error(`could not extract Pilot runtime archive: ${String(extracted.stderr).trim()}`);
    for (const name of ['daemon', 'pilotctl', 'updater']) {
      if (existsSync(join(stage, name))) chmodSync(join(stage, name), 0o755);
    }
    return stage;
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function installStagedRuntime(stage, home, tag) {
  const binDirectory = join(home, '.pilot', 'bin');
  mkdirSync(binDirectory, { recursive: true, mode: 0o700 });
  chmodSync(binDirectory, 0o700);
  installBinary(join(stage, 'daemon'), join(binDirectory, 'pilot-daemon'));
  installBinary(join(stage, 'pilotctl'), join(binDirectory, 'pilotctl'));
  if (existsSync(join(stage, 'updater'))) installBinary(join(stage, 'updater'), join(binDirectory, 'pilot-updater'));
  writeFileSync(join(binDirectory, '.pilot-version'), `${tag}\n`, { mode: 0o600 });
}

export function supportsManagedAdoption(binary) {
  if (!binary || !existsSync(binary)) return false;
  const environment = { ...process.env };
  delete environment.PILOT_ENROLLMENT_TOKEN;
  const probe = spawnSync(binary, ['--json', 'enterprise', 'adopt', '--endpoint', 'https://management.invalid'], {
    encoding: 'utf8', env: environment, timeout: 5_000,
  });
  return `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`.includes('PILOT_ENROLLMENT_TOKEN');
}

// supportsEgressProxy reports whether a pilot-daemon understands -proxy,
// i.e. can reach the registry and beacon through HTTPS_PROXY. Go's flag
// package lists every flag on its own line as "  -name type" under -h.
// The probe runs with only PATH and HOME, so no proxy credential from the
// environment can end up in a printed flag default.
export function supportsEgressProxy(daemon) {
  return daemonFeatures(daemon).proxy;
}

// daemonFeatures reads a pilot-daemon's -h once and reports:
//   known          it printed a flag list, so the other two can be trusted
//   proxy          it understands -proxy
//   autoTransport  its -transport accepts 'auto', which its usage names; the
//                  same check install.sh and pilotctl make. Such a runtime
//                  picks udp or compat itself on every start, reads
//                  "transport" in any case, and install.sh saves
//                  "transport": "auto" for it.
export function daemonFeatures(daemon) {
  const none = { known: false, proxy: false, autoTransport: false };
  if (!daemon || !existsSync(daemon)) return none;
  const env = {};
  for (const name of ['PATH', 'HOME']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const probe = spawnSync(daemon, ['-h'], { encoding: 'utf8', timeout: 5_000, env });
  const lines = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`.split('\n');
  const start = lines.findIndex((line) => /^\s+-transport(?:\s|$)/.test(line));
  let transportUsage = '';
  if (start >= 0) {
    const end = lines.findIndex((line, index) => index > start && /^\s*-[a-z]/.test(line));
    transportUsage = lines.slice(start, end < 0 ? undefined : end).join('\n');
  }
  return {
    known: lines.some((line) => /^\s+-[a-z][\w-]*(?:\s|$)/.test(line)),
    proxy: lines.some((line) => /^\s*-proxy\b(?!-)/.test(line)),
    autoTransport: transportUsage.includes("'auto'"),
  };
}

export function installedRuntimeTag(home = homedir()) {
  try {
    return readFileSync(join(home, '.pilot', 'bin', '.pilot-version'), 'utf8').trim();
  } catch {
    return '';
  }
}

export function validateRuntimeManifest(manifest, platform = process.platform, arch = process.arch) {
  const tag = String(manifest?.latest_stable ?? '').trim();
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error('Pilot release manifest has no valid stable version');
  const key = runtimePlatformKey(platform, arch);
  const record = manifest?.platforms?.[key];
  const rawURL = String(record?.url ?? '').trim();
  const sha256 = String(record?.sha256 ?? '').trim().toLowerCase();
  let parsed;
  try {
    parsed = new URL(rawURL);
  } catch {
    throw new Error(`Pilot release manifest has no runtime for ${key}`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || !parsed.pathname.startsWith(`/pilot-protocol/pilotprotocol/releases/download/${tag}/`) || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`Pilot release manifest has an invalid runtime for ${key}`);
  }
  return { tag, url: parsed.toString(), sha256 };
}

export function managedRuntimeRelease(platform = process.platform, arch = process.arch) {
  const key = runtimePlatformKey(platform, arch);
  const release = MANAGED_RUNTIME.platforms[key];
  if (!release) throw new Error(`Pilot does not publish a managed runtime for ${platform}/${arch}`);
  return { tag: MANAGED_RUNTIME.tag, ...release };
}

function runtimePlatformKey(platform, arch) {
  const normalizedArch = arch === 'x64' ? 'amd64' : arch;
  const key = `${platform}-${normalizedArch}`;
  if (!['darwin-amd64', 'darwin-arm64', 'linux-amd64', 'linux-arm64'].includes(key)) {
    throw new Error(`Pilot does not publish a runtime for ${platform}/${arch}`);
  }
  return key;
}

async function fetchJSON(fetchImpl, url) {
  const response = await fetchImpl(url, { redirect: 'follow', signal: globalThis.AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Pilot release manifest returned HTTP ${response.status}`);
  return response.json();
}

async function fetchBytes(fetchImpl, url) {
  const response = await fetchImpl(url, { redirect: 'follow', signal: globalThis.AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`Pilot runtime download returned HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_RUNTIME_ARCHIVE_BYTES) throw new Error('Pilot runtime archive is unexpectedly large');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_RUNTIME_ARCHIVE_BYTES) throw new Error('Pilot runtime archive has an invalid size');
  return bytes;
}

function installBinary(source, destination) {
  if (basename(source) === '.' || !existsSync(source)) throw new Error(`Pilot runtime is missing ${basename(source)}`);
  const temporary = `${destination}.new.${randomBytes(8).toString('hex')}`;
  copyFileSync(source, temporary);
  chmodSync(temporary, 0o755);
  renameSync(temporary, destination);
  if (!readFileSync(destination).length) throw new Error(`Pilot runtime installed an empty ${basename(destination)}`);
}
