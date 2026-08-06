// setup/index.js — the one-command install flow.
//
// What `pilot-mcp setup` does, end-to-end:
//   1. Capture email + hostname (interactive prompts OR PILOT_EMAIL/PILOT_HOSTNAME env).
//   2. Extract pilot-daemon + pilotctl binaries from the platform subpackage to ~/.pilot/bin/.
//   3. Write ~/.pilot/config.json.
//   4. Probe UDP transport to beacon; fall back to compat mode if blocked.
//   5. Install AND load the daemon service (launchd plist / systemd unit).
//   6. Start daemon, wait for rendezvous registration, fetch pilot address.
//   7. Auto-detect installed harnesses.
//   8. For each detected harness: write MCP config + drop SKILL.md/AGENTS.md heartbeat.
//   9. Print summary with pilot address and which harnesses were configured.
//
// Replaces the current ~16-step new-user journey with one command.

import process from 'node:process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execPilotctl } from '../daemon-bridge.js';
import { ensurePilotRuntime } from './runtime.js';
import { detectHarnesses } from './detect.js';
import { installDaemon } from './daemon.js';
import { writeIdentity } from './identity.js';
import { probeTransport } from './transport.js';
import harnesses from './harnesses/index.js';

export async function runSetup(flags) {
  const opts = await resolveOptions(flags);

  await step('1', 'Pilot runtime', async () => {
    const binary = await ensurePilotRuntime({ requireManaged: Boolean(opts.managedURL) });
    log(`  Verified runtime: ${binary}`);
  });

  if (opts.managedURL) {
	await step('2', 'Hosted enrollment', async () => {
      opts.enterpriseControl = await adoptManagedNode(opts);
      process.env.PILOT_ENTERPRISE_CONTROL = opts.enterpriseControl;
      log(`  Managed identity claimed and verified: ${opts.enterpriseControl}`);
    });
  }

	await step(opts.managedURL ? '3' : '2', 'Identity', async () => {
    await writeIdentity({ email: opts.email, hostname: opts.hostname, enterpriseControl: opts.enterpriseControl });
  });

	await step(opts.managedURL ? '4' : '3', 'Transport', async () => {
    opts.transport = await probeTransport();
    if (opts.transport === 'compat') {
      log('  UDP appears blocked. Falling back to compat mode (TCP/443 via WSS).');
    }
  });

	await step(opts.managedURL ? '5' : '4', 'Daemon', async () => {
    try {
      const daemon = await installDaemon({ transport: opts.transport, autoStart: true, enterpriseControl: opts.enterpriseControl });
      opts.trust_verified = daemon.trust_verified === true;
      opts.address = daemon.address;
    } catch (error) {
      // Harness attachment remains useful and is safe in unmanaged pass-through
      // mode. Do not abort before writing adapters merely because the separate
      // Pilot protocol runtime is absent; report the missing runtime explicitly.
      opts.trust_verified = false;
      opts.daemon_error = error.message;
      log(`  Protocol runtime unavailable — ${error.message}`);
      log('  Continuing with harness attachment in unmanaged pass-through mode.');
    }
  });

  let detected = [];
	await step(opts.managedURL ? '6' : '5', 'Detect harnesses', async () => {
    detected = await detectHarnesses();
    if (opts.all) opts.harnesses = detected.map((h) => h.id);
    if (!opts.harnesses?.length) opts.harnesses = detected.map((h) => h.id);
    log(`  Detected: ${detected.map((h) => h.id).join(', ') || '(none)'}`);
  });

  const configured = [];
  const skipped = [];
	await step(opts.managedURL ? '7' : '6', 'Configure harnesses', async () => {
    for (const id of opts.harnesses) {
      const h = detected.find((candidate) => candidate.id === id) ?? { id, name: id };
      const writer = harnesses[h.id];
      if (!writer) {
        skipped.push(`${h.id} (no writer)`);
        continue;
      }
      try {
        await writer.configure({ ...h, transport: opts.transport });
        configured.push(h.id);
      } catch (err) {
        log(`  ${h.id}: failed — ${err.message}`);
        skipped.push(`${h.id} (${err.message})`);
      }
    }
  });

  // Print summary. Trust verification result gates the success language —
  // we deliberately do NOT claim "installed and running" if the smoke test
  // could not prove trust works.
  log('');
  log('============================================');
  if (opts.trust_verified !== true) {
    if (opts.daemon_error) {
      log('Harness adapters installed — PROTOCOL RUNTIME NOT AVAILABLE.');
      log('Unmanaged agents continue normally; managed control is not active.');
      log(`Runtime error: ${opts.daemon_error}`);
    } else {
      log('Pilot installed — TRUST NOT YET VERIFIED.');
      log('Daemon is up but the smoke handshake with list-agents did not complete.');
      log('This usually resolves on its own within 60s as the registry propagates.');
    }
    log('Re-verify with: npx -y pilotprotocol-mcp doctor');
  } else {
    log('Pilot is installed and running. Trust with list-agents verified.');
  }
  log('');
  log(`  Address:   ${opts.address ?? '(fetching…)'}`);
  log(`  Hostname:  ${opts.hostname}`);
  log(`  Transport: ${opts.transport}`);
  log(`  Configured: ${configured.join(', ') || '(none)'}`);
  if (skipped.length) log(`  Skipped:    ${skipped.join(', ')}`);
  log('');
  log('Next steps:');
  log('  npx -y pilotprotocol-mcp tour    — try one specialist query');
  log('  npx -y pilotprotocol-mcp doctor  — diagnose if anything looks wrong');
  log('  npx -y pilotprotocol-mcp peers   — see who you are connected to');
  log('============================================');
}

async function resolveOptions(flags) {
  // TODO: interactive prompts via @inquirer/prompts when TTY; env-var fallback otherwise.
  const opts = {
    email: flags.email ?? process.env.PILOT_EMAIL ?? null,
    hostname: flags.hostname ?? process.env.PILOT_HOSTNAME ?? null,
    all: flags.all ?? false,
    harnesses: [],
    managedURL: flags['managed-url'] ?? process.env.PILOT_MANAGEMENT_URL ?? null,
    enrollmentToken: process.env.PILOT_ENROLLMENT_TOKEN ?? null,
  };
  // Build harnesses list from flags like --claude --cursor --cline.
  for (const id of ['claude', 'cursor', 'cline', 'continue', 'openclaw', 'hermes', 'picoclaw', 'openhands', 'codex', 'gemini', 'junie', 'copilot']) {
    if (flags[id]) opts.harnesses.push(id);
  }
  return opts;
}

async function adoptManagedNode(opts) {
  const defaultControl = join(homedir(), '.pilot', 'managed', 'enterprise-control.json');
  if (existsSync(defaultControl)) {
    return defaultControl;
  }
  if (!opts.enrollmentToken) {
    throw new Error('PILOT_ENROLLMENT_TOKEN is required for first managed adoption');
  }
  const result = await execPilotctl(
    ['--json', 'enterprise', 'adopt', '--endpoint', opts.managedURL],
    { capture: true, env: { PILOT_ENROLLMENT_TOKEN: opts.enrollmentToken } },
  );
  delete process.env.PILOT_ENROLLMENT_TOKEN;
  opts.enrollmentToken = null;
  if (result.code !== 0) {
    throw new Error(`managed enrollment failed: ${String(result.stderr || result.stdout).trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('managed enrollment returned an invalid response');
  }
  const controlPath = parsed?.data?.control_path;
  if (!controlPath || !existsSync(controlPath)) {
    throw new Error('managed enrollment did not install a verified control attachment');
  }
  return controlPath;
}

function step(n, label, fn) {
  return (async () => {
    log(`[${n}] ${label}…`);
    await fn();
  })();
}

function log(s) {
  // setup output goes to stderr so it's safe for setup to also pipe-friendly
  // contexts. The summary at the end goes to stdout.
  process.stderr.write(s + '\n');
}
