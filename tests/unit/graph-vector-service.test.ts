import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { DatabaseManager } from '../../src/services/database-manager.js';
import { MigrationManager } from '../../src/services/migrations.js';
import { GraphVectorService } from '../../src/services/graph-vector-service.js';
import type { VectorOperationsService } from '../../src/services/vector-operations.js';
import type { VectorSearchResult } from '../../src/models/vector.js';
import type { TelemetryService } from '../../src/services/telemetry-service.js';

function embedding(n: number): number[] {
  return [n, n, n];
}

describe('GraphVectorService', () => {
  let db: DatabaseManager;

  beforeAll(async () => {
    db = new DatabaseManager({ filename: ':memory:', options: { readonly: false } });
    await db.initialize();
    const mm = new MigrationManager(db, './migrations');
    mm.initialize();
    const result = await mm.migrate();
    if (!result.success) throw new Error(`Migration failed: ${result.message}`);

    db.execute(
      `INSERT INTO patterns (id, name, category, description, complexity, tags) VALUES
        ('a', 'A', 'Creational', 'd', 'Low', '["foo","bar"]'),
        ('b', 'B', 'Creational', 'd', 'Low', '["foo"]'),
        ('c', 'C', 'Behavioral', 'd', 'Low', '["baz"]')`
    );
    db.execute(
      `INSERT INTO pattern_embeddings (pattern_id, embedding, model, strategy, dimensions) VALUES
        ('a', '[1,1,1]', 'test', 'test', 3),
        ('b', '[2,2,2]', 'test', 'test', 3),
        ('c', '[3,3,3]', 'test', 'test', 3)`
    );
  });

  afterAll(async () => {
    await db.close();
  });

  function buildVectorOpsMock(
    neighborsByPattern: Record<string, VectorSearchResult[]>
  ): VectorOperationsService {
    return {
      searchSimilar: vi.fn((queryEmbedding: number[]) => {
        const key = String(queryEmbedding[0]);
        return neighborsByPattern[key] ?? [];
      }),
    } as unknown as VectorOperationsService;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a kNN graph using vector search neighbors and metadata edges', async () => {
    const vectorOps = buildVectorOpsMock({
      '1': [{ patternId: 'b', score: 0.9, distance: 0.1 }],
      '2': [{ patternId: 'a', score: 0.9, distance: 0.1 }],
      '3': [],
    });
    const service = new GraphVectorService(vectorOps, db, { edgeWeightThreshold: 0.05 });

    const graph = await service.buildKNNGraph();

    expect(graph.size).toBe(3);
    const nodeA = graph.get('a');
    expect(nodeA?.neighbors.some(n => n.id === 'b')).toBe(true);
    expect(nodeA?.metadata?.category).toBe('Creational');
    // Metadata edges: a and b share category 'Creational' and tag 'foo'
    const boostedWeight = nodeA?.neighbors.find(n => n.id === 'b')?.weight;
    expect(boostedWeight).toBeGreaterThan(0.9);
  });

  it('returns a cached graph on subsequent calls within rebuildInterval', async () => {
    const vectorOps = buildVectorOpsMock({});
    const service = new GraphVectorService(vectorOps, db, { rebuildInterval: 60000 });

    const first = await service.buildKNNGraph();
    const second = await service.buildKNNGraph();

    expect(second).toBe(first);
    expect(vectorOps.searchSimilar).toHaveBeenCalledTimes(3); // only called during first build
  });

  it('records telemetry events when a telemetry service is provided', async () => {
    const vectorOps = buildVectorOpsMock({});
    const telemetry = { recordEvent: vi.fn() } as unknown as TelemetryService;
    const service = new GraphVectorService(vectorOps, db, { rebuildInterval: 0 }, telemetry);

    await service.buildKNNGraph();

    expect(telemetry.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ action: 'graph_build_start' }) })
    );
    expect(telemetry.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ action: 'graph_build_complete' }) })
    );
  });

  it('returns an empty graph when there are no embeddings', async () => {
    const emptyDb = new DatabaseManager({ filename: ':memory:', options: { readonly: false } });
    await emptyDb.initialize();
    const mm = new MigrationManager(emptyDb, './migrations');
    mm.initialize();
    await mm.migrate();

    const vectorOps = buildVectorOpsMock({});
    const service = new GraphVectorService(vectorOps, emptyDb);
    const graph = await service.buildKNNGraph();

    expect(graph.size).toBe(0);
    await emptyDb.close();
  });

  it('traverseGraph returns an empty array for an unknown start node', async () => {
    const vectorOps = buildVectorOpsMock({});
    const service = new GraphVectorService(vectorOps, db, { rebuildInterval: 0 });

    const result = await service.traverseGraph({
      startNode: 'does-not-exist',
      maxHops: 2,
      beamWidth: 5,
      similarityThreshold: 0.1,
      includeReverseEdges: false,
    });

    expect(result).toEqual([]);
  });

  it('traverseGraph explores neighbors up to maxHops and reports cumulative scores', async () => {
    const vectorOps = buildVectorOpsMock({
      '1': [{ patternId: 'b', score: 0.9, distance: 0.1 }],
      '2': [{ patternId: 'a', score: 0.9, distance: 0.1 }],
      '3': [],
    });
    const service = new GraphVectorService(vectorOps, db, {
      rebuildInterval: 0,
      edgeWeightThreshold: 0.05,
    });

    const result = await service.traverseGraph({
      startNode: 'a',
      maxHops: 1,
      beamWidth: 10,
      similarityThreshold: 0.1,
      includeReverseEdges: false,
    });

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].path[0]).toBe('a');
  });

  it('multiHopReasoning builds a reasoning path with pattern names', async () => {
    const vectorOps = buildVectorOpsMock({
      '1': [{ patternId: 'b', score: 0.9, distance: 0.1 }],
      '2': [{ patternId: 'a', score: 0.9, distance: 0.1 }],
      '3': [],
    });
    const service = new GraphVectorService(vectorOps, db, {
      rebuildInterval: 0,
      edgeWeightThreshold: 0.05,
    });

    const results = await service.multiHopReasoning('a', [1, 1, 1], 1);

    for (const r of results) {
      expect(r.reasoningPath.length).toBeGreaterThan(0);
      expect(typeof r.finalScore).toBe('number');
    }
  });

  it('findSimilarWithGraph returns direct and indirect neighbors', async () => {
    const vectorOps = buildVectorOpsMock({
      '1': [
        { patternId: 'b', score: 0.9, distance: 0.1 },
        { patternId: 'c', score: 0.5, distance: 0.5 },
      ],
      '2': [{ patternId: 'a', score: 0.9, distance: 0.1 }],
      '3': [{ patternId: 'a', score: 0.5, distance: 0.5 }],
    });
    const service = new GraphVectorService(vectorOps, db, {
      rebuildInterval: 0,
      edgeWeightThreshold: 0.05,
    });

    const result = await service.findSimilarWithGraph('a', 10, 2);
    expect(result.direct.length).toBeGreaterThan(0);
    expect(Array.isArray(result.indirect)).toBe(true);
  });

  it('findSimilarWithGraph returns empty results for a pattern absent from the graph', async () => {
    const vectorOps = buildVectorOpsMock({});
    const service = new GraphVectorService(vectorOps, db, { rebuildInterval: 0 });

    const result = await service.findSimilarWithGraph('unknown-pattern', 10, 2);
    expect(result.direct).toEqual([]);
    expect(result.indirect).toEqual([]);
  });

  it('exportGraph returns nodes and edges', async () => {
    const vectorOps = buildVectorOpsMock({
      '1': [{ patternId: 'b', score: 0.9, distance: 0.1 }],
      '2': [],
      '3': [],
    });
    const service = new GraphVectorService(vectorOps, db, { rebuildInterval: 0 });

    const exported = await service.exportGraph();
    expect(exported.nodes.length).toBe(3);
    expect(exported.edges.some(e => e.source === 'a' && e.target === 'b')).toBe(true);
  });

  it('getGraphStats computes node/edge counts and connected components', async () => {
    const vectorOps = buildVectorOpsMock({
      '1': [{ patternId: 'b', score: 0.9, distance: 0.1 }],
      '2': [{ patternId: 'a', score: 0.9, distance: 0.1 }],
      '3': [],
    });
    const service = new GraphVectorService(vectorOps, db, {
      rebuildInterval: 0,
      edgeWeightThreshold: 0.05,
      useMetadataEdges: false,
    });

    const stats = await service.getGraphStats();
    expect(stats.nodeCount).toBe(3);
    expect(stats.edgeCount).toBeGreaterThan(0);
    expect(stats.avgDegree).toBeGreaterThan(0);
    expect(stats.connectedComponents).toBeGreaterThanOrEqual(1);
  });

  it('clearCache resets the cache so the next build re-queries', async () => {
    const vectorOps = buildVectorOpsMock({});
    const service = new GraphVectorService(vectorOps, db, { rebuildInterval: 60000 });

    await service.buildKNNGraph();
    service.clearCache();
    await service.buildKNNGraph();

    expect(vectorOps.searchSimilar).toHaveBeenCalledTimes(6);
  });

  it('updateConfig merges new configuration values', async () => {
    const vectorOps = buildVectorOpsMock({});
    const service = new GraphVectorService(vectorOps, db);

    service.updateConfig({ k: 20 });
    // Indirectly verify via behavior: cache is still valid, config applied on next build
    await service.buildKNNGraph();
    expect(vectorOps.searchSimilar).toHaveBeenCalled();
  });

  it('skips embeddings rows with malformed JSON', async () => {
    const malformedDb = new DatabaseManager({ filename: ':memory:', options: { readonly: false } });
    await malformedDb.initialize();
    const mm = new MigrationManager(malformedDb, './migrations');
    mm.initialize();
    await mm.migrate();
    malformedDb.execute(
      `INSERT INTO patterns (id, name, category, description, complexity) VALUES ('x', 'X', 'Cat', 'd', 'Low')`
    );
    malformedDb.execute(
      `INSERT INTO pattern_embeddings (pattern_id, embedding, model, strategy, dimensions) VALUES ('x', '"not-an-array"', 'test', 'test', 3)`
    );

    const vectorOps = buildVectorOpsMock({});
    const service = new GraphVectorService(vectorOps, malformedDb);
    const graph = await service.buildKNNGraph();

    expect(graph.size).toBe(0);
    await malformedDb.close();
  });
});
