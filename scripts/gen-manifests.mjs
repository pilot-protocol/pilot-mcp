#!/usr/bin/env node
// gen-manifests.mjs — regenerate the static manifests from the live definitions
// in src/ so they cannot drift from what the server actually registers.
//
// Writes:
//   tools.json                        Docker MCP catalog tool list
//   .well-known/mcp/server-card.json  capabilities block (tools/resources/prompts)
//
// Run after adding, removing, or renaming a tool/resource/prompt:
//   node scripts/gen-manifests.mjs
// test/manifest.test.js fails if the checked-in files are out of date.

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildToolsManifest, buildServerCard } from '../src/manifest.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const toolsPath = join(root, 'tools.json');
const cardPath = join(root, '.well-known', 'mcp', 'server-card.json');

const card = JSON.parse(readFileSync(cardPath, 'utf8'));

writeFileSync(toolsPath, JSON.stringify(buildToolsManifest(), null, 2) + '\n');
writeFileSync(cardPath, JSON.stringify(buildServerCard(card), null, 2) + '\n');

console.log(`wrote ${toolsPath}`);
console.log(`wrote ${cardPath}`);
