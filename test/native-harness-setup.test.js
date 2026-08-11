import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

function configureInHome(id, home, fixture, env = {}, options = {}) {
  fixture?.(home);
  const moduleURL = pathToFileURL(join(process.cwd(), 'src', 'setup', 'harnesses', `${id}.js`)).href;
  execFileSync(process.execPath, ['--input-type=module', '--eval', `const mod=await import(${JSON.stringify(moduleURL)}); await mod.configure(${JSON.stringify(options)}); await mod.configure(${JSON.stringify(options)});`], {
    cwd: process.cwd(), env: { ...process.env, HOME: home, ...env }, stdio: 'pipe',
  });
}

test('Cursor setup installs an idempotent fail-closed native tool boundary', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-cursor-home-'));
  configureInHome('cursor', home);
  const hooks = JSON.parse(readFileSync(join(home, '.cursor', 'hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.preToolUse.length, 1);
  assert.equal(hooks.hooks.preToolUse[0].failClosed, true);
  assert.match(hooks.hooks.preToolUse[0].command, /^npx -y pilotprotocol-mcp@0\.2\.13 /);
  assert.match(hooks.hooks.preToolUse[0].command, /--harness cursor --phase pre/);
});

test('Cline setup installs current global pre/post hook shims without replacing an existing hook', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-cline-home-'));
  configureInHome('cline', home);
  const pre = readFileSync(join(home, '.cline', 'hooks', 'PreToolUse'), 'utf8');
  const post = readFileSync(join(home, '.cline', 'hooks', 'PostToolUse'), 'utf8');
  assert.match(pre, /exec npx -y pilotprotocol-mcp@0\.2\.13 hook/);
  assert.match(pre, /--harness cline --phase pre/);
  assert.match(post, /--harness cline --phase post/);
  const mcp = JSON.parse(readFileSync(join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers.pilot.args, ['-y', 'pilotprotocol-mcp@0.2.13']);

  const conflictHome = mkdtempSync(join(tmpdir(), 'pilot-cline-conflict-'));
  const target = join(conflictHome, '.cline', 'hooks', 'PreToolUse');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, '#!/bin/sh\nexec existing-hook\n');
  assert.throws(() => configureInHome('cline', conflictHome), /already has a global PreToolUse hook/);
  assert.match(readFileSync(target, 'utf8'), /existing-hook/);
});

test('Cline setup emits the only Windows hook filename and PowerShell contract Cline discovers', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-cline-windows-'));
  configureInHome('cline', home, undefined, {}, { platform: 'win32' });
  // configure() uses the host platform; exercise the exported writer directly
  // for the cross-platform artifact that cannot run natively on this host.
  const moduleURL = pathToFileURL(join(process.cwd(), 'src', 'setup', 'harnesses', 'cline.js')).href;
  execFileSync(process.execPath, ['--input-type=module', '--eval', `const mod=await import(${JSON.stringify(moduleURL)}); mod.installNativeHook('PreToolUse','pre','win32');`], {
    cwd: process.cwd(), env: { ...process.env, HOME: home }, stdio: 'pipe',
  });
  const source = readFileSync(join(home, '.cline', 'hooks', 'PreToolUse.ps1'), 'utf8');
  assert.match(source, /^& npx -y pilotprotocol-mcp@0\.2\.13 hook --harness cline --phase pre/m);
  assert.match(source, /LASTEXITCODE/);
});

test('Copilot setup writes the documented cross-platform command-hook fields', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-copilot-home-'));
  configureInHome('copilot', home);
  const hooks = JSON.parse(readFileSync(join(home, '.copilot', 'hooks', 'pilot.json'), 'utf8'));
  const pre = hooks.hooks.preToolUse[0];
  assert.equal(pre.type, 'command');
  assert.equal(pre.bash, pre.powershell);
  assert.match(pre.bash, /^npx -y pilotprotocol-mcp@0\.2\.13 /);
  assert.equal(pre.command, undefined);
  const mcp = JSON.parse(readFileSync(join(home, '.copilot', 'mcp-config.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers.pilot.args, ['-y', 'pilotprotocol-mcp@0.2.13']);
});

test('PicoClaw setup attaches the native process hook as a fixed argv array', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-pico-home-'));
  configureInHome('picoclaw', home, (dir) => {
    const target = join(dir, '.picoclaw', 'config.json');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '{}');
  });
  const config = JSON.parse(readFileSync(join(home, '.picoclaw', 'config.json'), 'utf8'));
  assert.equal(config.tools.mcp.enabled, true);
  assert.equal(config.tools.mcp.servers.pilot.enabled, true);
  assert.deepEqual(config.hooks.processes.pilot.command, ['npx', '-y', 'pilotprotocol-mcp@0.2.13', 'picoclaw-hook']);
  assert.deepEqual(config.hooks.processes.pilot.intercept, ['before_tool', 'after_tool']);
});

test('PicoClaw setup never reports a nonexistent installation as configured', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-pico-missing-'));
  const { configure } = await import('../src/setup/harnesses/picoclaw.js');
  assert.deepEqual(
    await configure({ home, allowMissingHost: true }),
    { skipped: true, reason: 'PicoClaw configuration was not found' },
  );
  await assert.rejects(configure({ home }), /PicoClaw configuration was not found/);
});

test('OpenClaw setup installs the bundled native policy plugin in one pass', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-openclaw-home-'));
  const bin = join(home, 'bin');
  const log = join(home, 'openclaw.args');
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, 'openclaw');
  // Mirror the real CLI, which rejects --force alongside --link. A permissive stub is
  // what let the unsupported flag pair ship green.
  writeFileSync(executable, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" >> ${JSON.stringify(log)}`,
    `printf '%s\\n' -- >> ${JSON.stringify(log)}`,
    'case " $* " in *" --link "*)',
    '  case " $* " in *" --force "*)',
    '    echo "--force is not supported with --link." >&2; exit 1;;',
    '  esac;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(executable, 0o700);
  configureInHome('openclaw', home, (dir) => {
    const target = join(dir, '.openclaw', 'openclaw.json');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '{}');
  }, { PATH: `${bin}:${process.env.PATH ?? ''}` });
  const installed = join(home, '.pilot', 'integrations', 'openclaw-policy');
  assert.equal(existsSync(join(installed, 'openclaw.plugin.json')), true);
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /plugins\ninstall\n--link\n[^\n]*openclaw-policy/);
  assert.match(calls, /plugins\nenable\npilot-policy/);
  assert.match(calls, /plugins\ninspect\npilot-policy\n--json/);
  const manifest = JSON.parse(readFileSync(join(installed, 'openclaw.plugin.json'), 'utf8'));
  assert.deepEqual(manifest.mcpServers.pilot.args, ['-y', 'pilotprotocol-mcp@0.2.13']);
});

test('OpenClaw setup reports a missing optional host during attach --all', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-openclaw-missing-'));
  const { configure } = await import('../src/setup/harnesses/openclaw.js');
  const missingHost = Object.assign(new Error('spawn openclaw ENOENT'), { code: 'ENOENT' });
  const result = await configure({
    home,
    allowMissingHost: true,
    execFileAsync: async () => { throw missingHost; },
  });

  assert.deepEqual(result, { skipped: true, reason: 'OpenClaw CLI is not installed' });
  assert.equal(existsSync(join(home, '.pilot', 'integrations', 'openclaw-policy', 'openclaw.plugin.json')), true);

  await assert.rejects(
    configure({
      home: mkdtempSync(join(tmpdir(), 'pilot-openclaw-required-')),
      execFileAsync: async () => { throw missingHost; },
    }),
    /spawn openclaw ENOENT/,
  );
});
