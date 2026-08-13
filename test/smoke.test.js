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
  let errOut = '';
  p.stderr.on('data', (d) => { errOut += d; });
  const req = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
  }) + '\n';
  await new Promise((resolve, reject) => {
    p.stdin.write(req, (error) => error ? reject(error) : resolve());
  });
  const responseLine = await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      p.stdout.off('data', onData);
      p.off('error', onError);
      p.off('exit', onExit);
    };
    const finish = (fn, value) => {
      cleanup();
      fn(value);
    };
    const onData = (d) => {
      out += d;
      const line = out.split('\n').find((candidate) => candidate.includes('"serverInfo"'));
      if (line) finish(resolve, line);
    };
    const onError = (error) => finish(reject, error);
    const onExit = (code, signal) => finish(reject, new Error(
      `MCP server exited before initialize response (code=${code}, signal=${signal}, stderr=${errOut.slice(0, 200)})`,
    ));
    const timer = setTimeout(() => finish(reject, new Error(
      `no serverInfo within 10s; stdout=${out.slice(0, 200)} stderr=${errOut.slice(0, 200)}`,
    )), 10_000);
    p.stdout.on('data', onData);
    p.once('error', onError);
    p.once('exit', onExit);
  });
  p.kill();
  const response = JSON.parse(responseLine);
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(response.result.serverInfo.version, pkg.version);
});

test('cli --version prints the package version', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)(process.execPath, [join(root, 'cli.js'), '--version']);
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(stdout.trim(), pkg.version);
});
