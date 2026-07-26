// The static manifests must match what the server actually registers.
// Regenerate with `node scripts/gen-manifests.mjs` when a tool, resource, or
// prompt is added, removed, or renamed.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildToolsManifest, buildServerCard } from '../src/manifest.js';
import { TOOLS } from '../src/tools/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGEN = 'run `node scripts/gen-manifests.mjs`';

test('tools.json matches the registered tool definitions', () => {
  const onDisk = JSON.parse(readFileSync(join(root, 'tools.json'), 'utf8'));
  assert.deepStrictEqual(onDisk, buildToolsManifest(), `tools.json is stale — ${REGEN}`);
});

test('tools.json lists pilot_send with its real argument names', () => {
  const onDisk = JSON.parse(readFileSync(join(root, 'tools.json'), 'utf8'));
  const entry = onDisk.find((t) => t.name === 'pilot_send');
  const tool = TOOLS.find((t) => t.name === 'pilot_send');
  assert.ok(entry, 'pilot_send missing from tools.json');
  assert.deepStrictEqual(entry.arguments, Object.keys(tool.inputSchema.properties));
});

test('server-card capabilities match the registered surface', () => {
  const path = join(root, '.well-known', 'mcp', 'server-card.json');
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepStrictEqual(onDisk, buildServerCard(onDisk), `server-card.json is stale — ${REGEN}`);
});
