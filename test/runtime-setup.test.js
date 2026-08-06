import test from 'node:test';
import assert from 'node:assert/strict';
import { managedRuntimeRelease, validateRuntimeManifest } from '../src/setup/runtime.js';

const digest = 'a'.repeat(64);

test('runtime manifest binds the archive to the stable Pilot release', () => {
  const result = validateRuntimeManifest({
    latest_stable: 'v1.14.0',
    platforms: {
      'darwin-arm64': {
        url: 'https://github.com/pilot-protocol/pilotprotocol/releases/download/v1.14.0/pilot-darwin-arm64.tar.gz',
        sha256: digest,
      },
    },
  }, 'darwin', 'arm64');
  assert.equal(result.tag, 'v1.14.0');
  assert.equal(result.sha256, digest);
});

test('runtime manifest rejects cross-repository and cross-version substitution', () => {
  for (const url of [
    'https://evil.example/pilot-darwin-arm64.tar.gz',
    'https://github.com/attacker/pilotprotocol/releases/download/v1.14.0/pilot-darwin-arm64.tar.gz',
    'https://github.com/pilot-protocol/pilotprotocol/releases/download/v1.13.9/pilot-darwin-arm64.tar.gz',
  ]) {
    assert.throws(() => validateRuntimeManifest({
      latest_stable: 'v1.14.0', platforms: { 'darwin-arm64': { url, sha256: digest } },
    }, 'darwin', 'arm64'), /invalid runtime/);
  }
});

test('managed setup selects a release asset pinned in the published installer', () => {
  const release = managedRuntimeRelease('linux', 'x64');
  assert.equal(release.tag, 'managed-runtime-v0.1.1');
  assert.match(release.url, /pilot-linux-amd64\.tar\.gz$/);
  assert.match(release.sha256, /^[a-f0-9]{64}$/);
});
