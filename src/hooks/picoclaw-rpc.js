// Long-lived PicoClaw process-hook bridge (JSON-RPC 2.0 over newline-delimited
// stdio). PicoClaw owns the process lifecycle; each before/after tool request is
// translated through the same hosted Pilot pre/post action contract used by
// the other harness adapters.

import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

import { runHook } from './adapter.js';

export async function runPicoClawRPC(io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }) {
  const lines = createInterface({ input: io.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
      const result = await handleRequest(request, io.stderr);
      io.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    } catch (error) {
      io.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id: request?.id ?? null,
        error: { code: -32000, message: error.message ?? String(error) },
      })}\n`);
    }
  }
}

async function handleRequest(request, stderr) {
  if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    throw new Error('invalid PicoClaw hook request');
  }
  if (request.method === 'hook.hello') return { ok: true, name: 'pilot' };
  const phase = request.method === 'hook.before_tool' ? 'pre'
    : request.method === 'hook.after_tool' ? 'post' : '';
  if (!phase) throw new Error(`unsupported PicoClaw hook method ${request.method}`);

  let stdout = '';
  let exitCode = 0;
  await runHook({ harness: 'picoclaw', phase }, {
    stdin: Readable.from([JSON.stringify({
      ...request.params,
      hook_event_name: request.method,
      tool_name: request.params?.tool,
      tool_input: request.params?.arguments,
      tool_response: request.params?.result,
      session_id: request.params?.meta?.SessionKey ?? request.params?.chat_id,
      tool_use_id: request.params?.meta?.TurnID,
    })]),
    stdout: { write(value) { stdout += value; } },
    stderr,
    setExitCode(value) { exitCode = value; },
  });
  if (exitCode !== 0) throw new Error(`Pilot hook exited ${exitCode}`);
  return stdout.trim() ? JSON.parse(stdout) : { action: 'continue' };
}
