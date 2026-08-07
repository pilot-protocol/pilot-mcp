import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function readJSON(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'));
}

test('npm and Official MCP Registry metadata stay version-locked', async () => {
  const [pkg, server, card, versionSource, pluginManifest, pluginEvaluator] = await Promise.all([
    readJSON('package.json'),
    readJSON('server.json'),
    readJSON('.well-known/mcp/server-card.json'),
    readFile(new URL('src/version.js', root), 'utf8'),
    readJSON('src/openclaw-plugin/openclaw.plugin.json'),
    readFile(new URL('src/openclaw-plugin/evaluate.js', root), 'utf8'),
  ]);

  assert.equal(pkg.mcpName, server.name);
  assert.equal(pkg.version, server.version);
  assert.equal(server.packages.length, 1);
  assert.equal(server.packages[0].registryType, 'npm');
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].version, pkg.version);
  assert.equal(card.serverInfo.version, pkg.version);
  assert.match(versionSource, new RegExp(`VERSION = '${pkg.version.replaceAll('.', '\\.')}';`));
  assert.deepEqual(pluginManifest.mcpServers.pilot.args, ['-y', `${pkg.name}@${pkg.version}`]);
  assert.match(pluginEvaluator, new RegExp(`${pkg.name}@${pkg.version.replaceAll('.', '\\.')}`));
});

test('release workflow uses upstream publisher and repository GHCR namespace', async () => {
  const workflow = await readFile(new URL('.github/workflows/publish.yml', root), 'utf8');

  assert.doesNotMatch(workflow, /@modelcontextprotocol\/mcp-publisher/);
  assert.match(workflow, /mcp-publisher login github-oidc/);
  assert.match(workflow, /MCP_PUBLISHER_SHA256: [a-f0-9]{64}/);
  assert.match(workflow, /ghcr\.io\/pilot-protocol\/pilot-mcp/);
  assert.doesNotMatch(workflow, /ghcr\.io\/teoslayer\/pilot-mcp/);
});

test('container uses a reproducible non-root production install', async () => {
  const dockerfile = await readFile(new URL('Dockerfile', root), 'utf8');

  assert.match(dockerfile, /^FROM node:24-alpine/m);
  assert.match(dockerfile, /npm ci --omit=dev --omit=optional/);
  assert.match(dockerfile, /^USER node$/m);
  assert.doesNotMatch(dockerfile, /npm install/);
});
