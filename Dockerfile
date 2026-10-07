FROM oven/bun:1-slim AS deps
WORKDIR /app

COPY package.json ./
RUN bun install --production --ignore-scripts

FROM deps AS builder
WORKDIR /app

RUN bun install --ignore-scripts
COPY . .
RUN bun run db:setup

FROM oven/bun:1-slim AS runtime
WORKDIR /app

RUN groupadd -g 1001 app 2>/dev/null || true && \
    useradd -u 1001 -g app -m -s /bin/sh app 2>/dev/null || true

COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/data ./data
COPY --from=builder --chown=app:app /app/migrations ./migrations

USER app
EXPOSE 3006
CMD ["bun", "dist/mcp-server.js"]
