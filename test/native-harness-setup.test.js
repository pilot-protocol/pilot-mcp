import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

function configureInHome(id, home, fixture, env = {}) {
  fixture?.(home);
  const moduleURL = pathToFileURL(join(process.cwd(), 'src', 'setup', 'harnesses', `${id}.js`)).href;
  execFileSync(process.execPath, ['--input-type=module', '--eval', `const mod=await import(${JSON.stringify(moduleURL)}); await mod.configure(); await mod.configure();`], {
    cwd: process.cwd(), env: { ...process.env, HOME: home, ...env }, stdio: 'pipe',
  });
}

test('Cursor setup installs an idempotent fail-closed native tool boundary', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-cursor-home-'));
  configureInHome('cursor', home);
  const hooks = JSON.parse(readFileSync(join(home, '.cursor', 'hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.preToolUse.length, 1);
  assert.equal(hooks.hooks.preToolUse[0].failClosed, true);
  assert.match(hooks.hooks.preToolUse[0].command, /^npx -y pilotprotocol-mcp@0\.2\.11 /);
  assert.match(hooks.hooks.preToolUse[0].command, /--harness cursor --phase pre/);
});

test('Cline setup installs executable global pre/post hook shims without replacing an existing hook', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-cline-home-'));
  configureInHome('cline', home);
  const pre = readFileSync(join(home, 'Documents', 'Cline', 'Hooks', 'PreToolUse'), 'utf8');
  const post = readFileSync(join(home, 'Documents', 'Cline', 'Hooks', 'PostToolUse'), 'utf8');
  assert.match(pre, /exec npx -y pilotprotocol-mcp@0\.2\.11 hook/);
  assert.match(pre, /--harness cline --phase pre/);
  assert.match(post, /--harness cline --phase post/);

  const conflictHome = mkdtempSync(join(tmpdir(), 'pilot-cline-conflict-'));
  const target = join(conflictHome, 'Documents', 'Cline', 'Hooks', 'PreToolUse');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, '#!/bin/sh\nexec existing-hook\n');
  assert.throws(() => configureInHome('cline', conflictHome), /already has a global PreToolUse hook/);
  assert.match(readFileSync(target, 'utf8'), /existing-hook/);
});

test('Copilot setup writes the documented cross-platform command-hook fields', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-copilot-home-'));
  configureInHome('copilot', home);
  const hooks = JSON.parse(readFileSync(join(home, '.copilot', 'hooks', 'pilot.json'), 'utf8'));
  const pre = hooks.hooks.preToolUse[0];
  assert.equal(pre.type, 'command');
  assert.equal(pre.bash, pre.powershell);
  assert.match(pre.bash, /^npx -y pilotprotocol-mcp@0\.2\.11 /);
  assert.equal(pre.command, undefined);
});

test('PicoClaw setup attaches the native process hook as a fixed argv array', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-pico-home-'));
  configureInHome('picoclaw', home, (dir) => {
    const target = join(dir, '.picoclaw', 'config.json');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '{}');
  });
  const config = JSON.parse(readFileSync(join(home, '.picoclaw', 'config.json'), 'utf8'));
  assert.deepEqual(config.hooks.processes.pilot.command, ['npx', '-y', 'pilotprotocol-mcp@0.2.11', 'picoclaw-hook']);
  assert.deepEqual(config.hooks.processes.pilot.intercept, ['before_tool', 'after_tool']);
});

test('OpenClaw setup installs the bundled native policy plugin in one pass', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-openclaw-home-'));
  const bin = join(home, 'bin');
  const log = join(home, 'openclaw.args');
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, 'openclaw');
  writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\n`);
  chmodSync(executable, 0o700);
  configureInHome('openclaw', home, (dir) => {
    const target = join(dir, '.openclaw', 'openclaw.json');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '{}');
  }, { PATH: `${bin}:${process.env.PATH ?? ''}` });
  const installed = join(home, '.pilot', 'integrations', 'openclaw-policy');
  assert.equal(existsSync(join(installed, 'openclaw.plugin.json')), true);
  assert.match(readFileSync(log, 'utf8'), /plugins\ninstall\n--link/);
});
