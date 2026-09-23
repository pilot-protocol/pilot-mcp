import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
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
// requireProxy asks for a runtime whose pilot-daemon supports -proxy. Only
// the per-user runtime in ~/.pilot/bin is replaced, by the latest stable
// release and only when that is not already the installed one; a runtime the
// user installed elsewhere (brew, $PATH, PILOTCTL_BIN) is left alone.
export async function ensurePilotRuntime({ requireManaged = false, requireProxy = false, home = homedir(), fetchImpl = proxyAwareFetch } = {}) {
  let existing = null;
  try {
    existing = pilotctlBinaryPath();
  } catch {
    // A first install is expected not to have a runtime yet.
  }
  if (existing
    && (!requireManaged || supportsManagedAdoption(existing))
    && (!requireProxy || supportsEgressProxy(daemonBinaryPath(existing)))) return existing;

  const proxyUpgrade = requireProxy && !requireManaged && Boolean(existing);
  if (proxyUpgrade && existing !== join(home, '.pilot', 'bin', 'pilotctl')) return existing;

  let release;
  if (requireManaged) {
    release = managedRuntimeRelease();
  } else {
    const manifestURL = process.env.PILOT_RELEASE_MANIFEST_URL ?? DEFAULT_MANIFEST;
    const manifest = await fetchJSON(fetchImpl, manifestURL);
    release = validateRuntimeManifest(manifest);
  }
  if (proxyUpgrade && installedRuntimeTag(home) === release.tag) return existing;
  const archive = await fetchBytes(fetchImpl, release.url);
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== release.sha256) throw new Error('Pilot runtime archive checksum did not match the pinned distribution digest');

  const pilotRoot = join(home, '.pilot');
  const binDirectory = join(pilotRoot, 'bin');
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
    mkdirSync(binDirectory, { recursive: true, mode: 0o700 });
    chmodSync(binDirectory, 0o700);
    installBinary(join(stage, 'daemon'), join(binDirectory, 'pilot-daemon'));
    installBinary(join(stage, 'pilotctl'), join(binDirectory, 'pilotctl'));
    if (existsSync(join(stage, 'updater'))) installBinary(join(stage, 'updater'), join(binDirectory, 'pilot-updater'));
    writeFileSync(join(binDirectory, '.pilot-version'), `${release.tag}\n`, { mode: 0o600 });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  const installed = join(binDirectory, 'pilotctl');
  if (requireManaged && !supportsManagedAdoption(installed)) {
    throw new Error(`Pilot ${release.tag} does not contain hosted adoption support`);
  }
  return installed;
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
export function supportsEgressProxy(daemon) {
  if (!daemon || !existsSync(daemon)) return false;
  const probe = spawnSync(daemon, ['-h'], { encoding: 'utf8', timeout: 5_000 });
  return /^\s*-proxy\b(?!-)/m.test(`${probe.stdout ?? ''}\n${probe.stderr ?? ''}`);
}

function installedRuntimeTag(home) {
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
