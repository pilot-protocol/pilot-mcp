# Modes — the plan, in detail

`pilot-mcp` ships as one npm package with three deployment modes selected by
flag. The package always exposes the same MCP tool surface; the difference is
where the Pilot daemon actually runs.

## Goal: zero adoption friction

The 16-step current install flow (`curl | sh` + manual daemon-start + manual
service-load + per-harness wire-up) gates Pilot to people who are already
sold. Two changes fix that:

1. **Local mode collapses install to one command** — `npx -y pilotprotocol-mcp setup`
   wraps the Go daemon and pilotctl as platform subpackages and auto-configures
   every detected harness.
2. **Hosted modes eliminate the install commit entirely** — `claude mcp add
   pilot ssh://...` is shorter than reading this paragraph.

Both ship. They serve different users; some users will move from hosted to
local once they're convinced.

## Mode 1 — local (v0.1, shipping)

```bash
npx -y pilotprotocol-mcp setup
```

What runs: `pilot-mcp` spawns the platform-matched `pilot-daemon` Go binary
(installed via npm `optionalDependencies`) as a child process, listening on a
Unix socket. The Node CLI speaks MCP over stdio and translates tool calls into
pilotctl invocations against the local daemon.

- **Identity:** Ed25519 keypair persisted at `~/.pilot/identity.json`. Same
  semantics as today's `curl | sh` install.
- **Privacy:** Full P2P. No third party in the path. Specialist payloads E2E
  encrypted; rendezvous sees connectivity metadata only (as it does today).
- **Sandboxing:** Subprocess with restricted env vars, no shell escape, clean
  lifecycle owned by Node. **This is not a meaningful security boundary
  against a malicious daemon binary.** The daemon is signed and pulled from a
  trusted release; treat the sandboxing as hygiene, not isolation.

This is what the existing scaffold under `src/` implements. The Go binary
cross-compile + npm subpackage publish pipeline is the remaining work.

## Mode 2 — hosted SSH (v0.2, planned)

```bash
claude mcp add pilot ssh://you@ssh.pilot.protocol.network
```

What runs (client side): `pilot-mcp --remote ssh://...` `exec`s `ssh` with a
forced-command that lands on a per-user MCP server on the host.

What runs (server side): one VM running sshd plus a small forced-command
wrapper. On first SSH connect from a new key, the wrapper provisions a sandbox
user account with a fresh pilot-daemon (sleep-when-idle). Subsequent connects
reuse the same account → same Pilot identity → same trust graph.

- **Identity:** SSH key fingerprint → Pilot identity. Persistent across
  reconnects. Lose the SSH key, lose the identity (just like local mode and
  `~/.pilot/identity.json`).
- **Privacy:** Vulture sees who-talks-to-whom metadata (the SSH session reveals
  which specialist names you query, when, and how often). Specialist payloads
  remain E2E encrypted. This is a real regression vs local mode; we will be
  explicit about it on the website.
- **Ops:** One Vulture-operated host. Sshd handles auth and accounting. Per-user
  systemd unit owns each daemon. Sleep-when-idle keeps memory cost down.
- **Abuse defenses:** Per-key rate limits, hard cap on outbound connections per
  key, captcha-gated first-connect (or invite-only at launch).

## Mode 3 — hosted HTTP + token (v0.3, conditional)

```bash
# In your harness config:
{
  "url": "https://mcp.pilot.protocol.network",
  "headers": { "Authorization": "Bearer <your-token>" }
}
```

What runs (client side): nothing — your harness speaks MCP Streamable HTTP
directly to the server.

What runs (server side): same per-user pilot-daemon farm as SSH mode, fronted
by an HTTPS server that authenticates via bearer token. First call without a
token returns one signed token + "save this; it's your Pilot identity." Token
loss = identity loss; recovery is via an out-of-band backup phrase generated
at signup.

Ship only if SSH users report needing it (environments where outbound SSH is
blocked but HTTPS is not — some CI, some enterprise). Otherwise the extra
attack surface isn't worth the marginal reach.

## Deliberately not shipping: ephemeral anonymous HTTP

A "30 seconds of Pilot identity" mode is appealing in theory — zero friction
to first query. We're not shipping it because:

- Pilot's value over plain MCP is the A2A trust graph. Trust takes seconds-
  to-a-minute to propagate through the registry. Ephemeral identities cannot
  do A2A — they're gone before any peer has heard of them.
- Without A2A, ephemeral mode reduces Pilot to "anonymous catalog API." The
  catalog largely wraps free public APIs; the value-add disappears.
- Open anonymous endpoints attract abuse fast and need significant defensive
  ops investment for a use case that doesn't grow the network.

If we want a no-friction try-it-now demo for marketing, that lives on
`pilotprotocol.network/try` — one query, server-side, no client install. It
is not part of `pilot-mcp`.

## Decision points before shipping hosted modes

- **Honest privacy disclosure:** "Local = full P2P. Hosted = Vulture sees
  metadata." Surfaced on the website and in `pilot-mcp --help`.
- **Per-key abuse model:** Rate limits, anomaly detection, kill switch.
- **Cost model:** A 4-vCPU / 8 GB VM handles ~500 concurrent daemons with
  sleep-when-idle. $40/mo at small scale. Caps at the budget you set.
- **Security posture:** Pilot has zero public CVEs today — partly because
  there's no hosted attack surface yet. Hosting changes that. Plan for a
  security audit before mode 2 launches publicly.

## What is `pilot-mcp` actually wrapping?

The same surface in every mode:

- 20 MCP tools matching pilotctl primitives (send-message, inbox, peers,
  trust, handshake, send-file, broadcast, publish/subscribe, etc.)
- 6 MCP resources (catalog snapshot, inbox, trust list, peers, identity,
  daemon health)
- 5 MCP prompts (3-command pattern, A2A, handshake, troubleshoot, readiness)

The Pilot tools, catalog, and protocol are unchanged. `pilot-mcp` is the
ergonomic shell around them.
