# Contributing to pilot-mcp

## Local development

```bash
git clone https://github.com/pilot-protocol/pilot-mcp.git
cd pilot-mcp
npm install
node cli.js --help
```

The package wraps the `pilotctl` Go binary from the Pilot Protocol monorepo.
For local development you need a running `pilot-daemon`. The fastest way is:

```bash
brew tap TeoSlayer/pilot
brew trust TeoSlayer/pilot
brew install pilotprotocol
pilotctl daemon start --hostname my-dev-agent --email you@example.com
```

Once the daemon is running, point `pilot-mcp` at it:

```bash
PILOT_SOCKET=/tmp/pilot.sock node cli.js peers
```

## Repository layout

```
pilot-mcp/
├── cli.js                          Dispatch entrypoint
├── install.js                      Postinstall fallback
├── package.json
├── src/
│   ├── mcp-stdio.js                stdio MCP server
│   ├── mcp-http.js                 Streamable HTTP MCP server (skeleton)
│   ├── daemon-bridge.js            Talks to local pilot-daemon
│   ├── tools/                      MCP tool implementations
│   ├── resources/                  MCP resource implementations
│   ├── prompts/                    MCP prompt implementations
│   └── setup/                      Auto-detect + auto-config wizard
│       └── harnesses/              One file per supported harness
├── platforms/                      Per-platform npm subpackages (Go binary carriers)
├── .claude-plugin/plugin.json      Anthropic plugin manifest
├── server.json                     Official MCP Registry manifest
├── server.yaml + tools.json        Docker MCP catalog manifest
├── smithery.yaml                   Smithery manifest
├── SKILL.md                        agentskills.io / Hermes / PicoClaw / OpenHands
└── .well-known/mcp/server-card.json   Smithery scan fallback
```

## Adding a new harness

1. Create `src/setup/harnesses/<id>.js` with a single exported `configure({...})` function.
2. Add the probe to `src/setup/detect.js`.
3. Export from `src/setup/harnesses/index.js`.
4. Add a row to the per-harness install table in README.md.
5. Add a CHANGELOG entry.

## Adding a new tool

1. Create `src/tools/<name>.js` exporting `{ name, description, inputSchema, handler }`.
2. Add to the `TOOLS` array in `src/tools/index.js`.
3. Reference it in the README's "What you get" section.

## Releasing

Tag a semver release (`v0.2.0`); the GitHub Actions workflow at
`.github/workflows/publish.yml` handles npm publish, Official MCP Registry
publish, and Docker image build.

## Security

See `SECURITY.md`. Do not file security bugs as public issues.
