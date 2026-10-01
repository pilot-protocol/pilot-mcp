import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

function configure(home) {
  const moduleURL = pathToFileURL(join(process.cwd(), 'src', 'setup', 'harnesses', 'hermes.js')).href;
  const script = `const mod = await import(${JSON.stringify(moduleURL)}); await mod.configure(); await mod.configure();`;
  execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(), env: { ...process.env, HOME: home }, stdio: 'pipe',
  });
}

test('Hermes setup merges the MCP server without replacing existing YAML or adding hooks', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-hermes-home-'));
  const config = join(home, '.hermes', 'config.yaml');
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, '# operator config\nmodel: gemini/example\nhooks:\n  on_session_start:\n    - command: existing-hook\n');
  configure(home);
  const source = readFileSync(config, 'utf8');
  const result = parse(source);
  assert.match(source, /# operator config/);
  assert.equal(result.model, 'gemini/example');
  assert.deepEqual(result.hooks, { on_session_start: [{ command: 'existing-hook' }] });
  assert.deepEqual(result.mcp_servers.pilot.args, ['-y', 'pilotprotocol-mcp@0.4.0']);
  assert.equal(existsSync(join(home, '.hermes', 'shell-hooks-allowlist.json')), false);
});

test('Hermes setup removes the retired Pilot hooks and approvals and keeps the operator\'s own', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-hermes-retired-'));
  const config = join(home, '.hermes', 'config.yaml');
  const allowlist = join(home, '.hermes', 'shell-hooks-allowlist.json');
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, [
    'hooks:',
    '  pre_tool_call:',
    '    - matcher: ".*"',
    '      command: npx -y pilotprotocol-mcp@0.3.0 hook --harness hermes --phase pre',
    '      timeout: 30',
    '    - command: operator-pre-hook',
    '  post_tool_call:',
    '    - matcher: ".*"',
    '      command: npx -y pilotprotocol-mcp@0.2.13 hook --harness hermes --phase post',
    '      timeout: 30',
    '',
  ].join('\n'));
  writeFileSync(allowlist, JSON.stringify({ approvals: [
    { event: 'pre_tool_call', command: 'npx -y pilotprotocol-mcp@0.3.0 hook --harness hermes --phase pre' },
    { event: 'post_tool_call', command: 'npx -y pilotprotocol-mcp@0.2.13 hook --harness hermes --phase post' },
    { event: 'pre_tool_call', command: 'operator-pre-hook' },
  ] }));
  configure(home);
  const result = parse(readFileSync(config, 'utf8'));
  assert.deepEqual(result.hooks, { pre_tool_call: [{ command: 'operator-pre-hook' }] });
  assert.deepEqual(JSON.parse(readFileSync(allowlist, 'utf8')).approvals, [
    { event: 'pre_tool_call', command: 'operator-pre-hook' },
  ]);
});

test('Hermes setup drops an empty hooks map once only Pilot hooks were in it', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-hermes-only-'));
  const config = join(home, '.hermes', 'config.yaml');
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, 'model: x\nhooks:\n  pre_tool_call:\n    - command: npx -y pilotprotocol-mcp@0.3.0 hook --harness hermes --phase pre\n');
  configure(home);
  const result = parse(readFileSync(config, 'utf8'));
  assert.equal('hooks' in result, false);
  assert.equal(result.model, 'x');
});
