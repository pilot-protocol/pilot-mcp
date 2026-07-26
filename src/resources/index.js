// resources/index.js — MCP resource registration.
//
// Six read-only resources that surface daemon state without requiring a
// tool call. Harnesses can poll these for context.

import { ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pilotctlJSON } from '../daemon-bridge.js';

export const RESOURCES = [
  {
    uri: 'pilot://catalog',
    name: 'Directory catalog',
    description: 'The 435+ specialist directory snapshot from list-agents (refreshed on read).',
    mimeType: 'application/json',
    fetch: async () => {
      return await pilotctlJSON([
        'send-message', 'list-agents',
        '--data', '/data {"limit":150}',
        '--wait',
      ]);
    },
  },
  {
    uri: 'pilot://inbox',
    name: 'Inbox',
    description: 'Recent received messages from peers and specialists. Replies cap at ~8-9 KB per file; large replies are truncated mid-stream.',
    mimeType: 'application/json',
    fetch: () => pilotctlJSON(['inbox', '--limit=50']),
  },
  {
    uri: 'pilot://trust',
    name: 'Trust list',
    description: 'Currently trusted peers (bilateral handshakes complete). Backbone catalog specialists (list-agents and the data specialists) auto-approve via the trustedagents allowlist.',
    mimeType: 'application/json',
    fetch: () => pilotctlJSON(['trust']),
  },
  {
    uri: 'pilot://peers',
    name: 'Connected peers',
    description: 'Active peer connections + advertised tags. PATH field shows direct vs relay.',
    mimeType: 'application/json',
    fetch: () => pilotctlJSON(['peers']),
  },
  {
    uri: 'pilot://identity',
    name: 'Local identity',
    description: 'Your pilot address, hostname, public key, and registration status. The private key in ~/.pilot/identity.json never leaves the daemon.',
    mimeType: 'application/json',
    fetch: () => pilotctlJSON(['info']),
  },
  {
    uri: 'pilot://daemon-health',
    name: 'Daemon health',
    description: 'Is the local pilot-daemon running and registered? Counts of encrypted peers, uptime, traffic.',
    mimeType: 'application/json',
    fetch: () => pilotctlJSON(['health']),
  },
];

export function registerResources(server) {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCES.map(({ fetch, ...meta }) => meta),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const r = RESOURCES.find((x) => x.uri === req.params.uri);
    if (!r) throw new Error(`unknown resource: ${req.params.uri}`);
    const data = await r.fetch();
    return {
      contents: [{ uri: r.uri, mimeType: r.mimeType, text: JSON.stringify(data, null, 2) }],
    };
  });
}
