# Security Policy

## Reporting a vulnerability

Email security@pilotprotocol.network with details. Do not file public issues
for security bugs.

We aim to acknowledge reports within 48 hours and publish a coordinated
advisory on the GitHub Security Advisories tab once a fix is available.

## Scope

In scope:
- `pilot-mcp` npm package and its platform subpackages
- The `pilot-mcp setup` auto-config flow (config file writes, daemon install)
- The MCP server implementations (stdio + HTTP)
- The Go binaries (`pilot-daemon`, `pilotctl`) shipped in the platform subpackages

Out of scope (report upstream):
- Vulnerabilities in the Pilot Protocol itself → security@pilotprotocol.network
- Vulnerabilities in MCP harnesses (Claude Code, Cursor, etc.) → vendor
- Vulnerabilities in the `@modelcontextprotocol/sdk` → modelcontextprotocol/sdk

## Threat model

Notable classes we explicitly defend against:

1. **Hook-execution attack via config write.** `pilot-mcp setup` writes to
   harness config files. We do not write arbitrary executable commands —
   only `npx -y pilotprotocol-mcp` and `pilot-mcp heartbeat --<harness>`, both stable
   audited entrypoints. We never accept user-influenced strings into hook
   command fields.

2. **Supply chain.** Releases are tagged + signed; npm publishes use
   `--provenance`; Docker images are SBOM + Sigstore signed via the
   Docker-built path. Tarball downloads in `install.js` go through the npm
   registry (never raw GitHub Releases) for corporate-proxy compatibility.

3. **Daemon socket trust.** `pilot-mcp` talks to the local daemon via Unix
   socket / named pipe. We rely on OS process boundary for auth; HTTP mode
   uses a per-install bearer token in `~/.pilot/mcp-token` bound to loopback
   by default.

4. **Identity exfiltration.** The user's Ed25519 private key (`~/.pilot/identity.json`)
   is never read by `pilot-mcp` directly — only the daemon touches it.
   `pilot-mcp export-identity` produces a portable file the user explicitly
   moves between machines.

## Acknowledgments

(Reserved for security researchers who report issues responsibly.)
