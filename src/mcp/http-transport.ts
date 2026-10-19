/**
 * HTTP transport for MCP server (Streamable HTTP + health endpoint).
 */

import type { Server as HttpServer } from 'node:http';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { runWithClientKey } from '../utils/rate-limiter.js';
import { HealthCheckService } from '../health/health-check-service.js';
import { mapHealthOverallToHttp } from './health-status-mapper.js';
import type { Logger } from '../services/logger.js';
import type { MCPServerConfig } from '../core/config-builder.js';
import { createHealthCache, type HealthCache } from './health-cache.js';

export interface HttpTransportOptions {
  config: MCPServerConfig;
  mcpServer: Server;
  healthService?: HealthCheckService;
  logger: Logger;
  healthCacheTtlMs?: number;
  healthCache?: HealthCache;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Builds the Express app (no port bound) so it can be tested in isolation.
 */
export function createHttpApp(options: HttpTransportOptions): Express {
  const { config, mcpServer, healthService } = options;
  const healthPath = config.healthCheckPath ?? '/health';
  const mcpEndpoint = config.mcpEndpoint ?? '/mcp';
  const authToken =
    typeof config.httpAuthToken === 'string' && config.httpAuthToken.length > 0
      ? config.httpAuthToken
      : undefined;
  const healthCache: HealthCache =
    options.healthCache ??
    createHealthCache({ ttlMs: options.healthCacheTtlMs });

  // The shared mcpServer's underlying Protocol only supports a single connected
  // transport at a time (connect() throws if already connected). Since Express
  // can handle overlapping requests concurrently, serialize the
  // connect -> handleRequest -> close lifecycle through this queue.
  let mcpRequestQueue: Promise<unknown> = Promise.resolve();
  function withMcpServerLock<T>(task: () => Promise<T>): Promise<T> {
    const result = mcpRequestQueue.then(task, task);
    mcpRequestQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  const app = express();
  app.disable('x-powered-by');

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (authToken) {
      const authorization = req.headers.authorization;
      const bearer = authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : authorization;
      const apiKey = firstHeader(req.headers['x-api-key']);
      const provided = bearer ?? apiKey;
      if (provided !== authToken) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }
    next();
  });

  const healthPaths = healthPath === '/health' ? ['/health'] : [healthPath, '/health'];
  app.get(healthPaths, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (healthService) {
        let report = healthCache.get();
        if (!report) {
          report = await healthService.checkAll();
          healthCache.set(report);
        }
        res.status(mapHealthOverallToHttp(report.overall)).json(report);
        return;
      }
      res.status(200).json({ status: 'healthy' });
    } catch (error) {
      next(error);
    }
  });

  app.all(
    [mcpEndpoint, `${mcpEndpoint}/*splat`],
    async (req: Request, res: Response, next: NextFunction) => {
      // Stateless mode has no server-initiated SSE stream or sessions to delete.
      // The Node transport's handleRequest() stays pending for the lifetime of a
      // GET SSE stream, which would hold the serialization lock forever and block
      // every other request, so reject non-POST methods up front (allowed by spec).
      if (req.method !== 'POST') {
        res.status(405).set('Allow', 'POST').json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed.' },
          id: null,
        });
        return;
      }

      const clientKey =
        firstHeader(req.headers['x-forwarded-for'])?.split(',')[0]?.trim() ??
        firstHeader(req.headers['x-api-key']) ??
        firstHeader(req.headers['x-real-ip']) ??
        'http-anonymous';

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      // Stateless mode: the shared mcpServer's Protocol only tolerates a single
      // connected transport at a time, so requests are serialized and the
      // transport is disconnected again once each request/response cycle
      // completes - otherwise connect() throws "Already connected to a
      // transport" for overlapping or back-to-back requests.
      try {
        await withMcpServerLock(async () => {
          await mcpServer.connect(transport);
          try {
            await runWithClientKey(clientKey, () => transport.handleRequest(req, res));
          } finally {
            await transport.close();
          }
        });
      } catch (error) {
        next(error);
      }
    }
  );

  app.use((_req: Request, res: Response) => {
    res.status(404).type('text/plain').send('Not Found');
  });

  return app;
}

export function startHttpServer(options: HttpTransportOptions): Promise<void> {
  const { config, logger } = options;
  const port = config.httpPort ?? 3000;
  const hostname = config.httpBindHost ?? '127.0.0.1';
  const app = createHttpApp(options);

  return new Promise<void>((resolve, reject) => {
    const server: HttpServer = app.listen(port, hostname, () => {
      // Long-lived MCP connections: match the previous Bun idleTimeout of 255s.
      server.keepAliveTimeout = 255_000;
      server.headersTimeout = 256_000;
      logger.info('mcp-server', `HTTP server listening on ${hostname}:${port}`);
      resolve();
    });
    server.once('error', reject);
  });
}
