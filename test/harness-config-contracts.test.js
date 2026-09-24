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

test('Claude separates user MCP registration from hook settings and migrates stale entries', () => {
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
    },
  });
  configureInHome('claude', home);

  const mcp = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers.pilot.args, ['-y', 'pilotprotocol-mcp@0.3.0']);
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.theme, 'dark');
  assert.deepEqual(settings.mcpServers, { customer: { command: 'customer-mcp' } });
  assert.equal(settings.hooks.UserPromptSubmit, undefined);
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooks.PostToolUse.length, 1);
  assert.equal(settings.hooks.PostToolUseFailure.length, 1);
});

test('Gemini uses current MCP and BeforeTool/AfterTool user settings idempotently', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-gemini-contract-'));
  const settingsPath = join(home, '.gemini', 'settings.json');
  writeJSON(settingsPath, { mcpServers: { customer: { command: 'customer-mcp' } }, hooks: {} });
  configureInHome('gemini', home);
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(settings.mcpServers.pilot.args, ['-y', 'pilotprotocol-mcp@0.3.0']);
  assert.equal(settings.mcpServers.customer.command, 'customer-mcp');
  assert.equal(settings.hooksConfig.enabled, true);
  assert.equal(settings.hooks.BeforeTool.length, 1);
  assert.equal(settings.hooks.AfterTool.length, 1);
  assert.equal(settings.hooks.BeforeTool[0].hooks[0].timeout, 30000);
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
  assert.deepEqual(config.mcpServers.find((entry) => entry.name === 'Pilot').args, ['-y', 'pilotprotocol-mcp@0.3.0']);
  assert.equal(config.mcpServers.find((entry) => entry.name === 'Customer').command, 'customer-mcp');
  assert.equal(existsSync(legacyPath), false);
});

test('OpenHands migrates pre-1.0 TOML MCP config and installs project hooks', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-openhands-contract-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const legacyPath = join(home, '.openhands', 'config.toml');
  mkdirSync(dirname(legacyPath), { recursive: true });
  writeFileSync(legacyPath, '[core]\nmodel = "customer"\n\n[mcp.stdio_servers.pilot]\ncommand = "npx"\nargs = ["-y", "pilotprotocol-mcp@0.2.11"]\n\n[other]\nenabled = true\n');
  writeJSON(join(home, '.openhands', 'mcp.json'), { mcpServers: { customer: { command: 'customer-mcp' } } });
  configureInHome('openhands', home, { cwd: workspace });

  const mcp = JSON.parse(readFileSync(join(home, '.openhands', 'mcp.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers.pilot.args, ['-y', 'pilotprotocol-mcp@0.3.0']);
  assert.equal(mcp.mcpServers.customer.command, 'customer-mcp');
  const legacy = readFileSync(legacyPath, 'utf8');
  assert.doesNotMatch(legacy, /mcp\.stdio_servers\.pilot/);
  assert.match(legacy, /\[core\]/);
  assert.match(legacy, /\[other\]/);
  const hooks = JSON.parse(readFileSync(join(workspace, '.openhands', 'hooks.json'), 'utf8'));
  assert.equal(hooks.PreToolUse.length, 1);
  assert.equal(hooks.PostToolUse.length, 1);
});

test('Codex upgrades its owned TOML table without duplicating user configuration', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-codex-contract-'));
  const configPath = join(home, '.codex', 'config.toml');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, 'model = "customer"\n\n[mcp_servers.pilot]\ncommand = "npx"\nargs = ["-y", "pilotprotocol-mcp@0.2.8"]\n\n[mcp_servers.customer]\ncommand = "customer-mcp"\n');
  configureInHome('codex', home);
  const config = readFileSync(configPath, 'utf8');
  assert.equal(config.match(/\[mcp_servers\.pilot\]/g)?.length, 1);
  assert.match(config, /pilotprotocol-mcp@0\.3\.0/);
  assert.match(config, /\[mcp_servers\.customer\]/);
  assert.match(config, /model = "customer"/);
  const hooks = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.PreToolUse.length, 1);
  assert.equal(hooks.hooks.PostToolUse.length, 1);
});

test('Junie writes the shared CLI and IDE user MCP location', () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-junie-contract-'));
  configureInHome('junie', home);
  const config = JSON.parse(readFileSync(join(home, '.junie', 'mcp', 'mcp.json'), 'utf8'));
  assert.deepEqual(config.mcpServers.pilot.args, ['-y', 'pilotprotocol-mcp@0.3.0']);
  assert.equal(existsSync(join(home, '.junie', 'config.json')), false);
});
