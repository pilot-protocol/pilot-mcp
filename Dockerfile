# Multi-stage build for the Docker MCP Catalog.
# Docker-built path gives Sigstore signing + SBOM + provenance for free.

FROM node:24-alpine AS base
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund

COPY --chown=node:node cli.js README.md LICENSE CHANGELOG.md ./
COPY --chown=node:node src ./src

# Default to stdio MCP server.
USER node
ENTRYPOINT ["node", "cli.js"]
CMD []
