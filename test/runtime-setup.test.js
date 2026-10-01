import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeManifest } from '../src/setup/runtime.js';

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
