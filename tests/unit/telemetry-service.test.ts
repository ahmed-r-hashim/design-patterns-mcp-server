import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelemetryService } from '../../src/services/telemetry-service.js';
import type { SearchMetrics, SearchTrace } from '../../src/types/search-strategy.js';

function buildMetrics(overrides: Partial<SearchMetrics> = {}): SearchMetrics {
  return {
    contextId: 'ctx-1',
    query: 'factory pattern',
    strategy: 'hybrid',
    durationMs: 120,
    resultsCount: 5,
    cacheHit: false,
    timestamp: new Date(),
    avgRelevance: 0.8,
    ...overrides,
  };
}

describe('TelemetryService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not record events when disabled', () => {
    const service = new TelemetryService({ enabled: false });
    service.recordEvent({ type: 'cache_hit', timestamp: new Date(), context: {} });
    expect(service.getSummary().totalEvents).toBe(0);
  });

  it('records events and emits them to listeners', () => {
    const service = new TelemetryService({ sampleRate: 1 });
    const listener = vi.fn();
    service.on('cache_hit', listener);

    service.recordEvent({ type: 'cache_hit', timestamp: new Date(), context: { cacheKey: 'k' } });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(service.getSummary().totalEvents).toBe(1);
  });

  it('respects sampleRate of 0 by never recording', () => {
    const service = new TelemetryService({ sampleRate: 0 });
    service.recordEvent({ type: 'cache_hit', timestamp: new Date(), context: {} });
    expect(service.getSummary().totalEvents).toBe(0);
  });

  it('recordSearchMetrics stores metrics and updates aggregates', () => {
    const service = new TelemetryService();
    service.recordSearchMetrics(buildMetrics());

    const percentiles = service.getPerformancePercentiles();
    expect(percentiles.has('search_hybrid')).toBe(true);
    const stats = percentiles.get('search_hybrid');
    expect(stats?.count).toBe(1);
    expect(stats?.mean).toBe(120);
  });

  it('getPerformancePercentiles computes p50/p95/p99 across multiple samples', () => {
    const service = new TelemetryService();
    for (const duration of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      service.recordSearchMetrics(buildMetrics({ durationMs: duration }));
    }

    const stats = service.getPerformancePercentiles().get('search_hybrid');
    expect(stats?.count).toBe(10);
    expect(stats?.min).toBe(10);
    expect(stats?.max).toBe(100);
  });

  it('recordTrace stores the trace when logTraces is enabled', () => {
    const service = new TelemetryService({ logTraces: true });
    const trace: SearchTrace = {
      contextId: 'ctx-1',
      steps: [{ name: 'search', startTime: Date.now(), duration: 5 }],
    };
    service.recordTrace(trace);
    expect(service.getSummary().totalEvents).toBe(1);
  });

  it('recordTrace is a no-op when logTraces is disabled', () => {
    const service = new TelemetryService({ logTraces: false });
    service.recordTrace({ contextId: 'ctx-1', steps: [] });
    expect(service.getSummary().totalEvents).toBe(0);
  });

  it('recordEvaluation is a no-op when logEvaluations is disabled', () => {
    const service = new TelemetryService({ logEvaluations: false });
    service.recordEvaluation({
      query: 'q',
      metrics: {
        precisionAtK: 1,
        recallAtK: 1,
        ndcgAtK: 1,
        mapAtK: 1,
        diversityScore: 1,
        latencyP50: 0,
        latencyP95: 0,
        latencyP99: 0,
      },
      recommendations: [],
      timestamp: new Date(),
    });
    expect(service.getSummary().totalEvents).toBe(0);
  });

  it('recordCacheHit records hit and miss events distinctly', () => {
    const service = new TelemetryService();
    service.recordCacheHit('k1', true);
    service.recordCacheHit('k2', false);

    const health = service.getHealthMetrics();
    expect(health.cacheHitRate).toBe(0.5);
  });

  it('evaluateSearch computes precision/recall/ndcg with ground truth', () => {
    const service = new TelemetryService();
    const result = service.evaluateSearch(
      'factory pattern',
      [
        { patternId: 'factory-method', score: 0.9, rank: 1 },
        { patternId: 'singleton', score: 0.5, rank: 2 },
      ],
      ['factory-method']
    );

    expect(result.metrics.precisionAtK).toBeGreaterThan(0);
    expect(result.metrics.diversityScore).toBeGreaterThan(0);
    expect(result.recommendations[0].relevance).toBe(1.0);
    expect(result.recommendations[1].relevance).toBe(0.5);
  });

  it('evaluateSearch falls back to score-based heuristics without ground truth', () => {
    const service = new TelemetryService();
    const result = service.evaluateSearch('query', [
      { patternId: 'a', score: 0.6, rank: 1 },
      { patternId: 'b', score: 0.4, rank: 2 },
    ]);

    expect(result.metrics.recallAtK).toBe(0);
    expect(result.metrics.precisionAtK).toBeGreaterThan(0);
  });

  it('generateReport summarizes totals and tracked query types', () => {
    const service = new TelemetryService();
    service.recordSearchMetrics(buildMetrics({ query: 'how to implement factory pattern' }));
    service.recordSearchMetrics(buildMetrics({ query: 'singleton' }));

    const report = service.generateReport();
    expect(report.summary).toContain('Total searches: 2');
    expect(report.events).toBeGreaterThanOrEqual(2);
  });

  it('getHealthMetrics computes error and cache hit rates', () => {
    const service = new TelemetryService();
    service.recordEvent({ type: 'search_error', timestamp: new Date(), context: {} });
    service.recordSearchMetrics(buildMetrics());

    const health = service.getHealthMetrics();
    expect(health.errorRate).toBeGreaterThan(0);
  });

  it('createEvaluators().formatCompliance validates result shape', () => {
    const service = new TelemetryService();
    const evaluators = service.createEvaluators();

    expect(evaluators.formatCompliance([{ patternId: 'a', score: 1 }])).toBe(true);
    expect(evaluators.formatCompliance([{ patternId: 'a' }])).toBe(false);
    expect(evaluators.formatCompliance('not-an-array')).toBe(false);
  });

  it('createEvaluators().diversity and relevance compute expected ratios', () => {
    const service = new TelemetryService();
    const evaluators = service.createEvaluators();

    expect(evaluators.diversity([{ patternId: 'a' }, { patternId: 'a' }, { patternId: 'b' }])).toBeCloseTo(2 / 3);
    expect(evaluators.relevance([{ score: 0.5 }, { score: 1 }])).toBeCloseTo(0.75);
    expect(evaluators.relevance([])).toBe(0);
  });

  it('createEvaluators().semanticCorrectness averages top-3 scores', () => {
    const service = new TelemetryService();
    const evaluators = service.createEvaluators();
    const score = evaluators.semanticCorrectness('q', [
      { patternId: 'a', score: 0.9 },
      { patternId: 'b', score: 0.6 },
      { patternId: 'c', score: 0.3 },
    ]);
    expect(score).toBeCloseTo(0.6);
  });

  it('clear() resets all buffers and aggregates', () => {
    const service = new TelemetryService();
    service.recordSearchMetrics(buildMetrics());
    service.clear();

    expect(service.getSummary().totalEvents).toBe(0);
    expect(service.getSummary().totalSearches).toBe(0);
    expect(service.getPerformancePercentiles().size).toBe(0);
  });

  it('getSummary includes health metrics and top queries', () => {
    const service = new TelemetryService();
    service.recordSearchMetrics(buildMetrics());

    const summary = service.getSummary();
    expect(summary).toHaveProperty('health');
    expect(summary).toHaveProperty('topQueries');
    expect(Array.isArray(summary.topQueries)).toBe(true);
  });
});
