import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const ROOT = process.cwd();

function configureInHome(id, home, options = {}) {
  const moduleURL = pathToFileURL(join(ROOT, 'src', 'setup', 'harnesses', `${id}.js`)).href;
  const script = `const mod=await import(${JSON.stringify(moduleURL)}); await mod.configure(${JSON.stringify(options)}); await mod.configure(${JSON.stringify(options)});`;
  execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: ROOT, env: { ...process.env, HOME: home }, stdio: 'pipe',
  });
}

function writeJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

test('Claude registers MCP in ~/.claude.json, migrates stale entries, and removes only retired Pilot hooks', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-claude-contract-'));
  const settingsPath = join(home, '.claude', 'settings.json');
  writeJSON(settingsPath, {
    theme: 'dark',
    mcpServers: {
      pilot: { command: 'npx', args: ['-y', 'pilotprotocol-mcp@0.2.5'] },
      customer: { command: 'customer-mcp' },
    },
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'npx -y pilotprotocol-mcp@0.2.5 heartbeat --claude' }] }],
      PreToolUse: [
        { hooks: [{ type: 'command', command: 'npx -y pilotprotocol-mcp@0.3.0 hook --harness claude --phase pre', timeout: 30 }] },
        { matcher: 'Bash', hooks: [
          { type: 'command', command: 'customer-pre-hook' },
          { type: 'command', command: 'npx -y pilotprotocol-mcp@0.2.13 hook --harness claude --phase pre' },
        ] },
      ],
      PostToolUse: [{ hooks: [{ type: 'command', command: 'npx -y pilotprotocol-mcp@0.3.0 hook --harness claude --phase post', timeout: 30 }] }],
      PostToolUseFailure: [{ hooks: [{ type: 'command', command: 'pilot-mcp hook --harness claude --phase post' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'customer-stop-hook' }] }],
    },
  });
  configureInHome('claude', home);

  const mcp = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers.pilot.args, ['-y', 'pilotprotocol-mcp@0.4.0']);
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.theme, 'dark');
  assert.deepEqual(settings.mcpServers, { customer: { command: 'customer-mcp' } });
  assert.deepEqual(settings.hooks, {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'customer-pre-hook' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'customer-stop-hook' }] }],
  });
});

test('Claude setup leaves settings.json alone when it holds no Pilot hook, and drops an emptied hooks map', () => {
  const untouched = mkdtempSync(join(tmpdir(), 'pilot-claude-untouched-'));
  const untouchedPath = join(untouched, '.claude', 'settings.json');
  const source = '{\n    "theme": "dark",\n    "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "customer-stop-hook" }] }] }\n}\n';
  mkdirSync(dirname(untouchedPath), { recursive: true });
  writeFileSync(untouchedPath, source);
  configureInHome('claude', untouched);
  assert.equal(readFileSync(untouchedPath, 'utf8'), source);

  const fresh = mkdtempSync(join(tmpdir(), 'pilot-claude-fresh-'));
  configureInHome('claude', fresh);
  assert.equal(existsSync(join(fresh, '.claude', 'settings.json')), false);

  const onlyPilot = mkdtempSync(join(tmpdir(), 'pilot-claude-only-'));
  const onlyPath = join(onlyPilot, '.claude', 'settings.json');
  writeJSON(onlyPath, {
    theme: 'dark',
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'npx -y pilotprotocol-mcp@0.3.0 hook --harness claude --phase pre' }] }] },
  });
  configureInHome('claude', onlyPilot);
  assert.deepEqual(JSON.parse(readFileSync(onlyPath, 'utf8')), { theme: 'dark' });
});

test('Gemini writes current MCP user settings idempotently and removes only retired Pilot hooks', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-gemini-contract-'));
  const settingsPath = join(home, '.gemini', 'settings.json');
  writeJSON(settingsPath, {
    mcpServers: { customer: { command: 'customer-mcp' } },
    hooksConfig: { enabled: true },
    hooks: {
      BeforeTool: [
        { matcher: '.*', sequential: true, hooks: [{ type: 'command', name: 'pilot-pre-tool', command: 'npx -y pilotprotocol-mcp@0.3.0 hook --harness gemini --phase pre', timeout: 30000 }] },
        { matcher: 'shell', hooks: [{ type: 'command', command: 'customer-hook' }] },
      ],
      AfterTool: [{ matcher: '.*', sequential: true, hooks: [{ type: 'command', name: 'pilot-post-tool', command: 'npx -y pilotprotocol-mcp@0.3.0 hook --harness gemini --phase post', timeout: 30000 }] }],
    },
  });
  configureInHome('gemini', home);
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(settings.mcpServers.pilot.args, ['-y', 'pilotprotocol-mcp@0.4.0']);
  assert.equal(settings.mcpServers.customer.command, 'customer-mcp');
  assert.equal(settings.hooksConfig.enabled, true);
  assert.deepEqual(settings.hooks, {
    BeforeTool: [{ matcher: 'shell', hooks: [{ type: 'command', command: 'customer-hook' }] }],
  });

  const fresh = mkdtempSync(join(tmpdir(), 'pilot-gemini-fresh-'));
  configureInHome('gemini', fresh);
  const created = JSON.parse(readFileSync(join(fresh, '.gemini', 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(created), ['mcpServers']);
});

test('Continue merges Pilot into config.yaml and removes only its obsolete duplicate block', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-continue-contract-'));
  const configPath = join(home, '.continue', 'config.yaml');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, '# customer config\nname: Customer\nversion: 1.2.3\nschema: v1\nmcpServers:\n  - name: Customer\n    command: customer-mcp\n');
  const legacyPath = join(home, '.continue', 'mcpServers', 'pilot.yaml');
  mkdirSync(dirname(legacyPath), { recursive: true });
  writeFileSync(legacyPath, 'name: Pilot\nmcpServers:\n  - command: npx\n    args: ["-y", "pilotprotocol-mcp@0.2.11"]\n');
  configureInHome('continue', home);
  const source = readFileSync(configPath, 'utf8');
  const config = parse(source);
  assert.match(source, /# customer config/);
  assert.equal(config.mcpServers.filter((entry) => entry.name === 'Pilot').length, 1);
  assert.deepEqual(config.mcpServers.find((entry) => entry.name === 'Pilot').args, ['-y', 'pilotprotocol-mcp@0.4.0']);
  assert.equal(config.mcpServers.find((entry) => entry.name === 'Customer').command, 'customer-mcp');
  assert.equal(existsSync(legacyPath), false);
});

test('OpenHands migrates pre-1.0 TOML MCP config and removes only retired Pilot project hooks', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-openhands-contract-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const legacyPath = join(home, '.openhands', 'config.toml');
  mkdirSync(dirname(legacyPath), { recursive: true });
  writeFileSync(legacyPath, '[core]\nmodel = "customer"\n\n[mcp.stdio_servers.pilot]\ncommand = "npx"\nargs = ["-y", "pilotprotocol-mcp@0.2.11"]\n\n[other]\nenabled = true\n');
  writeJSON(join(home, '.openhands', 'mcp.json'), { mcpServers: { customer: { command: 'customer-mcp' } } });
  writeJSON(join(workspace, '.openhands', 'hooks.json'), {
    PreToolUse: [
      { matcher: '*', hooks: [{ type: 'command', command: 'npx -y pilotprotocol-mcp@0.3.0 hook --harness openhands --phase pre', timeout: 30 }] },
      { matcher: 'bash', hooks: [{ type: 'command', command: 'project-hook' }] },
    ],
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'npx -y pilotprotocol-mcp@0.3.0 hook --harness openhands --phase post', timeout: 30 }] }],
  });
  configureInHome('openhands', home, { cwd: workspace });

  const mcp = JSON.parse(readFileSync(join(home, '.openhands', 'mcp.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers.pilot.args, ['-y', 'pilotprotocol-mcp@0.4.0']);
  assert.equal(mcp.mcpServers.customer.command, 'customer-mcp');
  const legacy = readFileSync(legacyPath, 'utf8');
  assert.doesNotMatch(legacy, /mcp\.stdio_servers\.pilot/);
  assert.match(legacy, /\[core\]/);
  assert.match(legacy, /\[other\]/);
  const hooks = JSON.parse(readFileSync(join(workspace, '.openhands', 'hooks.json'), 'utf8'));
  assert.deepEqual(hooks, { PreToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: 'project-hook' }] }] });

  // A workspace without hooks is not given a .openhands directory, and a hook
  // file that held only Pilot's entries is removed.
  const clean = join(home, 'clean-workspace');
  mkdirSync(clean, { recursive: true });
  configureInHome('openhands', home, { cwd: clean });
  assert.equal(existsSync(join(clean, '.openhands')), false);
  const owned = join(home, 'owned-workspace');
  writeJSON(join(owned, '.openhands', 'hooks.json'), {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'npx -y pilotprotocol-mcp@0.3.0 hook --harness openhands --phase pre', timeout: 30 }] }],
  });
  configureInHome('openhands', home, { cwd: owned });
  assert.equal(existsSync(join(owned, '.openhands', 'hooks.json')), false);
});

test('Codex upgrades its owned TOML table without duplicating user configuration and removes retired Pilot hooks', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-codex-contract-'));
  const configPath = join(home, '.codex', 'config.toml');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, 'model = "customer"\n\n[mcp_servers.pilot]\ncommand = "npx"\nargs = ["-y", "pilotprotocol-mcp@0.2.8"]\n\n[mcp_servers.customer]\ncommand = "customer-mcp"\n');
  const hooksPath = join(home, '.codex', 'hooks.json');
  writeJSON(hooksPath, {
    description: 'Optional local Codex hooks, including Pilot policy enforcement.',
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: 'npx -y pilotprotocol-mcp@0.3.0 hook --harness codex --phase pre', timeout: 30 }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command: 'npx -y pilotprotocol-mcp@0.3.0 hook --harness codex --phase post', timeout: 30 }] }],
    },
  });
  configureInHome('codex', home);
  const config = readFileSync(configPath, 'utf8');
  assert.equal(config.match(/\[mcp_servers\.pilot\]/g)?.length, 1);
  assert.match(config, /pilotprotocol-mcp@0\.4\.0/);
  assert.match(config, /\[mcp_servers\.customer\]/);
  assert.match(config, /model = "customer"/);
  assert.equal(existsSync(hooksPath), false);

  const mixed = mkdtempSync(join(tmpdir(), 'pilot-codex-mixed-'));
  const mixedHooks = join(mixed, '.codex', 'hooks.json');
  writeJSON(mixedHooks, {
    description: 'Customer hooks',
    hooks: {
      PreToolUse: [
        { hooks: [{ type: 'command', command: 'npx -y pilotprotocol-mcp@0.3.0 hook --harness codex --phase pre', timeout: 30 }] },
        { hooks: [{ type: 'command', command: 'customer-hook' }] },
      ],
    },
  });
  configureInHome('codex', mixed);
  assert.deepEqual(JSON.parse(readFileSync(mixedHooks, 'utf8')), {
    description: 'Customer hooks',
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'customer-hook' }] }] },
  });

  const fresh = mkdtempSync(join(tmpdir(), 'pilot-codex-fresh-'));
  configureInHome('codex', fresh);
  assert.equal(existsSync(join(fresh, '.codex', 'hooks.json')), false);
});

test('Junie writes the shared CLI and IDE user MCP location', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-junie-contract-'));
  configureInHome('junie', home);
  const config = JSON.parse(readFileSync(join(home, '.junie', 'mcp', 'mcp.json'), 'utf8'));
  assert.deepEqual(config.mcpServers.pilot.args, ['-y', 'pilotprotocol-mcp@0.4.0']);
  assert.equal(existsSync(join(home, '.junie', 'config.json')), false);
});
