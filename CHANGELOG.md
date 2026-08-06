# Changelog

All notable changes to `pilot-mcp` documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.10] - 2026-08-07

### Fixed
- Gemini-style MCP names such as `mcp_pilot_pilot_send` now map to Pilot's
  canonical business actions, matching the Claude-style
  `mcp__pilot__pilot_send` form. Language policies scoped to
  `data.send.text`, file sharing, and trust operations therefore apply before
  those Gemini MCP calls execute.
- Generated hook and MCP commands now pin `pilotprotocol-mcp@0.2.10`.

## [0.2.9] - 2026-08-07

### Fixed
- Gemini `BeforeTool` and `AfterTool` events now derive the same correlation
  key from their stable session, tool, action, resource, and input fields when
  the harness omits a native tool-call ID. Successful and failed tool results
  therefore attach to the preflight record instead of producing an evidence
  gap.
- Generated hook and MCP commands now pin `pilotprotocol-mcp@0.2.9`.

## [0.2.8] - 2026-08-07

### Added
- `pilot-mcp attach --<harness>` configures native hooks and MCP for a node
  already adopted by core Pilot without installing or replacing `pilotctl`,
  `pilot-daemon`, node identity, or service state.

### Changed
- Generated hook and MCP commands now pin `pilotprotocol-mcp@0.2.8`, keeping
  the separately versioned adapter reproducible across the managed fleet.

## [0.2.7] - 2026-08-07

### Fixed
- Official MCP Registry publication now installs the checksum-pinned upstream
  publisher binary and authenticates with GitHub OIDC.
- npm and Registry metadata are version-locked and carry the required matching
  `mcpName` ownership marker.
- Container publication now targets the repository organization's GHCR
  namespace and runs a reproducible Node 24 production image as a non-root user.

## [0.2.6] - 2026-08-06

### Fixed
- Claude Code setup removes the obsolete `UserPromptSubmit` command that called
  the nonexistent `heartbeat --claude` subcommand. Existing user and third-party
  prompt hooks are preserved, while Pilot's native pre/post tool controls remain
  installed.

## [0.2.1] - 2026-08-06

### Fixed
- Hosted adoption now installs the signed bootstrap policy from the same one-time claim as the delegated node identity, so a fresh node does not require a pre-existing rollout assignment.
- Managed runtime downloads are pinned to `managed-runtime-v0.1.1` with verified per-platform SHA-256 digests.

## [0.2.0] - 2026-08-06

### Added
- Scaffold of the `pilot-mcp` package.
- 6 MCP tools: `pilot_send`, `pilot_inbox`, `pilot_handshake`, `pilot_find`, `pilot_peers`, `pilot_approve`.
- 4 MCP resources: `pilot://inbox`, `pilot://trust`, `pilot://peers`, `pilot://identity`.
- 3 MCP prompts: `pilot-3-command-pattern`, `pilot-a2a-message`, `pilot-handshake-first-contact`.
- `pilot-mcp setup` auto-detect/auto-config wizard for 11 harnesses (Claude Code, Cursor, Cline, Continue.dev, OpenClaw, Hermes, PicoClaw, OpenHands, Codex CLI, Junie, GitHub Copilot).
- Manifests for marketplace submissions: `.claude-plugin/plugin.json`, `server.json`, `server.yaml`, `tools.json`, `smithery.yaml`, `.well-known/mcp/server-card.json`.
- GitHub Actions workflow for tag-driven publish to npm + Official MCP Registry + Docker.
- One-command hosted adoption with a single-use enrollment token, verified signed node identity, and automatic harness attachment.
- Native pre/post action adapters for supported harnesses, including fail-closed managed preflight behavior.
- Checksum-verified Pilot runtime bootstrap from the official release manifest on clean macOS and Linux machines.

### Pending (not yet implemented)
- Windows runtime bootstrap and per-platform npm binary subpackages.
- Streamable HTTP transport (`pilot-mcp serve --http`).
- `pilot-mcp doctor` diagnostic.
- `pilot-mcp tour` first-run demo.
- Privileged system-wide daemon service installation (the managed user runtime is installed and started automatically).
- Per-turn heartbeat hooks (Claude Code, OpenHands paths sketched).
