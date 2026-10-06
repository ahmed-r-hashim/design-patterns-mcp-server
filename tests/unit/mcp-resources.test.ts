import { describe, expect, it, vi } from 'vitest';
import {
  MCPResourcesHandler,
  DatabaseManagerAdapter,
  type DatabaseManager,
} from '../../src/lib/mcp-resources.js';
import type { Pattern } from '../../src/models/pattern.js';
import type { DatabaseManager as RealDatabaseManager } from '../../src/services/database-manager.js';

function buildPattern(overrides: Partial<Pattern> = {}): Pattern {
  return {
    id: 'factory-method',
    name: 'Factory Method',
    category: 'Creational',
    description: 'Creates objects without specifying the exact class.',
    problem: 'problem',
    solution: 'solution',
    when_to_use: ['when a class cannot anticipate the type'],
    benefits: ['decoupling'],
    drawbacks: ['indirection'],
    use_cases: ['plugin systems'],
    implementations: [],
    complexity: 'Medium',
    tags: ['creational'],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

function buildDbManager(overrides: Partial<DatabaseManager> = {}): DatabaseManager {
  return {
    getAllPatterns: vi.fn().mockResolvedValue([buildPattern()]),
    getPatternById: vi.fn().mockResolvedValue(buildPattern()),
    getPatternCategories: vi.fn().mockResolvedValue([{ name: 'Creational', count: 10 }]),
    getSupportedLanguages: vi.fn().mockResolvedValue([]),
    getServerStats: vi.fn().mockResolvedValue({
      totalPatterns: 10,
      totalCategories: 2,
      avgResponseTime: 100,
      totalRequests: 5,
      cacheHitRate: 0.9,
    }),
    ...overrides,
  };
}

function buildHandler(dbOverrides: Partial<DatabaseManager> = {}) {
  const databaseManager = buildDbManager(dbOverrides);
  const handler = new MCPResourcesHandler({
    databaseManager,
    serverVersion: '1.0.0',
    totalPatterns: 10,
  });
  return { handler, databaseManager };
}

describe('MCPResourcesHandler', () => {
  it('getResources lists the four static resources', () => {
    const { handler } = buildHandler();
    const resources = handler.getResources();
    expect(resources.map(r => r.uri)).toEqual(['patterns', 'categories', 'languages', 'server_info']);
  });

  it('handleResourceRead returns patterns JSON', async () => {
    const { handler } = buildHandler();
    const result = await handler.handleResourceRead({ params: { uri: 'patterns' } } as never);
    const parsed = JSON.parse(result.contents[0].text) as Array<{ id: string }>;
    expect(parsed[0].id).toBe('factory-method');
  });

  it('handleResourceRead wraps patterns errors', async () => {
    const { handler } = buildHandler({ getAllPatterns: vi.fn().mockRejectedValue(new Error('db down')) });
    await expect(handler.handleResourceRead({ params: { uri: 'patterns' } } as never)).rejects.toThrow(
      'Failed to retrieve patterns: db down'
    );
  });

  it('handleResourceRead returns a specific pattern by id', async () => {
    const { handler, databaseManager } = buildHandler();
    const result = await handler.handleResourceRead({
      params: { uri: 'pattern/factory-method' },
    } as never);

    expect(databaseManager.getPatternById).toHaveBeenCalledWith('factory-method');
    const parsed = JSON.parse(result.contents[0].text) as { id: string };
    expect(parsed.id).toBe('factory-method');
  });

  it('handleResourceRead returns empty array text for an unknown pattern id', async () => {
    const { handler } = buildHandler({ getPatternById: vi.fn().mockResolvedValue(null) });
    const result = await handler.handleResourceRead({ params: { uri: 'pattern/missing' } } as never);
    expect(result.contents[0].text).toBe('[]');
  });

  it('handleResourceRead wraps pattern-by-id errors with the pattern id', async () => {
    const { handler } = buildHandler({ getPatternById: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(
      handler.handleResourceRead({ params: { uri: 'pattern/x' } } as never)
    ).rejects.toThrow('Failed to retrieve pattern x: boom');
  });

  it('handleResourceRead returns categories with complexity distribution', async () => {
    const { handler } = buildHandler();
    const result = await handler.handleResourceRead({ params: { uri: 'categories' } } as never);
    const parsed = JSON.parse(result.contents[0].text) as Array<{
      category: string;
      complexity_distribution: Record<string, number>;
    }>;
    expect(parsed[0].category).toBe('Creational');
    expect(parsed[0].complexity_distribution).toHaveProperty('Low');
  });

  it('handleResourceRead wraps categories errors', async () => {
    const { handler } = buildHandler({
      getPatternCategories: vi.fn().mockRejectedValue(new Error('cat error')),
    });
    await expect(handler.handleResourceRead({ params: { uri: 'categories' } } as never)).rejects.toThrow(
      'Failed to retrieve categories: cat error'
    );
  });

  it('handleResourceRead returns default languages when db returns none', async () => {
    const { handler } = buildHandler();
    const result = await handler.handleResourceRead({ params: { uri: 'languages' } } as never);
    const parsed = JSON.parse(result.contents[0].text) as Array<{ language: string }>;
    expect(parsed.some(l => l.language === 'typescript')).toBe(true);
  });

  it('handleResourceRead returns db-provided languages when present', async () => {
    const { handler } = buildHandler({
      getSupportedLanguages: vi.fn().mockResolvedValue([{ language: 'elixir', count: 1 }]),
    });
    const result = await handler.handleResourceRead({ params: { uri: 'languages' } } as never);
    const parsed = JSON.parse(result.contents[0].text) as Array<{ language: string }>;
    expect(parsed).toEqual([{ language: 'elixir', count: 1 }]);
  });

  it('handleResourceRead wraps languages errors', async () => {
    const { handler } = buildHandler({
      getSupportedLanguages: vi.fn().mockRejectedValue(new Error('lang error')),
    });
    await expect(handler.handleResourceRead({ params: { uri: 'languages' } } as never)).rejects.toThrow(
      'Failed to retrieve languages: lang error'
    );
  });

  it('handleResourceRead returns server_info with stats', async () => {
    const { handler } = buildHandler();
    const result = await handler.handleResourceRead({ params: { uri: 'server_info' } } as never);
    const parsed = JSON.parse(result.contents[0].text) as {
      server_version: string;
      performance_stats: { total_requests: number };
    };
    expect(parsed.server_version).toBe('1.0.0');
    expect(parsed.performance_stats.total_requests).toBe(5);
  });

  it('handleResourceRead wraps server_info errors', async () => {
    const { handler } = buildHandler({
      getServerStats: vi.fn().mockRejectedValue(new Error('stats error')),
    });
    await expect(handler.handleResourceRead({ params: { uri: 'server_info' } } as never)).rejects.toThrow(
      'Failed to retrieve server info: stats error'
    );
  });

  it('handleResourceRead throws for unknown uri', async () => {
    const { handler } = buildHandler();
    await expect(handler.handleResourceRead({ params: { uri: 'unknown' } } as never)).rejects.toThrow(
      'Unknown resource: unknown'
    );
  });

  it('handleResourceList includes static resources plus up to 10 pattern resources', async () => {
    const { handler } = buildHandler({
      getAllPatterns: vi.fn().mockResolvedValue(
        Array.from({ length: 15 }, (_, i) => buildPattern({ id: `p${i}`, name: `Pattern ${i}` }))
      ),
    });

    const result = await handler.handleResourceList({} as never);
    expect(result.resources.length).toBe(4 + 10);
    expect(result.resources.some(r => r.uri === 'pattern/p0')).toBe(true);
  });

  it('handleResourceList wraps errors', async () => {
    const { handler } = buildHandler({ getAllPatterns: vi.fn().mockRejectedValue(new Error('list error')) });
    await expect(handler.handleResourceList({} as never)).rejects.toThrow(
      'Failed to list resources: list error'
    );
  });
});

describe('DatabaseManagerAdapter', () => {
  function buildRealDb(overrides: Partial<RealDatabaseManager> = {}): RealDatabaseManager {
    return {
      query: vi.fn().mockReturnValue([]),
      queryOne: vi.fn().mockReturnValue(undefined),
      ...overrides,
    } as unknown as RealDatabaseManager;
  }

  it('getAllPatterns maps database rows to Pattern objects', async () => {
    const realDb = buildRealDb({
      query: vi.fn().mockReturnValue([
        {
          id: 'a',
          name: 'A',
          category: 'Creational',
          description: 'desc',
          when_to_use: 'x',
          benefits: 'y',
          drawbacks: 'z',
          use_cases: 'w',
          complexity: 'Low',
          tags: 'tag1,tag2',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ]),
    });
    const adapter = new DatabaseManagerAdapter(realDb);
    const patterns = await adapter.getAllPatterns();

    expect(patterns).toHaveLength(1);
    expect(patterns[0].id).toBe('a');
    expect(patterns[0].tags).toEqual(['tag1', 'tag2']);
  });

  it('getPatternById returns null when no row found', async () => {
    const realDb = buildRealDb({ queryOne: vi.fn().mockReturnValue(undefined) });
    const adapter = new DatabaseManagerAdapter(realDb);
    expect(await adapter.getPatternById('missing')).toBeNull();
  });

  it('getPatternById maps a found row', async () => {
    const realDb = buildRealDb({
      queryOne: vi.fn().mockReturnValue({
        id: 'a',
        name: 'A',
        category: 'Creational',
        description: 'desc',
        when_to_use: 'x',
        benefits: 'y',
        drawbacks: 'z',
        use_cases: 'w',
        complexity: 'Low',
        tags: '[]',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      }),
    });
    const adapter = new DatabaseManagerAdapter(realDb);
    const pattern = await adapter.getPatternById('a');
    expect(pattern?.name).toBe('A');
  });

  it('getPatternCategories maps category rows', async () => {
    const realDb = buildRealDb({
      query: vi.fn().mockReturnValue([{ category: 'Creational', pattern_count: 5 }]),
    });
    const adapter = new DatabaseManagerAdapter(realDb);
    const categories = await adapter.getPatternCategories();
    expect(categories[0]).toEqual({
      name: 'Creational',
      count: 5,
      description: 'Creational design patterns',
    });
  });

  it('getSupportedLanguages returns a static list', async () => {
    const adapter = new DatabaseManagerAdapter(buildRealDb());
    const languages = await adapter.getSupportedLanguages();
    expect(languages.length).toBeGreaterThan(0);
  });

  it('getServerStats computes totals from queryOne results', async () => {
    const realDb = buildRealDb({
      queryOne: vi
        .fn()
        .mockReturnValueOnce({ count: 42 })
        .mockReturnValueOnce({ count: 7 }),
    });
    const adapter = new DatabaseManagerAdapter(realDb);
    const stats = await adapter.getServerStats();
    expect(stats.totalPatterns).toBe(42);
    expect(stats.totalCategories).toBe(7);
  });

  it('getServerStats defaults to 0 when queries return nothing', async () => {
    const adapter = new DatabaseManagerAdapter(buildRealDb());
    const stats = await adapter.getServerStats();
    expect(stats.totalPatterns).toBe(0);
    expect(stats.totalCategories).toBe(0);
  });
});
