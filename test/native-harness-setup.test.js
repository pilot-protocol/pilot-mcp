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

const PRE = (harness, version = '0.3.0') => `npx -y pilotprotocol-mcp@${version} hook --harness ${harness} --phase pre`;
const POST = (harness, version = '0.3.0') => `npx -y pilotprotocol-mcp@${version} hook --harness ${harness} --phase post`;

function writeJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

test('Cursor setup writes MCP config and no hooks, and removes only the retired Pilot hooks', () => {
  const fresh = mkdtempSync(join(tmpdir(), 'pilot-cursor-home-'));
  configureInHome('cursor', fresh);
  assert.deepEqual(JSON.parse(readFileSync(join(fresh, '.cursor', 'mcp.json'), 'utf8')).mcpServers.pilot.args, ['-y', 'pilotprotocol-mcp@0.4.0']);
  assert.equal(existsSync(join(fresh, '.cursor', 'hooks.json')), false);

  const owned = mkdtempSync(join(tmpdir(), 'pilot-cursor-owned-'));
  configureInHome('cursor', owned, (dir) => writeJSON(join(dir, '.cursor', 'hooks.json'), {
    version: 1,
    hooks: {
      preToolUse: [{ command: PRE('cursor'), timeout: 30, failClosed: true }],
      postToolUse: [{ command: POST('cursor', '0.2.13'), timeout: 30 }],
      postToolUseFailure: [{ command: POST('cursor'), timeout: 30 }],
    },
  }));
  assert.equal(existsSync(join(owned, '.cursor', 'hooks.json')), false);

  const mixed = mkdtempSync(join(tmpdir(), 'pilot-cursor-mixed-'));
  configureInHome('cursor', mixed, (dir) => writeJSON(join(dir, '.cursor', 'hooks.json'), {
    version: 1,
    hooks: {
      preToolUse: [{ command: PRE('cursor'), timeout: 30, failClosed: true }, { command: 'customer-hook' }],
      beforeShellExecution: [{ command: 'customer-shell-hook' }],
    },
  }));
  assert.deepEqual(JSON.parse(readFileSync(join(mixed, '.cursor', 'hooks.json'), 'utf8')), {
    version: 1,
    hooks: {
      preToolUse: [{ command: 'customer-hook' }],
      beforeShellExecution: [{ command: 'customer-shell-hook' }],
    },
  });
});

test('Cline setup writes MCP config, removes retired Pilot hook shims, and never touches a user hook', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-cline-home-'));
  const hooks = join(home, '.cline', 'hooks');
  const legacy = join(home, 'Documents', 'Cline', 'Hooks');
  configureInHome('cline', home, () => {
    mkdirSync(hooks, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(hooks, 'PreToolUse'), `#!/bin/sh\nexec ${PRE('cline')}\n`);
    writeFileSync(join(hooks, 'PostToolUse.ps1'), `& ${POST('cline', '0.2.13')}\nexit $LASTEXITCODE\n`);
    writeFileSync(join(legacy, 'PostToolUse'), `#!/bin/sh\nexec ${POST('cline')}\n`);
  });
  assert.equal(existsSync(join(hooks, 'PreToolUse')), false);
  assert.equal(existsSync(join(hooks, 'PostToolUse.ps1')), false);
  assert.equal(existsSync(join(legacy, 'PostToolUse')), false);
  const mcp = JSON.parse(readFileSync(join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers.pilot.args, ['-y', 'pilotprotocol-mcp@0.4.0']);

  const userHome = mkdtempSync(join(tmpdir(), 'pilot-cline-user-hook-'));
  const target = join(userHome, '.cline', 'hooks', 'PreToolUse');
  configureInHome('cline', userHome, () => {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '#!/bin/sh\nexec existing-hook\n');
  });
  assert.match(readFileSync(target, 'utf8'), /existing-hook/);

  const fresh = mkdtempSync(join(tmpdir(), 'pilot-cline-fresh-'));
  configureInHome('cline', fresh);
  assert.equal(existsSync(join(fresh, '.cline', 'hooks')), false);
});

test('Copilot setup writes MCP config and removes the retired Pilot hook file', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-copilot-home-'));
  const hooksPath = join(home, '.copilot', 'hooks', 'pilot.json');
  configureInHome('copilot', home, () => writeJSON(hooksPath, {
    version: 1,
    hooks: {
      preToolUse: [{ type: 'command', bash: PRE('copilot'), powershell: PRE('copilot'), timeoutSec: 30 }],
      postToolUse: [{ type: 'command', command: POST('copilot', '0.2.13') }],
      postToolUseFailure: [{ type: 'command', bash: POST('copilot'), powershell: POST('copilot'), timeoutSec: 30 }],
    },
  }));
  assert.equal(existsSync(hooksPath), false);
  const mcp = JSON.parse(readFileSync(join(home, '.copilot', 'mcp-config.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers.pilot.args, ['-y', 'pilotprotocol-mcp@0.4.0']);

  const fresh = mkdtempSync(join(tmpdir(), 'pilot-copilot-fresh-'));
  configureInHome('copilot', fresh);
  assert.equal(existsSync(join(fresh, '.copilot', 'hooks')), false);
});

test('PicoClaw setup registers MCP, removes the retired process hook, and keeps other process hooks', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-pico-home-'));
  configureInHome('picoclaw', home, (dir) => writeJSON(join(dir, '.picoclaw', 'config.json'), {
    hooks: {
      enabled: true,
      defaults: { interceptor_timeout_ms: 30000 },
      processes: {
        pilot: {
          enabled: true, priority: 10, transport: 'stdio',
          command: ['npx', '-y', 'pilotprotocol-mcp@0.3.0', 'picoclaw-hook'],
          intercept: ['before_tool', 'after_tool'],
        },
        customer: { enabled: true, command: ['customer-hook'] },
      },
    },
  }));
  const config = JSON.parse(readFileSync(join(home, '.picoclaw', 'config.json'), 'utf8'));
  assert.equal(config.tools.mcp.enabled, true);
  assert.equal(config.tools.mcp.servers.pilot.enabled, true);
  assert.deepEqual(config.tools.mcp.servers.pilot.args, ['-y', 'pilotprotocol-mcp@0.4.0']);
  assert.deepEqual(config.hooks, {
    enabled: true,
    defaults: { interceptor_timeout_ms: 30000 },
    processes: { customer: { enabled: true, command: ['customer-hook'] } },
  });

  const fresh = mkdtempSync(join(tmpdir(), 'pilot-pico-fresh-'));
  configureInHome('picoclaw', fresh, (dir) => writeJSON(join(dir, '.picoclaw', 'config.json'), {}));
  assert.equal('hooks' in JSON.parse(readFileSync(join(fresh, '.picoclaw', 'config.json'), 'utf8')), false);

  // A process hook the user happens to call "pilot" is not Pilot's to remove.
  const named = mkdtempSync(join(tmpdir(), 'pilot-pico-named-'));
  configureInHome('picoclaw', named, (dir) => writeJSON(join(dir, '.picoclaw', 'config.json'), {
    hooks: { processes: { pilot: { command: ['my-own-pilot-hook'] } } },
  }));
  assert.deepEqual(
    JSON.parse(readFileSync(join(named, '.picoclaw', 'config.json'), 'utf8')).hooks.processes.pilot,
    { command: ['my-own-pilot-hook'] },
  );
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

test('OpenClaw setup installs the bundled plugin that carries the MCP server, with no tool hooks', () => {
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
    // What a release <=0.3.0 left behind in the linked plugin directory.
    const stale = join(dir, '.pilot', 'integrations', 'openclaw-policy', 'evaluate.js');
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, 'export const evaluate = () => ({ blocked: true });\n');
  }, { PATH: `${bin}:${process.env.PATH ?? ''}` });
  const installed = join(home, '.pilot', 'integrations', 'openclaw-policy');
  assert.equal(existsSync(join(installed, 'openclaw.plugin.json')), true);
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /plugins\ninstall\n--link\n[^\n]*openclaw-policy/);
  assert.match(calls, /plugins\nenable\npilot-policy/);
  assert.match(calls, /plugins\ninspect\npilot-policy\n--json/);
  const manifest = JSON.parse(readFileSync(join(installed, 'openclaw.plugin.json'), 'utf8'));
  assert.deepEqual(manifest.mcpServers.pilot.args, ['-y', 'pilotprotocol-mcp@0.4.0']);
  assert.equal(existsSync(join(installed, 'evaluate.js')), false);
  const entry = readFileSync(join(installed, 'index.js'), 'utf8');
  assert.doesNotMatch(entry, /api\.on\(|before_tool_call|after_tool_call|message_sending|child_process/);
});

test('OpenClaw setup can report a missing optional host instead of failing', async () => {
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
