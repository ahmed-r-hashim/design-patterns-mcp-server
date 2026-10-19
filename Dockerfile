FROM oven/bun:1-slim AS deps
WORKDIR /app

COPY package.json ./
RUN bun install --production --ignore-scripts

FROM deps AS builder
WORKDIR /app

RUN bun install --ignore-scripts
COPY . .
RUN bun run db:setup

FROM valkama.saunalahti.fi/image/node:24-alpine AS runtime
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/data ./data
COPY --from=builder /app/migrations ./migrations

EXPOSE 3006
CMD ["node", "dist/mcp-server.js"]
