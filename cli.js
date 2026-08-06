#!/usr/bin/env node
// cli.js — dispatch entrypoint for pilot-mcp.
//
// Invocation patterns this handles:
//
//   pilot-mcp                       → stdio MCP server (used by `npx -y pilotprotocol-mcp` in harness configs)
//   pilot-mcp setup [flags]         → interactive auto-detect + auto-config wizard
//   pilot-mcp attach [flags]        → configure harness hooks around an already-adopted core node
//   pilot-mcp doctor                → diagnose daemon/registry/harness state
//   pilot-mcp hook --harness <id>   → native pre/post tool enforcement bridge
//   pilot-mcp tour                  → first-run guided demo (one specialist call)
//   pilot-mcp export-identity       → write identity to portable file
//   pilot-mcp import-identity <f>   → load identity from portable file
//   pilot-mcp uninstall             → reverse setup (remove harness configs, optionally stop daemon)
//   pilot-mcp <anything-else>       → delegate to the platform pilotctl binary
//
// Critical: bare `pilot-mcp` invocation MUST start the stdio server immediately.
// Harnesses spawn this with no TTY; any interactive prompt would deadlock the harness.

import process from 'node:process';

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  // No args = stdio MCP server. This is the universal harness entry point.
  if (!cmd || cmd.startsWith('--')) {
    if (cmd === '--version' || cmd === '-v') {
      const pkg = (await import('./package.json', { with: { type: 'json' } })).default;
      console.log(pkg.version);
      return;
    }
    if (cmd === '--help' || cmd === '-h') {
      printHelp();
      return;
    }
    const { runStdio } = await import('./src/mcp-stdio.js');
    await runStdio();
    return;
  }

  switch (cmd) {
    // Undocumented: the HTTP transport is not implemented, so `serve` only
    // reports that and exits non-zero. Not listed in printHelp().
    case 'serve': {
      const { runHttp } = await import('./src/mcp-http.js');
      await runHttp();
      break;
    }
    case 'setup': {
      const { runSetup } = await import('./src/setup/index.js');
      await runSetup(parseFlags(args.slice(1)));
      break;
    }
    case 'attach': {
      const { runAttach } = await import('./src/setup/attach.js');
      await runAttach(parseFlags(args.slice(1)));
      break;
    }
    case 'doctor': {
      const { runDoctor } = await import('./src/doctor.js');
      await runDoctor(parseFlags(args.slice(1)));
      break;
    }
    case 'tour': {
      const { runTour } = await import('./src/tour.js');
      await runTour();
      break;
    }
    case 'hook': {
      const { runHook } = await import('./src/hooks/adapter.js');
      await runHook(parseFlags(args.slice(1)));
      break;
    }
    case 'picoclaw-hook': {
      const { runPicoClawRPC } = await import('./src/hooks/picoclaw-rpc.js');
      await runPicoClawRPC();
      break;
    }
    case 'export-identity':
    case 'import-identity':
    case 'uninstall': {
      const { runLifecycle } = await import('./src/lifecycle.js');
      await runLifecycle(cmd, args.slice(1));
      break;
    }
    case 'help': {
      printHelp();
      break;
    }
    default: {
      // Anything else delegates to the underlying pilotctl binary.
      const { execPilotctl } = await import('./src/daemon-bridge.js');
      const exitCode = await execPilotctl(args);
      process.exit(exitCode);
    }
  }
}

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      flags._.push(a);
    }
  }
  return flags;
}

function printHelp() {
  console.log(`pilot-mcp — your agent's overlay network

Usage:
  pilot-mcp                          Start stdio MCP server (default — for harness configs)
  pilot-mcp setup                    Auto-detect harnesses and configure each
  pilot-mcp setup --claude --cursor  Configure only specific harnesses
  pilot-mcp setup --all              Non-interactive, configure everything detected
  pilot-mcp setup --managed-url URL  Claim a one-time hosted enrollment from PILOT_ENROLLMENT_TOKEN
  pilot-mcp attach --claude          Attach one harness to an existing core managed node
  pilot-mcp attach --all             Attach every supported harness without replacing the core runtime
  pilot-mcp doctor                   Diagnose daemon/registry/harness state
  pilot-mcp hook --harness <id>      Native agent pre/post hook bridge (normally auto-installed)
  pilot-mcp picoclaw-hook             PicoClaw JSON-RPC process hook (normally auto-started)
  pilot-mcp tour                     Guided first-run demo
  pilot-mcp export-identity          Write identity to portable file
  pilot-mcp import-identity <file>   Load identity from portable file
  pilot-mcp uninstall                Reverse setup
  pilot-mcp <cmd>                    Delegate to underlying pilotctl

Common pilotctl commands (auto-delegated):
  pilot-mcp peers                    List connected peers
  pilot-mcp inbox                    Show received messages
  pilot-mcp send-message <to> --data <text>
  pilot-mcp handshake <peer>         Initiate trust handshake
  pilot-mcp info                     Show your identity, address, trust state

Docs: https://pilotprotocol.network/docs
`);
}

main().catch((err) => {
  console.error('pilot-mcp:', err.message ?? err);
  process.exit(1);
});
