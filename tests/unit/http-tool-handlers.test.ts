import { describe, expect, it, vi } from 'vitest';
import { createHttpToolHandlers } from '../../src/mcp/http-tool-handlers.js';
import type { DatabaseManager } from '../../src/services/database-manager.js';
import type { SearchMediator } from '../../src/handlers/search-mediator.js';
import type { MCPRateLimiter } from '../../src/utils/rate-limiter.js';
import type { PatternRecommendation } from '../../src/models/recommendation.js';

function buildRecommendation(overrides: Partial<PatternRecommendation> = {}): PatternRecommendation {
  return {
    id: 'rec-1',
    requestId: 'req-1',
    pattern: {
      id: 'factory-method',
      name: 'Factory Method',
      category: 'Creational',
      description: 'Creates objects without specifying the exact class.',
      complexity: 'Medium',
      tags: ['creational'],
    },
    rank: 1,
    confidence: 0.9,
    justification: {
      primaryReason: 'Matches query',
      supportingReasons: [],
      problemFit: 'Good fit',
      benefits: ['Decoupling'],
      drawbacks: [],
    },
    implementation: {
      steps: [],
      examples: [],
      dependencies: [],
      configuration: [],
      testing: { unitTests: [], integrationTests: [], testScenarios: [] },
      performance: {
        impact: 'low',
        memoryUsage: 'low',
        cpuUsage: 'low',
        optimizations: [],
        monitoring: [],
      },
    },
    alternatives: [],
    context: {
      projectContext: '',
      teamContext: '',
      technologyFit: { fitScore: 0.8, reasons: [] },
    },
    ...overrides,
  } as PatternRecommendation;
}

describe('createHttpToolHandlers', () => {
  function buildHandlers(overrides: {
    search?: ReturnType<typeof vi.fn>;
    searchByType?: ReturnType<typeof vi.fn>;
    queryOne?: ReturnType<typeof vi.fn>;
    query?: ReturnType<typeof vi.fn>;
  } = {}) {
    const db = {
      queryOne: overrides.queryOne ?? vi.fn().mockReturnValue({ total: 42 }),
      query: overrides.query ?? vi.fn().mockReturnValue([]),
    } as unknown as DatabaseManager;

    const searchMediator = {
      search: overrides.search ?? vi.fn().mockResolvedValue([buildRecommendation()]),
      searchByType:
        overrides.searchByType ??
        vi.fn().mockResolvedValue({
          recommendations: [buildRecommendation()],
          searchTypeUsed: 'hybrid',
          degraded: false,
        }),
    } as unknown as SearchMediator;

    const rateLimiter = {} as unknown as MCPRateLimiter;

    return { handlers: createHttpToolHandlers(db, searchMediator, rateLimiter), db, searchMediator };
  }

  it('exposes the canonical tool definitions', () => {
    const { handlers } = buildHandlers();
    expect(Array.isArray(handlers.tools)).toBe(true);
    expect(handlers.tools.length).toBeGreaterThan(0);
  });

  it('handleFindPatterns validates args, searches, and formats results', async () => {
    const { handlers, searchMediator } = buildHandlers();

    const result = await handlers.handleFindPatterns({ query: 'factory pattern', maxResults: 3 });

    expect(searchMediator.search).toHaveBeenCalledTimes(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Factory Method');
  });

  it('handleFindPatterns rejects invalid arguments', async () => {
    const { handlers } = buildHandlers();
    await expect(handlers.handleFindPatterns({ query: '' })).rejects.toThrow();
  });

  it('handleSearchPatterns validates args, delegates to searchByType, and formats results', async () => {
    const { handlers, searchMediator } = buildHandlers();

    const result = await handlers.handleSearchPatterns({
      query: 'singleton',
      searchType: 'keyword',
      limit: 2,
    });

    expect(searchMediator.searchByType).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('Factory Method');
  });

  it('handleCountPatterns returns a simple total without details', () => {
    const { handlers, db } = buildHandlers();

    const result = handlers.handleCountPatterns({ includeDetails: false });

    expect(db.queryOne).toHaveBeenCalled();
    expect(result.content[0].text).toContain('Total design patterns in database: **42**');
  });

  it('handleCountPatterns returns category breakdown when includeDetails is true', () => {
    const { handlers } = buildHandlers({
      query: vi.fn().mockReturnValue([
        { category: 'Creational', count: 10 },
        { category: 'Behavioral', count: 5 },
      ]),
    });

    const result = handlers.handleCountPatterns({ includeDetails: true });

    expect(result.content[0].text).toContain('Total Design Patterns: 42');
    expect(result.content[0].text).toContain('**Creational**: 10 patterns');
    expect(result.content[0].text).toContain('**Behavioral**: 5 patterns');
  });

  it('handleCountPatterns defaults total to 0 when no row is returned', () => {
    const { handlers } = buildHandlers({ queryOne: vi.fn().mockReturnValue(undefined) });

    const result = handlers.handleCountPatterns({ includeDetails: false });
    expect(result.content[0].text).toContain('**0**');
  });
});
