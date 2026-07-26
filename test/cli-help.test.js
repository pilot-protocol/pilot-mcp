// `--help` must only list commands that work. The HTTP transport is a stub,
// so `serve` stays out of the help text and exits non-zero.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'cli.js');

test('help does not advertise the HTTP transport', async () => {
  const { stdout } = await run(process.execPath, [cli, '--help']);
  assert.doesNotMatch(stdout, /pilot-mcp serve/i, 'help lists `serve`, which is not implemented');
  assert.doesNotMatch(stdout, /--http|Streamable HTTP/i);
  assert.match(stdout, /Start stdio MCP server/);
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

test('no manifest or source string claims bearer-token auth for the HTTP transport', () => {
  for (const rel of ['src/mcp-http.js', 'cli.js', 'server.json']) {
    const text = readFileSync(join(root, rel), 'utf8');
    assert.doesNotMatch(text, /mcp-token/, `${rel} references an unimplemented token file`);
  }
  const serverJson = JSON.parse(readFileSync(join(root, 'server.json'), 'utf8'));
  assert.strictEqual(serverJson.remotes, undefined, 'server.json advertises an HTTP remote that does not exist');
});
