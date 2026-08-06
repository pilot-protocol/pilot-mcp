// mcp-stdio.js — stdio MCP server.
//
// This is what runs when a harness invokes `npx -y pilotprotocol-mcp` with no args.
// Reads JSON-RPC over stdin, writes responses to stdout. Diagnostic logs go to
// stderr only — anything on stdout that isn't valid MCP framing breaks the
// protocol.
//
// Critical:
//  - No interactive prompts. Harnesses spawn this with no TTY.
//  - Connection to local pilot-daemon must be lazy — opening the Unix socket
//    on every tools/call lets the daemon restart without crashing the MCP
//    session.
//  - Tools should return MCP errors (not throw) when the daemon is down.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools/index.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';

export async function runStdio() {
  const server = new Server(
    {
      name: 'pilot-mcp',
      version: '0.2.1',
    },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: false, listChanged: true },
        prompts: { listChanged: false },
      },
    }
  );

  registerTools(server);
  registerResources(server);
  registerPrompts(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Server keeps running until stdin closes.
}
