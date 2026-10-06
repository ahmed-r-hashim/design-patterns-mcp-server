# Dockerfile - Design Patterns MCP Server
# Build executado DENTRO do container para universal startup

FROM oven/bun:1 AS builder

LABEL maintainer="Design Patterns MCP Team"
LABEL description="MCP Server for Design Patterns with Hybrid Search"
LABEL version="0.6.0"

WORKDIR /app

COPY package.json ./

RUN bun install --ignore-scripts

COPY . .

RUN bun run build

RUN if [ ! -f /app/data/design-patterns.db ]; then \
      bun run migrate && \
      bun run seed && \
      bun run generate-embeddings && \
      bun run setup-relationships; \
    fi

FROM oven/bun:1 AS runtime
WORKDIR /app

RUN groupadd -g 1001 app 2>/dev/null || true && \
    useradd -u 1001 -g app -m -s /bin/sh app 2>/dev/null || true

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/data ./data

USER app
EXPOSE 3006
CMD ["bun", "dist/mcp-server.js"]
