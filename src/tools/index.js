// tools/index.js — MCP tool registration. 21 tools total.
//
// Surface organized into 5 buckets so an LLM scanning tools/list can match
// intent fast. Every tool that maps to a pilotctl command shells out via
// daemon-bridge.

import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { search } from './search.js';
import { help } from './help.js';
import { query } from './query.js';
import { summary } from './summary.js';
import { send } from './send.js';
import { send_file } from './send_file.js';
import { inbox } from './inbox.js';
import { received } from './received.js';
import { trust_check } from './trust_check.js';
import { handshake } from './handshake.js';
import { approve } from './approve.js';
import { reject } from './reject.js';
import { untrust } from './untrust.js';
import { pending } from './pending.js';
import { find } from './find.js';
import { lookup } from './lookup.js';
import { peers } from './peers.js';
import { ping } from './ping.js';
import { broadcast } from './broadcast.js';
import { publish } from './publish.js';
import { subscribe } from './subscribe.js';

export const TOOLS = [
  // Catalog (3-command pattern — specialists auto-trust):
  search, help, query, summary,
  // A2A messaging + file transfer (trust REQUIRED — call pilot_trust_check first):
  send, send_file, inbox, received,
  // Trust lifecycle (read this before doing any A2A):
  trust_check, handshake, approve, reject, untrust, pending,
  // Discovery + reachability:
  find, lookup, peers, ping,
  // Network-wide messaging + pub/sub (trust REQUIRED for peer-targeted variants):
  broadcast, publish, subscribe,
];

export function registerTools(server) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }] };
    }
    try {
      const result = await tool.handler(req.params.arguments ?? {});
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err.message ?? String(err) }] };
    }
  });
}
