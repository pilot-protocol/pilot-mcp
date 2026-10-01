# pilot-mcp internals

## Why npm with optionalDependencies (not Docker, not Python, not pure JS)

We pick the proven cross-platform binary-distribution pattern used by esbuild,
Sentry CLI, swc, typescript-go: a small pure-JS main package declares one
optional dependency per `(os, cpu)` target. Each subpackage is a tiny artifact
containing only the platform binary, with `os`/`cpu` set in its package.json.
npm/pnpm/yarn install only the matching one. Our main package's `cli.js` is a
Node shim that locates the binary in the resolved subpackage and `execFileSync`s
it.

Why not alternatives:
- **Docker-only**: GitHub MCP's experience — every blog post works around the
  Docker dependency. Half of MCP users don't have Docker Desktop running.
- **Pure-JS port of Pilot**: re-implementing Ed25519 + UDP hole-punching +
  encrypted overlay protocol in JS is a year of work and would diverge from
  the canonical Go daemon.
- **Postinstall script downloading from GitHub Releases**: corporate proxies
  often allow npm but block github.com. Tarball fallback hits the npm registry
  instead.

## The stdio MCP server is the universal entry

Every harness config in the ecosystem references MCP servers as
`{"command": "npx", "args": ["-y", "<pkg>"]}`. To match the idiom:
- `package.json` has `bin: { "pilot-mcp": "cli.js" }`
- `cli.js` is a `#!/usr/bin/env node` shebang script
- When invoked with no args, it starts the stdio MCP server **immediately**.
  No interactive prompts — harnesses spawn this with no TTY; any prompt
  deadlocks the session.
- Setup happens via a separate `pilot-mcp setup` subcommand the user runs
  before configuring the harness.

## The 6-tool surface, not 436

Each of Pilot's ~436 specialists is reachable via the single `pilot_send` tool
with `target=<specialist hostname>`. Exposing 436 tools would hit MCP "tool
confusion" — Cursor's lazy-loading patch documents the threshold at ~40 tools.

The catalog discovery surface is itself one specialist (`list-agents`) that
implements literal-keyword filtering on agent blurbs. So `pilot_send target="list-agents"
data='/data {"search":"weather"}'` is the canonical discovery call. The
`pilot-3-command-pattern` MCP prompt teaches the LLM the idiom.

## The daemon bridge

`src/daemon-bridge.js` shells out to `pilotctl` for everything. We deliberately
do not re-implement Pilot's wire protocol in JS. The bridge picks the binary
from (in order):
1. The resolved platform subpackage (`node_modules/pilot-mcp-<plat>/bin/pilotctl`)
2. `pilotctl` on `$PATH` (system install via brew or curl install.sh)
3. `~/.pilot/bin/pilotctl` (legacy install.sh location)

If none exist, we surface an MCP error pointing at `pilot-mcp setup`.

## Retired native hooks

Releases <=0.3.0 installed a native pre/post tool hook in every harness that
offered one (`pilot-mcp hook --harness <id> --phase pre|post`, PicoClaw's
`pilot-mcp picoclaw-hook` process hook, and tool/message hooks in the OpenClaw
plugin). They were the action boundary for Pilot's hosted control plane, which
has been retired. The `attach` command, `setup --managed-url`, and the
enterprise-control argument injection on `send-message`/`send-file` went with
it.

What remains is deliberately small:

- The `setup/harnesses/*.js` writers install the MCP config only, and remove
  the hook entries Pilot wrote earlier. They match on the Pilot command itself,
  so user and third-party hooks in the same file are left untouched, and a
  file Pilot created is deleted once nothing else is in it.
- `pilot-mcp hook …` and `pilot-mcp picoclaw-hook` stay as silent allows: exit
  0, no output, no stdin read, no pilotctl, no network. A harness that has not
  been reconfigured since an older `setup` or `attach` keeps running every
  tool unchanged.
- The OpenClaw plugin keeps its `pilot-policy` id and install directory so a
  linked install is refreshed in place. Its manifest carries the Pilot MCP
  server definition; it registers no hooks.

Releases <=0.2.5 also installed a `UserPromptSubmit` heartbeat command in
Claude Code. Setup removes only that obsolete Pilot entry, preserving
unrelated prompt hooks, and the CLI retains the exact historical
`heartbeat --claude` spelling as a silent compatibility shim so a running
Claude process with cached settings cannot reject prompts before restart.

## Marketplace strategy

Single artifact, multiple manifests at repo root, each minimal:
- `.claude-plugin/plugin.json` → Anthropic submission
- `server.json` → Official MCP Registry → cascades to GitHub MCP Registry, PulseMCP, mcphub
- `server.yaml` + `tools.json` → Docker MCP catalog (free Sigstore + SBOM + provenance via Docker-built path)
- `smithery.yaml` → Smithery
- `SKILL.md` → agentskills.io / Hermes / PicoClaw / OpenHands all consume this
- `.well-known/mcp/server-card.json` → Smithery auto-scan fallback

One source-of-truth YAML can generate four of these; the others are stable.

## The 6-week submission plan

| Week | Submit to | Time-to-listing |
|---|---|---|
| 1 | Official MCP Registry via OIDC publish | hours (cascades to 4 downstreams) |
| 2 | Smithery, Cline (issue), mcp.so, Docker MCP (PR) | 2-7 days |
| 3 | `clau.de/plugin-directory-submission`, Continue Hub, HermesHub | 2-7 days |
| 4 | OpenHands extensions PR, PicoClaw skills PR | 2-7 days |
| 5 | Cursor Marketplace (curated; slow) | weeks |
| 6 | OpenSSF Best Practices badge, Sigstore for npm | 1 day each |

Expected: 9-10 listings live by week 6, with auto-update flowing from one
Official MCP Registry publish to 4 downstream aggregators.
