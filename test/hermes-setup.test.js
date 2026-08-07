import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

test('Hermes setup merges native pre/post hooks without replacing existing YAML', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-hermes-home-'));
  const config = join(home, '.hermes', 'config.yaml');
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, '# operator config\nmodel: gemini/example\nhooks:\n  on_session_start:\n    - command: existing-hook\n');
  const moduleURL = pathToFileURL(join(process.cwd(), 'src', 'setup', 'harnesses', 'hermes.js')).href;
  const script = `const mod = await import(${JSON.stringify(moduleURL)}); await mod.configure(); await mod.configure();`;
  execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(), env: { ...process.env, HOME: home }, stdio: 'pipe',
  });
  const source = readFileSync(config, 'utf8');
  const result = parse(source);
  assert.match(source, /# operator config/);
  assert.equal(result.model, 'gemini/example');
  assert.equal(result.hooks.on_session_start[0].command, 'existing-hook');
  assert.equal(result.hooks.pre_tool_call.length, 1);
  assert.equal(result.hooks.pre_tool_call[0].command, 'npx -y pilotprotocol-mcp@0.2.13 hook --harness hermes --phase pre');
  assert.equal(result.hooks.post_tool_call.length, 1);
  assert.deepEqual(result.mcp_servers.pilot.args, ['-y', 'pilotprotocol-mcp@0.2.13']);
  const allowlist = JSON.parse(readFileSync(join(home, '.hermes', 'shell-hooks-allowlist.json'), 'utf8'));
  assert.deepEqual(allowlist.approvals, [
    { event: 'pre_tool_call', command: 'npx -y pilotprotocol-mcp@0.2.13 hook --harness hermes --phase pre' },
    { event: 'post_tool_call', command: 'npx -y pilotprotocol-mcp@0.2.13 hook --harness hermes --phase post' },
  ]);
});
