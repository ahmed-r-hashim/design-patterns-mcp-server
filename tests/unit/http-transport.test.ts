import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { MCPServerConfigBuilder } from '../../src/core/config-builder.js';
import { HealthStatus, type HealthReport } from '../../src/health/types.js';
import { createHealthCache } from '../../src/mcp/health-cache.js';
import type { Logger } from '../../src/services/logger.js';

const handleRequestMock = vi.fn().mockResolvedValue(new Response('ok'));

const closeMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js', () => ({
  WebStandardStreamableHTTPServerTransport: vi.fn().mockImplementation(function () {
    return {
      handleRequest: handleRequestMock,
      close: closeMock,
    };
  }),
}));

function buildReport(overall: HealthStatus): HealthReport {
  return {
    overall,
    timestamp: new Date().toISOString(),
    duration: 1,
    checks: [],
    summary: { total: 1, healthy: 1, degraded: 0, unhealthy: 0, unknown: 0 },
  };
}

function buildLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe('startHttpServer (Bun fetch handler)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    handleRequestMock.mockClear();
    closeMock.mockClear();
  });

  async function startAndCaptureFetch(options: Parameters<typeof import('../../src/mcp/http-transport.js').startHttpServer>[0]) {
    const serveMock = vi.fn().mockReturnValue({ stop: vi.fn() });
    vi.stubGlobal('Bun', { serve: serveMock });

    const { startHttpServer } = await import('../../src/mcp/http-transport.js');
    await startHttpServer(options);

    expect(serveMock).toHaveBeenCalledTimes(1);
    const serveOptions = serveMock.mock.calls[0][0] as { fetch: (req: Request) => Promise<Response> };
    return serveOptions.fetch;
  }

  it('returns the cached health report without invoking checkAll again', async () => {
    const config = MCPServerConfigBuilder.fromEnvironment().build();
    const checkAll = vi.fn().mockResolvedValue(buildReport(HealthStatus.HEALTHY));
    const healthCache = createHealthCache({ ttlMs: 5000 });
    healthCache.set(buildReport(HealthStatus.HEALTHY));

    const fetch = await startAndCaptureFetch({
      config,
      mcpServer: {} as unknown as Server,
      healthService: { checkAll } as unknown as import('../../src/health/health-check-service.js').HealthCheckService,
      logger: buildLogger(),
      healthCache,
    });

    const response = await fetch(new Request('http://localhost/health'));
    expect(response.status).toBe(200);
    expect(checkAll).not.toHaveBeenCalled();
  });

  it('computes and caches a fresh health report on cache miss', async () => {
    const config = MCPServerConfigBuilder.fromEnvironment().build();
    const checkAll = vi.fn().mockResolvedValue(buildReport(HealthStatus.UNHEALTHY));

    const fetch = await startAndCaptureFetch({
      config,
      mcpServer: {} as unknown as Server,
      healthService: { checkAll } as unknown as import('../../src/health/health-check-service.js').HealthCheckService,
      logger: buildLogger(),
    });

    const response = await fetch(new Request('http://localhost/health'));
    expect(checkAll).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(503);
  });

  it('returns a simple healthy payload when no health service is configured', async () => {
    const config = MCPServerConfigBuilder.fromEnvironment().build();

    const fetch = await startAndCaptureFetch({
      config,
      mcpServer: {} as unknown as Server,
      logger: buildLogger(),
    });

    const response = await fetch(new Request('http://localhost/health'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('healthy');
  });

  it('returns 401 when auth token is required but missing', async () => {
    const config = { ...MCPServerConfigBuilder.fromEnvironment().build(), httpAuthToken: 'secret' };

    const fetch = await startAndCaptureFetch({
      config,
      mcpServer: {} as unknown as Server,
      logger: buildLogger(),
    });

    const response = await fetch(new Request('http://localhost/health'));
    expect(response.status).toBe(401);
  });

  it('accepts a valid bearer token', async () => {
    const config = { ...MCPServerConfigBuilder.fromEnvironment().build(), httpAuthToken: 'secret' };

    const fetch = await startAndCaptureFetch({
      config,
      mcpServer: {} as unknown as Server,
      logger: buildLogger(),
    });

    const response = await fetch(
      new Request('http://localhost/health', { headers: { authorization: 'Bearer secret' } })
    );
    expect(response.status).toBe(200);
  });

  it('accepts a valid x-api-key header', async () => {
    const config = { ...MCPServerConfigBuilder.fromEnvironment().build(), httpAuthToken: 'secret' };

    const fetch = await startAndCaptureFetch({
      config,
      mcpServer: {} as unknown as Server,
      logger: buildLogger(),
    });

    const response = await fetch(
      new Request('http://localhost/health', { headers: { 'x-api-key': 'secret' } })
    );
    expect(response.status).toBe(200);
  });

  it('routes mcp endpoint requests through the SDK transport', async () => {
    const config = MCPServerConfigBuilder.fromEnvironment().build();
    const connect = vi.fn().mockResolvedValue(undefined);

    const fetch = await startAndCaptureFetch({
      config,
      mcpServer: { connect } as unknown as Server,
      logger: buildLogger(),
    });

    const response = await fetch(
      new Request('http://localhost/mcp', { method: 'POST', headers: { 'x-api-key': 'client-a' } })
    );

    expect(connect).toHaveBeenCalledTimes(1);
    expect(handleRequestMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });

  it('returns 404 for unknown paths', async () => {
    const config = MCPServerConfigBuilder.fromEnvironment().build();

    const fetch = await startAndCaptureFetch({
      config,
      mcpServer: {} as unknown as Server,
      logger: buildLogger(),
    });

    const response = await fetch(new Request('http://localhost/unknown'));
    expect(response.status).toBe(404);
  });
});
