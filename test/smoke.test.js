// Smoke test: the stdio MCP server must boot and answer `initialize`.
// This is the same gate publish-mcp.yml runs before npm publish — having
// it in `npm test` means a plain `node --test` catches a broken server
// before anything ships (the pre-0.1.0 schema-registration bug would
// have been caught here).
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('stdio server answers initialize with serverInfo', async () => {
  const p = spawn(process.execPath, [join(root, 'cli.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  const req = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
  }) + '\n';
  await new Promise((r) => setTimeout(r, 500));
  p.stdin.write(req);
  await new Promise((r) => setTimeout(r, 2500));
  p.kill();
  assert.match(out, /"serverInfo"/, `no serverInfo in output: ${out.slice(0, 200)}`);
});

test('cli --version prints the package version', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)(process.execPath, [join(root, 'cli.js'), '--version']);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});
