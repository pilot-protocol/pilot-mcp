// mcp-http.js — placeholder for the Streamable HTTP MCP transport.
//
// Not implemented. The only working transport in this build is stdio
// (`pilot-mcp` with no arguments, see src/mcp-stdio.js). `pilot-mcp serve`
// is therefore undocumented in `pilot-mcp --help` and exits non-zero.
//
// Implementing it means: construct the Server the way runStdio does, register
// tools/resources/prompts, connect a StreamableHTTPServerTransport bound to
// --bind (default 127.0.0.1) and --port (default 9100), and add a request
// authentication scheme before accepting any non-loopback bind.

export async function runHttp() {
  console.error('pilot-mcp: the HTTP transport is not implemented in this build.');
  console.error('Use the default stdio transport: run `pilot-mcp` with no arguments.');
  process.exit(2);
}
