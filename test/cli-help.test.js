// `--help` must only list commands that work. The HTTP transport is a stub,
// so `serve` stays out of the help text and exits non-zero.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'cli.js');

test('help does not advertise the HTTP transport', async () => {
  const { stdout } = await run(process.execPath, [cli, '--help']);
  assert.doesNotMatch(stdout, /pilot-mcp serve/i, 'help lists `serve`, which is not implemented');
  assert.doesNotMatch(stdout, /--http|Streamable HTTP/i);
  assert.doesNotMatch(stdout, /uninstall/i, 'help advertises adapter uninstall before it is implemented');
  assert.match(stdout, /Start stdio MCP server/);
});

test('advertised doctor and tour commands execute against the packaged runtime bridge', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-cli-contract-'));
  const binary = join(home, 'pilotctl');
  writeFileSync(binary, '#!/bin/sh\nprintf \'%s\\n\' \'{"data":{"items":[{"hostname":"weather.test"}]}}\'\n');
  chmodSync(binary, 0o700);
  const env = { ...process.env, HOME: home, PILOTCTL_BIN: binary, PILOT_SOCKET: join(home, 'missing.sock') };
  const doctor = await run(process.execPath, [cli, 'doctor', '--json'], { env });
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.runtime.ok, true);
  assert.equal(report.management.attached, false);
  const tour = await run(process.execPath, [cli, 'tour'], { env });
  assert.match(tour.stdout, /weather\.test/);
});

test('identity export and import are real, owner-only lifecycle operations', async () => {
  const sourceHome = mkdtempSync(join(tmpdir(), 'pilot-identity-source-'));
  const identityPath = join(sourceHome, '.pilot', 'identity.json');
  mkdirSync(dirname(identityPath), { recursive: true });
  writeFileSync(identityPath, '{"node_id":"node-a","private_key":"secret"}\n', { mode: 0o600 });
  const portable = join(sourceHome, 'portable.json');
  await run(process.execPath, [cli, 'export-identity', portable], { env: { ...process.env, HOME: sourceHome } });
  assert.equal(existsSync(portable), true);
  assert.equal(readFileSync(portable, 'utf8').includes('node-a'), true);

  const targetHome = mkdtempSync(join(tmpdir(), 'pilot-identity-target-'));
  await run(process.execPath, [cli, 'import-identity', portable], { env: { ...process.env, HOME: targetHome } });
  const imported = join(targetHome, '.pilot', 'identity.json');
  assert.deepEqual(JSON.parse(readFileSync(imported, 'utf8')), { node_id: 'node-a', private_key: 'secret' });
  assert.equal(readFileSync(imported).length > 0, true);
});

test('serve exits non-zero and says the HTTP transport is unavailable', async () => {
  await assert.rejects(
    run(process.execPath, [cli, 'serve', '--http']),
    (err) => {
      assert.strictEqual(err.code, 2);
      assert.match(err.stderr, /not implemented/i);
      return true;
    },
  );
});

test('obsolete Claude heartbeat hook is a silent non-blocking compatibility shim', async () => {
  const { stdout, stderr } = await run(
    process.execPath,
    [cli, 'heartbeat', '--claude'],
    { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' }) },
  );
  assert.strictEqual(stdout, '');
  assert.strictEqual(stderr, '');
});

test('legacy heartbeat rejects unsupported invocations', async () => {
  await assert.rejects(
    run(process.execPath, [cli, 'heartbeat', '--cursor'], { input: '{}' }),
    (err) => {
      assert.strictEqual(err.code, 1);
      assert.match(err.stderr, /only --claude is supported/i);
      return true;
    },
  );
});

test('no manifest or source string claims bearer-token auth for the HTTP transport', () => {
  for (const rel of ['src/mcp-http.js', 'cli.js', 'server.json']) {
    const text = readFileSync(join(root, rel), 'utf8');
    assert.doesNotMatch(text, /mcp-token/, `${rel} references an unimplemented token file`);
  }
  const serverJson = JSON.parse(readFileSync(join(root, 'server.json'), 'utf8'));
  assert.strictEqual(serverJson.remotes, undefined, 'server.json advertises an HTTP remote that does not exist');
});
