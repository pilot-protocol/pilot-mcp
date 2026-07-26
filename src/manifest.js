// manifest.js — derives the static manifests from the live server definitions.
//
// tools.json (Docker MCP catalog) and .well-known/mcp/server-card.json list the
// server surface. Both are generated from TOOLS/RESOURCES/PROMPTS so a new or
// renamed entry shows up in them instead of leaving a stale copy behind.
// Regenerate with `node scripts/gen-manifests.mjs`; test/manifest.test.js
// asserts the checked-in files match.

import { TOOLS } from './tools/index.js';
import { RESOURCES } from './resources/index.js';
import { PROMPTS } from './prompts/index.js';

export function buildToolsManifest() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    arguments: Object.keys(t.inputSchema?.properties ?? {}),
    required: t.inputSchema?.required ?? [],
  }));
}

export function buildServerCard(existing) {
  return {
    ...existing,
    capabilities: {
      tools: TOOLS.map((t) => t.name),
      resources: RESOURCES.map((r) => r.uri),
      prompts: PROMPTS.map((p) => p.name),
    },
  };
}
