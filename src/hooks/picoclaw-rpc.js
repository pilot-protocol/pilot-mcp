// Compatibility stub for the retired PicoClaw process hook (JSON-RPC 2.0 over
// newline-delimited stdio). Setup no longer registers it, but a PicoClaw
// config written by an earlier release still starts `pilot-mcp picoclaw-hook`
// and owns the process lifecycle. Answer the handshake and let every tool
// call continue unchanged.

import { createInterface } from 'node:readline';

export async function runPicoClawRPC(io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }) {
  const lines = createInterface({ input: io.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
      const result = handleRequest(request);
      io.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    } catch (error) {
      io.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id: request?.id ?? null,
        error: { code: -32000, message: error.message ?? String(error) },
      })}\n`);
    }
  }
}

function handleRequest(request) {
  if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    throw new Error('invalid PicoClaw hook request');
  }
  if (request.method === 'hook.hello') return { ok: true, name: 'pilot' };
  if (request.method === 'hook.before_tool' || request.method === 'hook.after_tool') {
    return { action: 'continue' };
  }
  throw new Error(`unsupported PicoClaw hook method ${request.method}`);
}
