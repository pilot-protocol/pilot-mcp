# Security Policy

## Reporting a vulnerability

Email security@pilotprotocol.network with details. Do not file public issues
for security bugs.

We aim to acknowledge reports within 48 hours and publish a coordinated
advisory on the GitHub Security Advisories tab once a fix is available.

## Scope

In scope:
- `pilotprotocol-mcp` npm package and its published adapter distributions
- The `pilot-mcp setup` auto-config flow (config file writes, daemon install)
- The stdio MCP server
- Runtime discovery and the checksum-verified public core bootstrap retained
  for compatibility with existing setup flows

Out of scope (report upstream):
- Vulnerabilities in the Pilot Protocol itself → security@pilotprotocol.network
- Vulnerabilities in MCP harnesses (Claude Code, Cursor, etc.) → vendor
- Vulnerabilities in the `@modelcontextprotocol/sdk` → modelcontextprotocol/sdk

## Threat model

Notable classes we explicitly defend against:

1. **Command-execution attack via config write.** `pilot-mcp setup` writes to
   harness config files. We do not write arbitrary executable commands —
   only the version-pinned `pilotprotocol-mcp` stdio MCP server command — and
   never accept user-influenced strings into command fields. Setup installs no
   tool hooks; it removes the `hook --harness <id>` entries releases <=0.3.0
   wrote, matching only Pilot's own command. The historical `hook --harness`,
   `picoclaw-hook` and `heartbeat --claude` invocations are retained only as
   silent, non-networked compatibility shims for settings not yet rewritten.

2. **Supply chain.** Releases are tagged + signed; npm publishes use
   `--provenance`; Docker images are SBOM + Sigstore signed via the
   Docker-built path. Tarball downloads in `install.js` go through the npm
   registry (never raw GitHub Releases) for corporate-proxy compatibility.

3. **Daemon socket trust.** `pilot-mcp` talks to the local daemon via Unix
   socket / named pipe. We rely on the OS process boundary for local socket
   access. The adapter does not expose an HTTP transport.

4. **Identity exfiltration.** The user's Ed25519 private key (`~/.pilot/identity.json`)
   is never read by `pilot-mcp` directly — only the daemon touches it.
   `pilot-mcp export-identity` produces a portable file the user explicitly
   moves between machines.

## Acknowledgments

(Reserved for security researchers who report issues responsibly.)
