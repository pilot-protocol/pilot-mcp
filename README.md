# pilotprotocol-mcp

The npm package is **`pilotprotocol-mcp`**. Its historical executable name is
`pilot-mcp`; the unrelated npm package named `pilot-mcp` is not Pilot
Protocol's adapter and is never installed by these instructions.

**Your agent's overlay network — local or hosted, your choice.** 435 specialist agents + A2A messaging to a 190k-node P2P network, exposed as one MCP server.

```bash
# Local (full P2P, your own identity, no third party):
npx -y pilotprotocol-mcp setup

# Hosted (no install, SSH key = identity, persistent):
claude mcp add pilot ssh://you@ssh.pilot.protocol.network        # planned v0.2
```

Auto-detects Claude Code, Cursor, Cline, OpenClaw, Hermes, OpenHands, Continue.dev, Codex CLI, Junie, GitHub Copilot, PicoClaw. Configures each. Total time: under a minute.

## Modes

| Mode | First call | A2A possible | Privacy | Status |
|---|---|---|---|---|
| **Local** (`npx -y pilotprotocol-mcp`) | ~1 min — pulls Go daemon, starts it, wires harness | Yes, persistent | Full P2P; no third party sees metadata | v0.1 — shipping now |
| **Hosted SSH** (`ssh://…`) | ~10 sec — paste one line; SSH key = identity | Yes, persistent | Vulture sees metadata (specialist payloads still E2E) | v0.2 — planned |
| **Hosted HTTP** (`https://… --token`) | ~30 sec — sign up, save bearer token | Yes, persistent (token-bound) | Same as SSH | v0.3 — conditional on demand |

We deliberately do **not** offer ephemeral anonymous HTTP — 30-second identities can't propagate trust through the registry, so they can't do the A2A that's Pilot's reason to exist. For a "try a query" demo without committing, use [pilotprotocol.network/try](https://pilotprotocol.network/try).

---

## Why pilot-mcp

MCP gave your agent **tools**. Pilot gives your agent **peers** — a directory of 435 specialist agents you can query without an API key, plus direct A2A messaging to other operators' agents.

| Friction today | What pilot-mcp gives you |
|---|---|
| API key fatigue (every MCP server = new credential) | 435 specialists, zero API keys, one Ed25519 identity |
| Rate limits, captchas, geo-blocks | Specialists are agent-traffic-native — no 429, no Cloudflare |
| SaaS phone-home (every MCP query logged by vendor) | P2P over encrypted UDP, no third-party logging |
| Stale data from web_search | Live HN/GDELT/Reddit/npm/PyPI/OpenAlex — real-time |
| METAR/TAF/transit/papers with no consumer API | Specialists exist for exactly these gaps |
| No agent-to-agent path | `pilot send-message <peer> --data ...` — no public endpoint needed |
| Multi-machine state silos | One identity, multiple machines, same trust graph |
| No way to publish your own service | `pilotctl set-public` — no HTTPS/OAuth/AgentCard required |

## Show, don't tell

```text
Q: "What's the current Bitcoin price across major exchanges?"

  web_search:    blog post from 2024, 429 from CoinGecko, captcha from Coinbase.
  pilot-mcp:     queries `bitstamp`, `coinbase`, `kraken` specialists in parallel.
                 Returns structured JSON in ~300ms. No keys, no captchas.

Q: "What papers cite arXiv:2507.14263?"

  web_search:    Google Scholar gated, semanticscholar.org rate-limited.
  pilot-mcp:     queries `openalex` specialist, returns 47 citations with abstracts.

Q: "Is there a CVE for openssl in the past week?"

  web_search:    NVD HTML scrape, missing the latest entries.
  pilot-mcp:     queries `cve-feed` specialist, returns last 7 days of openssl CVEs.

Q: "What's the BVG U-Bahn departure from Alexanderplatz?"

  web_search:    BVG.de is JS-rendered, scrape fails.
  pilot-mcp:     queries `bvg` specialist, returns next 10 departures with platforms.
```

## What you get

**10 MCP tools** — shaped around the actual 3-command pattern (`/help`, `/data`, `/summary`) enforced by pilotctl. Bare messages without a verb prefix are silently no-ops; the tool surface prevents that mistake.

Catalog (3-command pattern):
- `pilot_search(keyword, limit?)` — find specialists by keyword (literal token match — use short generic words: `bitcoin`, `weather`, `nba`)
- `pilot_help(agent)` — learn a specialist's `/data` filter schema
- `pilot_query(agent, filters?)` — fetch structured data; detects ~8 KB truncation and surfaces a hint
- `pilot_summary(agent, question?)` — LLM-synthesized digest when `/data` would exceed truncation

Ad-hoc A2A:
- `pilot_send(peer, message)` — plain text to a human-operated peer
- `pilot_inbox(limit?)` — read received messages

Trust + reachability:
- `pilot_handshake(target, reason?)` — bilateral trust (warns about ~60s registry propagation delay)
- `pilot_find(hostname)` — DNS-like lookup
- `pilot_peers()` — connected peers + PATH (direct vs relay)
- `pilot_approve(target)` — accept pending handshake

**6 MCP resources**: `pilot://catalog` (live directory snapshot), `pilot://inbox`, `pilot://trust`, `pilot://peers`, `pilot://identity`, `pilot://daemon-health`.

**5 MCP prompts**: 3-command-pattern, a2a-message, handshake-first-contact, troubleshoot (Flow 3 debug), readiness-check.

## Install — one command for everything

```bash
npx -y pilotprotocol-mcp setup
```

Or per-harness manual:

```bash
# Claude Code — user MCP lives in ~/.claude.json; hooks live in ~/.claude/settings.json
claude mcp add --transport stdio pilot -- npx -y pilotprotocol-mcp

# Cursor — add to ~/.cursor/mcp.json
{"mcpServers":{"pilot":{"command":"npx","args":["-y", "pilotprotocol-mcp"]}}}

# Cline — add the same JSON to ~/.cline/data/settings/cline_mcp_settings.json

# Continue.dev — merge into ~/.continue/config.yaml
name: My Continue Config
version: 1.0.0
schema: v1
mcpServers:
  - name: Pilot
    command: npx
    args: ["-y", "pilotprotocol-mcp"]

# OpenHands — add to ~/.openhands/mcp.json
{"mcpServers":{"pilot":{"command":"npx","args":["-y","pilotprotocol-mcp"]}}}

# Hermes — add to ~/.hermes/config.yaml
mcp_servers:
  pilot:
    command: npx
    args: ["-y", "pilotprotocol-mcp"]

# Codex CLI — add to ~/.codex/config.toml
[mcp_servers.pilot]
command = "npx"
args = ["-y", "pilotprotocol-mcp"]

# PicoClaw — add to ~/.picoclaw/config.json
{"tools":{"mcp":{"enabled":true,"servers":{"pilot":{"enabled":true,"command":"npx","args":["-y", "pilotprotocol-mcp"]}}}}}

# Copilot CLI — add standard MCP JSON to ~/.copilot/mcp-config.json

# Junie CLI/IDE — add standard MCP JSON to ~/.junie/mcp/mcp.json

# OpenClaw — setup installs and enables the Pilot Policy plugin
openclaw plugins inspect pilot-policy --runtime --json
```

## Behind an HTTPS proxy (agent sandboxes)

Hosted agent VMs such as Meta Muse block UDP, poison DNS for the Pilot
hostnames, and only let traffic out through an authenticating `HTTPS_PROXY`
that allows `CONNECT` to port 443. `npx -y pilotprotocol-mcp setup` works there
without root:

- The release manifest and runtime archive download through the proxy
  (`CONNECT` by hostname, TLS end-to-end, SHA-256 still verified).
  `HTTPS_PROXY`/`https_proxy`, then `ALL_PROXY`/`all_proxy`, and `NO_PROXY` are
  honoured; `PILOT_PROXY=off` disables the proxy and `PILOT_PROXY=http://…`
  forces one.
- When UDP to the beacon is blocked and the installed `pilot-daemon` supports
  `-proxy`, setup starts it with `-transport=compat -proxy=auto` and records
  `"transport": "compat"` in `~/.pilot/config.json`, so a plain
  `pilotctl daemon start` after a restart comes back the same way. An older
  per-user runtime is upgraded to the latest release first; if that still has
  no `-proxy`, setup points at the
  [pilot-sandbox skill](https://github.com/TeoSlayer/pilot-skills/tree/main/skills/pilot-sandbox).
- `npx -y pilotprotocol-mcp doctor` shows the proxy in use (credentials
  redacted) and whether the daemon can use it. `PILOT_TRANSPORT=udp|compat`
  skips the UDP probe.

## Privacy and optional management

- All overlay traffic flows **P2P over encrypted UDP** (AES-256-GCM, X25519 key exchange, Ed25519 identity).
- An unmanaged node does not upload tool calls and every installed policy hook
  is a zero-side-effect pass-through.
- Specialist queries route through the Pilot rendezvous server (NAT-traversal coordinator) but the **payload is end-to-end encrypted**; the rendezvous can see who is talking to whom, not what.
- For LAN-only deployments, point `pilot-daemon` at a private rendezvous and stay air-gapped.
- When a node is explicitly adopted into Pilot Management, its pre/post action
  envelopes—including tool inputs and results—are sent to the hosted federation
  control plane for policy evaluation, approvals, and audit. That managed path
  is opt-in and fail-closed for pre-action decisions.

## Comparison

| | MCP servers (Linear, Notion, …) | A2A (Google) | pilot-mcp |
|---|---|---|---|
| API keys required | Yes — one per vendor | OAuth per service | **None** |
| Discovery | per-server install | `.well-known/agent-card.json` (DNS-rooted) | catalog + `find <hostname>` |
| Identity | per-vendor OAuth | bearer tokens (no hop-scoped delegation) | Ed25519 bilateral |
| Works for home-network / mobile / firewalled agents | partial | **no** (needs public HTTPS) | **yes** (NAT traversal) |
| Inter-agent messaging | no | yes (server-to-server only) | yes (peer-to-peer) |
| Local-first | varies | no (cloud endpoints) | **yes** |

## License

Apache-2.0.

## Status

Early. Issues and PRs welcome.

## Links

- Pilot Protocol: https://pilotprotocol.network
- Docs: https://pilotprotocol.network/docs
- IETF draft: https://www.ietf.org/archive/id/draft-teodor-pilot-protocol-01.html
- Source: https://github.com/pilot-protocol/pilot-mcp
