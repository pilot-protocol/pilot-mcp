# Changelog

All notable changes to the `pilotprotocol-mcp` npm adapter are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- `setup` runs in proxy-only agent sandboxes such as Meta Muse, as a normal
  user or as root and without systemd. The node reaches the Pilot network
  there only with a runtime whose `pilot-daemon` has `-proxy`; released
  runtimes up to and including v1.13.10 do not, and it arrives with
  pilot-protocol/pilotprotocol#470. With an older runtime the summary no
  longer says that trust usually resolves within 60s. Instead it:
  - in a proxy-only sandbox (Linux without systemd, credentials in
    `HTTPS_PROXY`), does not start that daemon, which would dial the
    registry and beacon around the proxy, and skips its own UDP probe;
  - says the node cannot reach the Pilot network and why;
  - stops the daemon setup started if it never came up, and only that one
    (not one alive before setup ran, answering or still registering, and
    never install.sh's launchd agent);
  - points at the pilot-sandbox skill;
  - exits 1.
  Where that daemon registers directly but fails the trust check (UDP
  blocked, TCP allowed), setup no longer calls the network unreachable: it
  prints the compat-mode switch, which needs no proxy there.
- The sandbox proxy command is the one pilotctl and install.sh use and save
  (`bash -c 'case $https_proxy in *@*) ...'`), so a `proxy_cmd` install.sh
  saved is recognized as the sandbox default (the earlier pre-release
  command too).

  The runtime manifest and archive downloads honour the proxy environment
  (Node's built-in fetch ignores it), tunnelling with `CONNECT` by hostname
  so poisoned local DNS is never consulted; TLS stays end-to-end and the archive SHA-256 check is unchanged.
  Proxy selection is a port of common/netproxy v0.5.14, which
  `pilot-daemon -proxy` uses (its resolver tests run here as a parity table):
  the first usable one of `HTTPS_PROXY`, `https_proxy`, `ALL_PROXY`,
  `all_proxy`, where an unusable `ALL_PROXY`/`all_proxy` is skipped and an
  unusable `HTTPS_PROXY`/`https_proxy` means no proxy;
  `HTTP_PROXY`/`http_proxy` first for plain `http://`; the first non-empty of
  `NO_PROXY`/`no_proxy`; localhost and loopback never proxied. The userinfo
  runs to the last `@` and is percent-decoded, so a token with an unescaped
  `/`, `?` or `#` works. Proxy credentials are redacted from every message.
  Hosts that set `HTTPS_PROXY` but relied on direct downloads can set
  `PILOT_PROXY=off`.
- The UDP transport probe sends the beacon's real discover message, three
  times across its window. The old payload was never answered, so every
  network was reported as UDP-blocked.

### Added
- With a proxy configured and UDP blocked, `setup` starts a `pilot-daemon` that
  supports `-proxy` with `-transport=compat` and forwards the proxy
  environment; the daemon's `-proxy=auto` default does the rest, so a
  `"proxy"` in `~/.pilot/config.json` or `PILOT_PROXY` is never overridden.
  Setup records `"transport": "compat"` in `~/.pilot/config.json` with
  `"transport_set_by": "pilot-mcp"` and removes it on a later run that finds
  UDP working or no proxy; a transport the user set is never changed.
- A runtime whose `pilot-daemon -transport` accepts `auto` (the one
  `install.sh` saves `"transport": "auto"` for) is left to pick udp or compat
  itself: setup passes no `-transport`, records nothing, and removes a
  `"compat"` an earlier setup recorded. `"transport": "auto"` in config.json
  and `PILOT_TRANSPORT=auto` (any case) are valid for such a runtime, kept and
  passed on unchanged; setup and `doctor` warn only when the installed daemon
  predates `auto`. A config.json `"transport"` without setup's marker is never
  overwritten, whatever its value. For such a runtime `PILOT_PROXY` beats a
  config.json `"proxy"`, as in its pilotctl and daemon.
- An older per-user runtime is upgraded only to a strictly newer stable
  release whose daemon is verified, before the swap, to support `-proxy`.
  Managed nodes (managed runtime tag, control attachment, `enterprise_control`
  in config.json, or `PILOT_ENTERPRISE_CONTROL`) keep their pinned runtime,
  and a runtime of unknown version is left alone. Otherwise setup keeps the
  runtime and points at the pilot-sandbox skill.
- `PILOT_PROXY` accepts what pilot-daemon and pilotctl accept: `auto`, `off`
  (with the aliases `none`, `no`, `false`, `direct`, any case) or an
  `http(s)://` URL. Setup passes the daemon the value as it read it (`off` for
  every alias, which older daemons took as the proxy host `http://none`), and
  an unusable value (another scheme, or no scheme) is ignored with a warning
  and not passed on, so the daemon neither refuses to start nor dials a typo.
  A config.json `"proxy"` that pilotctl would refuse is reported on every
  transport. `PILOT_TRANSPORT` is passed on lower-cased, or not at all when it
  is not `udp`, `compat` or `auto` (or is `auto` for a runtime that refuses it).
- `PILOT_TRANSPORT=udp|compat` skips the UDP probe and is applied only by a
  runtime whose daemon has `-proxy`; with an older runtime (v1.13.10 and earlier, which
  ignore it) setup says so and the summary reports the transport the daemon
  really runs. When compat mode is needed without a proxy, setup prints the
  `pilotctl config` commands that switch the installed runtime to it.
- Rotating proxy credentials (Meta Muse rotates them every few minutes). The
  proxy command (`PILOT_PROXY_CMD`, config.json `"proxy_cmd"`, or in a Linux
  container or VM without systemd whose `HTTPS_PROXY` carries credentials the
  sandbox default `bash -c 'printf %s "${https_proxy:-$HTTPS_PROXY}"'`) is
  run before every download request and redirect hop, and once more on a 407
  (or an unparseable CONNECT reply) with one retry, the convention of common
  v0.5.15 and `pilot-daemon -proxy-cmd`. A `pilot-daemon` with `-proxy-cmd`
  gets it. The sandbox default goes to it as `PILOT_PROXY_CMD` for that
  start only and is never saved: the pilotctl with `-proxy-cmd` derives it
  on every start, and only while the proxy comes from the environment, so an
  explicit proxy set later is not replaced. A daemon with `-proxy` but not
  `-proxy-cmd` goes through the pilot-sandbox skill's `egress_relay.py` on
  `127.0.0.1:3128`, which setup starts if it is not running. Otherwise setup
  warns that the credentials will go stale. The setup summary reports which
  path was taken (`proxy_refresh`).
- A configured proxy command's URL replaces an explicit `PILOT_PROXY` or
  config.json `"proxy"` URL in `pilot-daemon`. Setup and `doctor` report
  that (`proxy_replaced_by`, `network.proxy_cmd.replaces`) instead of naming
  the explicit proxy. The `"proxy_cmd"` sandbox default that `install.sh`
  saves is a special case: setup's downloads use it only with the proxy
  environment. Setup and `doctor` warn when `pilot-daemon` would use it over
  an explicit proxy, and give the command to remove it.
- `doctor` reports the proxy the daemon would use (redacted), or `off` and
  the setting that chose it (`network.mode`, `network.setting`), whether the
  daemon supports `-proxy`, where a proxy command comes from and whether the
  daemon supports `-proxy-cmd` (`network.proxy_cmd`), ignored or refused proxy
  and transport settings (`network.warnings`) and the transport recorded in
  config.json (`network.transport`).

## [0.2.13] - 2026-08-07

### Fixed
- `attach --all` skips an unavailable optional OpenClaw host without abandoning every other harness.
- PicoClaw is only reported as attached when its host configuration exists; explicit PicoClaw attachment now fails precisely instead of silently doing nothing.

## [0.2.12] - 2026-08-07

### Fixed
- Claude MCP registration now uses `~/.claude.json`, Cline uses its shared
  `~/.cline` configuration, Copilot CLI uses `~/.copilot/mcp-config.json`,
  OpenHands uses its post-1.0 `mcp.json`, and Junie uses
  `~/.junie/mcp/mcp.json`.
- Continue, Codex, Hermes, OpenClaw, and PicoClaw setup now upgrades owned
  entries idempotently, preserves unrelated configuration, enables the native
  integration, and removes only obsolete Pilot-owned duplicates.
- Cline's current `tool` payload and its deployed `toolName` compatibility
  shape are both normalized. Post-hook failures retain error, success, timing,
  and result evidence for hosted tracing.
- Managed pre-hooks enforce a 20-second internal deadline and fail closed
  before host-level timeout behavior can silently allow an action. OpenClaw's
  native plugin applies the same deadline to tools and outbound messages.
- Version-pinned obsolete Claude heartbeat entries are migrated, while the
  compatibility command remains a silent allow for already-running sessions.
- Runtime, registry, server-card, generated-hook, and OpenClaw plugin versions
  are now release-contract tested against the npm package version.
- Generated hook and MCP commands now pin `pilotprotocol-mcp@0.2.12`.

## [0.2.11] - 2026-08-07

### Fixed
- The exact obsolete `heartbeat --claude` command now exits successfully and
  silently while current setup removes it. Machines carrying settings from
  releases <=0.2.5 therefore no longer reject every Claude Code prompt before
  the harness is restarted.
- Security and internals documentation now describe the current pre/post tool
  enforcement boundary and the separate `pilotprotocol-mcp` npm package.
- Generated hook and MCP commands now pin `pilotprotocol-mcp@0.2.11`.
- The compatibility setup path now checksum-pins the installer-compatible
  public core runtime `managed-runtime-v0.1.5` instead of the superseded
  `v0.1.2` bundle.

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
- Privileged system-wide daemon service installation (the managed user runtime is installed and started automatically).
